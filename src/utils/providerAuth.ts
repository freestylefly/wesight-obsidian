import type { AgentId, AnthropicAuthMode, ProviderProfile } from '../types';

export function inferAnthropicAuthMode(
  agentId: AgentId,
  name: string,
  baseUrl: string,
  explicit?: AnthropicAuthMode,
): AnthropicAuthMode | undefined {
  if (agentId !== 'claude') return undefined;
  if (explicit === 'apiKey' || explicit === 'authToken') return explicit;

  try {
    if (new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com') {
      return 'apiKey';
    }
  } catch {
    if (name.trim().toLowerCase() === 'anthropic' || name.trim().toLowerCase() === 'claude') {
      return 'apiKey';
    }
  }
  return 'authToken';
}

export function resolveAnthropicAuthMode(profile: ProviderProfile): AnthropicAuthMode {
  return inferAnthropicAuthMode(
    profile.agentId,
    profile.name,
    profile.baseUrl,
    profile.anthropicAuthMode,
  ) ?? 'authToken';
}

export function buildProviderAuthHeaders(options: {
  agentId: AgentId;
  apiKey: string;
  anthropicAuthMode?: AnthropicAuthMode;
}): Record<string, string> {
  if (options.agentId !== 'claude') {
    return options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (!options.apiKey) {
    return headers;
  }
  if (options.anthropicAuthMode === 'apiKey') {
    headers['x-api-key'] = options.apiKey;
  } else {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  return headers;
}

export function requiresProviderApiKey(baseUrl: string): boolean {
  const value = baseUrl.trim();
  if (!value) return true;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
  } catch {
    return true;
  }
}

export function providerHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}
