import {
  buildProviderAuthHeaders,
  inferAnthropicAuthMode,
  requiresProviderApiKey,
} from '../src/utils/providerAuth';

describe('provider authentication', () => {
  test('infers API key only for the official Anthropic host', () => {
    expect(inferAnthropicAuthMode('claude', 'Claude', 'https://api.anthropic.com')).toBe('apiKey');
    expect(inferAnthropicAuthMode('claude', 'Moonshot', 'https://api.moonshot.cn/anthropic')).toBe('authToken');
  });

  test('builds exactly one Anthropic authentication header', () => {
    expect(buildProviderAuthHeaders({
      agentId: 'claude',
      apiKey: 'k',
      anthropicAuthMode: 'authToken',
    })).toEqual({
      Authorization: 'Bearer k',
      'anthropic-version': '2023-06-01',
    });
    expect(buildProviderAuthHeaders({
      agentId: 'claude',
      apiKey: 'k',
      anthropicAuthMode: 'apiKey',
    })).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
  });

  test('allows keyless loopback providers only', () => {
    expect(requiresProviderApiKey('http://127.0.0.1:8080')).toBe(false);
    expect(requiresProviderApiKey('https://api.moonshot.cn/anthropic')).toBe(true);
    expect(buildProviderAuthHeaders({
      agentId: 'codex',
      apiKey: '',
    })).toEqual({});
  });
});
