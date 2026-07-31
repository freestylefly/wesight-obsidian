vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { parseModelIds, resolveProviderModels } from '../src/utils/providerModels';

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

  test('rethrows the original error when there is nothing to fall back to', async () => {
    await expect(resolveProviderModels({
      primary,
      fetcher: async () => {
        throw new Error('status 401 unauthorized');
      },
    })).rejects.toThrow('status 401 unauthorized');
  });
});
