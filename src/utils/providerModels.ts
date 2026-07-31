import { requestUrl } from 'obsidian';

import type { AgentId } from '../types';

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

function buildHeaders(apiKey: string, agentId: AgentId): Record<string, string> {
  if (agentId === 'claude') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

export type ProviderModelSource = 'primary' | 'fallback' | 'preset';

export interface ResolveProviderModelsOptions {
  primary: { agentId: AgentId; baseUrl: string; apiKey: string };
  /**
   * A second endpoint to try when the primary one has no model-list route.
   * Anthropic-compatible gateways (a provider's `/anthropic` endpoint) usually
   * omit `GET /models`, but the same provider's OpenAI-compatible endpoint has
   * it, so we can still discover the model ids from there.
   */
  fallback?: { agentId: AgentId; baseUrl: string; apiKey: string };
  /** Built-in model ids to use when neither endpoint returns a list. */
  presetModelIds?: string[];
  /** Injectable for testing; defaults to {@link fetchProviderModels}. */
  fetcher?: (options: { agentId: AgentId; baseUrl: string; apiKey: string }) => Promise<string[]>;
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
    } catch {
      // Ignore and fall through to the preset list.
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

/**
 * Fetches the models a provider endpoint supports. Doubles as a connection
 * test: a thrown error means the base URL or API key is wrong.
 */
export async function fetchProviderModels(options: {
  agentId: AgentId;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const { agentId, baseUrl, apiKey } = options;
  if (!baseUrl.trim()) {
    throw new Error('Base URL is required to fetch models.');
  }
  let lastError: Error | null = null;
  for (const url of candidateUrls(baseUrl, agentId)) {
    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: buildHeaders(apiKey, agentId),
        throw: true,
      });
      const models = parseModelIds(response.json);
      if (models.length > 0) {
        return models;
      }
      lastError = new Error(`No models returned by ${url}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('Could not fetch models from the provider.');
}
