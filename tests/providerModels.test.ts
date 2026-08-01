vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import { parseModelIds, resolveProviderModels, testProviderConnection } from '../src/utils/providerModels';

afterEach(() => {
  vi.clearAllMocks();
});

describe('parseModelIds', () => {
  test('reads OpenAI/Anthropic { data: [{ id }] } shape', () => {
    expect(parseModelIds({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] }))
      .toEqual(['gpt-5.4', 'gpt-5.4-mini']);
  });

  test('reads a plain string array and removes empties', () => {
    expect(parseModelIds(['gpt-5.4', '', 'gpt-5.4-mini', 'gpt-5.4']))
      .toEqual(['gpt-5.4', 'gpt-5.4-mini']);
  });

  test('reads { model } entries as a fallback', () => {
    expect(parseModelIds([{ model: 'glm-5' }, { model: 'glm-5-flash' }]))
      .toEqual(['glm-5', 'glm-5-flash']);
  });
});

describe('resolveProviderModels', () => {
  const primary = { agentId: 'claude' as const, baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k' };
  const fallback = { agentId: 'codex' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'k' };

  test('returns primary models when the primary endpoint responds', async () => {
    const result = await resolveProviderModels({
      primary,
      presetModelIds: ['preset-only'],
      fetcher: async () => ['deepseek-v4-pro'],
    });
    expect(result).toEqual({ models: ['deepseek-v4-pro'], source: 'primary' });
  });

  test('falls back to the compatible endpoint when the primary 404s', async () => {
    const result = await resolveProviderModels({
      primary,
      fallback,
      presetModelIds: ['preset-only'],
      fetcher: async ({ baseUrl }) => {
        if (baseUrl === primary.baseUrl) throw new Error('request url failed, status 404');
        return ['deepseek-v4-flash'];
      },
    });
    expect(result).toEqual({ models: ['deepseek-v4-flash'], source: 'fallback' });
  });

  test('falls back to preset models when no endpoint returns a list', async () => {
    const result = await resolveProviderModels({
      primary,
      fallback,
      presetModelIds: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      fetcher: async () => {
        throw new Error('status 404');
      },
    });
    expect(result).toEqual({ models: ['deepseek-v4-pro', 'deepseek-v4-flash'], source: 'preset' });
  });

  test('treats an empty primary response as a miss and uses presets', async () => {
    const result = await resolveProviderModels({
      primary,
      presetModelIds: ['deepseek-v4-pro'],
      fetcher: async () => [],
    });
    expect(result).toEqual({ models: ['deepseek-v4-pro'], source: 'preset' });
  });

  test('surfaces authentication errors without falling back to presets', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('status 401 unauthorized');
    });
    await expect(resolveProviderModels({
      primary,
      fallback,
      presetModelIds: ['preset-only'],
      fetcher,
    })).rejects.toThrow('API 鉴权失败（401）');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('reads authentication status from structured request errors', async () => {
    const structuredError = Object.assign(new Error('forbidden'), { status: 403 });
    await expect(resolveProviderModels({
      primary,
      presetModelIds: ['preset-only'],
      fetcher: async () => {
        throw structuredError;
      },
    })).rejects.toThrow('API 鉴权失败（403）');
  });

  test('surfaces rate limits without retrying alternate model-list routes', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('request rejected (429)');
    });
    await expect(resolveProviderModels({
      primary,
      fallback,
      presetModelIds: ['preset-only'],
      fetcher,
    })).rejects.toThrow('请求受限（429）');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('keeps rate-limit cooldown and request metadata in connection errors', async () => {
    vi.mocked(requestUrl).mockRejectedValue(new Error(
      'request rejected (429), wait 120 seconds, request id: request-123',
    ));
    await expect(testProviderConnection({
      agentId: 'claude',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiKey: 'sk-moonshot',
      anthropicAuthMode: 'authToken',
      model: 'kimi-k3',
    })).rejects.toThrow('等待 120 秒');
    await expect(testProviderConnection({
      agentId: 'claude',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiKey: 'sk-moonshot',
      anthropicAuthMode: 'authToken',
      model: 'kimi-k3',
    })).rejects.toThrow('请求 ID：request-123');
  });
});

describe('testProviderConnection', () => {
  test('uses bearer auth for Moonshot Anthropic-compatible requests', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ json: {} } as never);
    await testProviderConnection({
      agentId: 'claude',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiKey: 'sk-moonshot',
      anthropicAuthMode: 'authToken',
      model: 'kimi-k3',
    });
    const request: unknown = vi.mocked(requestUrl).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: 'https://api.moonshot.cn/anthropic/v1/messages',
      headers: { Authorization: 'Bearer sk-moonshot' },
    });
    const headers = request && typeof request === 'object'
      ? (request as { headers?: Record<string, string> }).headers
      : {};
    expect(headers).not.toHaveProperty('x-api-key');
  });

  test('uses x-api-key for official Anthropic requests', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ json: {} } as never);
    await testProviderConnection({
      agentId: 'claude',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-anthropic',
      anthropicAuthMode: 'apiKey',
      model: 'claude-sonnet-4-6',
    });
    const request: unknown = vi.mocked(requestUrl).mock.calls[0]?.[0];
    expect(request).toMatchObject({ headers: { 'x-api-key': 'sk-anthropic' } });
    const headers = request && typeof request === 'object'
      ? (request as { headers?: Record<string, string> }).headers
      : {};
    expect(headers).not.toHaveProperty('Authorization');
  });

  test('keeps an existing OpenAI-compatible version path', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ json: {} } as never);
    await testProviderConnection({
      agentId: 'codex',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'google-key',
      model: 'gemini-3.5-flash',
      wireApi: 'chat',
    });
    expect(vi.mocked(requestUrl).mock.calls[0]?.[0]).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    });
  });
});
