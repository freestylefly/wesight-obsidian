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
