import { requestUrl } from 'obsidian';

import type { AgentId, AnthropicAuthMode, ProviderWireApi } from '../types';
import { buildProviderAuthHeaders, requiresProviderApiKey } from './providerAuth';

export interface ProviderRequestOptions {
  agentId: AgentId;
  baseUrl: string;
  apiKey: string;
  anthropicAuthMode?: AnthropicAuthMode;
}

class ModelListUnavailableError extends Error {}

/**
 * Extracts model ids from a provider's list-models response. Handles the
 * OpenAI/Anthropic shape ({ data: [{ id }] }), Ollama ({ models: [{ name }] }),
 * and plain string arrays.
 */
export function parseModelIds(payload: unknown): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      ids.push(value.trim());
    }
  };
  const fromEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      push(entry);
      return;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      push(record.id ?? record.name ?? record.model);
    }
  };
  if (Array.isArray(payload)) {
    payload.forEach(fromEntry);
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const list = record.data ?? record.models;
    if (Array.isArray(list)) {
      list.forEach(fromEntry);
    }
  }
  return [...new Set(ids)];
}

function candidateUrls(baseUrl: string, agentId: AgentId): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const withV1 = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const bare = `${base}/models`;
  // Anthropic-style bases usually exclude /v1; OpenAI-compatible bases usually include it.
  return agentId === 'claude' ? [...new Set([withV1, bare])] : [...new Set([bare, withV1])];
}

export type ProviderModelSource = 'primary' | 'fallback' | 'preset';

export interface ResolveProviderModelsOptions {
  primary: ProviderRequestOptions;
  /**
   * A second endpoint to try when the primary one has no model-list route.
   * Anthropic-compatible gateways (a provider's `/anthropic` endpoint) usually
   * omit `GET /models`, but the same provider's OpenAI-compatible endpoint has
   * it, so we can still discover the model ids from there.
   */
  fallback?: ProviderRequestOptions;
  /** Built-in model ids to use when neither endpoint returns a list. */
  presetModelIds?: string[];
  /** Injectable for testing; defaults to {@link fetchProviderModels}. */
  fetcher?: (options: ProviderRequestOptions) => Promise<string[]>;
}

/**
 * Resolves a provider's model ids without hard-failing when the configured
 * endpoint does not expose a model list. Tries the primary endpoint, then an
 * optional compatible endpoint, and finally the built-in preset list, so the
 * settings UI can always offer models the user can select or extend manually.
 */
export async function resolveProviderModels(
  options: ResolveProviderModelsOptions,
): Promise<{ models: string[]; source: ProviderModelSource }> {
  const fetcher = options.fetcher ?? fetchProviderModels;
  try {
    const models = await fetcher(options.primary);
    if (models.length > 0) {
      return { models, source: 'primary' };
    }
  } catch (primaryError) {
    if (!isModelListUnavailable(primaryError)) throw normalizeProviderError(primaryError);
    return resolveProviderModelsFallback(options, fetcher, primaryError);
  }
  return resolveProviderModelsFallback(options, fetcher, null);
}

async function resolveProviderModelsFallback(
  options: ResolveProviderModelsOptions,
  fetcher: NonNullable<ResolveProviderModelsOptions['fetcher']>,
  primaryError: unknown,
): Promise<{ models: string[]; source: ProviderModelSource }> {
  if (options.fallback?.baseUrl.trim()) {
    try {
      const models = await fetcher(options.fallback);
      if (models.length > 0) {
        return { models, source: 'fallback' };
      }
    } catch (fallbackError) {
      if (!isModelListUnavailable(fallbackError)) throw normalizeProviderError(fallbackError);
    }
  }
  const preset = [...new Set((options.presetModelIds ?? []).filter(id => id.trim()))];
  if (preset.length > 0) {
    return { models: preset, source: 'preset' };
  }
  throw primaryError instanceof Error
    ? primaryError
    : new Error('Could not fetch models from the provider.');
}

/** Fetches model ids from provider model-list routes only. */
export async function fetchProviderModels(options: ProviderRequestOptions): Promise<string[]> {
  const { agentId, baseUrl, apiKey, anthropicAuthMode } = options;
  if (!baseUrl.trim()) {
    throw new Error('Base URL is required to fetch models.');
  }
  let lastError: Error | null = null;
  for (const url of candidateUrls(baseUrl, agentId)) {
    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: buildProviderAuthHeaders({ agentId, apiKey, anthropicAuthMode }),
        throw: true,
      });
      const models = parseModelIds(response.json);
      if (models.length > 0) {
        return models;
      }
      lastError = new ModelListUnavailableError(`No models returned by ${url}.`);
    } catch (error) {
      const normalized = normalizeProviderError(error);
      if (!isRouteUnavailable(normalized)) throw normalized;
      lastError = normalized;
    }
  }
  throw lastError ?? new Error('Could not fetch models from the provider.');
}

export async function testProviderConnection(options: ProviderRequestOptions & {
  model: string;
  wireApi?: ProviderWireApi;
}): Promise<void> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const model = options.model.trim();
  if (!baseUrl) throw new Error('API Base URL 不能为空。');
  if (requiresProviderApiKey(baseUrl) && !options.apiKey.trim()) throw new Error('API Key 不能为空。');
  if (!model) throw new Error('请先选择一个模型。');

  const anthropic = options.agentId === 'claude';
  const responses = !anthropic && options.wireApi === 'responses';
  const suffix = anthropic ? 'messages' : responses ? 'responses' : 'chat/completions';
  const url = baseUrl.endsWith('/v1') || !anthropic
    ? `${baseUrl}/${suffix}`
    : `${baseUrl}/v1/${suffix}`;
  const body = anthropic
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }
    : responses
      ? { model, max_output_tokens: 1, input: 'Reply with OK.' }
      : { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] };

  try {
    await requestUrl({
      url,
      method: 'POST',
      headers: {
        ...buildProviderAuthHeaders(options),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      throw: true,
    });
  } catch (error) {
    throw normalizeProviderError(error);
  }
}

function isModelListUnavailable(error: unknown): boolean {
  return error instanceof ModelListUnavailableError || isRouteUnavailable(error);
}

function isRouteUnavailable(error: unknown): boolean {
  const status = providerErrorStatus(error);
  return status === 404 || status === 405;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const record = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const direct = Number(record.status ?? record.statusCode ?? record.response?.status);
    if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:status|状态码)[^\d]{0,12}(\d{3})|\((\d{3})\)/i);
  return Number(match?.[1] ?? match?.[2]) || undefined;
}

function normalizeProviderError(error: unknown): Error {
  const status = providerErrorStatus(error);
  const original = error instanceof Error ? error : new Error(String(error));
  if (status === 401 || status === 403) {
    return new Error(`API 鉴权失败（${status}），请检查密钥和鉴权方式。`);
  }
  if (status === 429) {
    const retryAfterSeconds = Number(original.message.match(/(?:等待|wait(?: for)?|retry(?:-| )after)\s*(\d+)\s*(?:秒|seconds?|s\b)/i)?.[1]) || undefined;
    const requestId = original.message.match(/request\s*id\s*[:：]\s*([A-Za-z0-9_-]+)/i)?.[1];
    return new Error([
      retryAfterSeconds
        ? `请求受限（429），请等待 ${retryAfterSeconds} 秒后再试。`
        : '请求受限（429），请等待服务商提示的冷却时间后再试。',
      requestId ? `请求 ID：${requestId}。` : '',
    ].filter(Boolean).join(' '));
  }
  return original;
}
