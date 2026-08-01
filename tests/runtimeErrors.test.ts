import {
  classifyClaudeProviderError,
  extractClaudeConnectorWarning,
  stripClaudeConnectorWarning,
} from '../src/runtime/errors';

describe('Claude provider errors', () => {
  test('classifies invalid-token cooldowns with request metadata', () => {
    const event = classifyClaudeProviderError([
      'API Error: Request rejected (429)·您多次使用无效令牌，请等待 120 秒后再试',
      '(request id: 20260801014945799516185Zk2D65A2)',
    ].join('\n'), { providerName: 'Moonshot', providerProfileId: 'profile-1' });
    expect(event).toMatchObject({
      type: 'error',
      statusCode: 429,
      retryAfterSeconds: 120,
      requestId: '20260801014945799516185Zk2D65A2',
      providerProfileId: 'profile-1',
    });
    expect(event?.message).toContain('API 密钥无效');
    expect(event?.message).toContain('请求 ID：20260801014945799516185Zk2D65A2');
    expect(event?.detail).toBeUndefined();
  });

  test('removes the expected Claude connectors warning', () => {
    const value = [
      '△ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization\'s connectors',
      'actual failure',
    ].join('\n');
    expect(stripClaudeConnectorWarning(value)).toBe('actual failure');
    expect(extractClaudeConnectorWarning(value)).toContain('claude.ai connectors are disabled');
  });

  test.each([401, 403])('classifies %s authentication failures', statusCode => {
    const event = classifyClaudeProviderError(`API Error: authentication failed (status ${statusCode})`, {
      providerName: 'Moonshot',
    });
    expect(event?.type).toBe('error');
    expect(event?.statusCode).toBe(statusCode);
    expect(event?.message).toContain('API 密钥无效');
  });

  test('classifies an ordinary 429 without treating it as an invalid key', () => {
    const event = classifyClaudeProviderError('API Error: rate limit exceeded (429)', {
      providerName: 'Moonshot',
    });
    expect(event).toMatchObject({
      type: 'error',
      statusCode: 429,
      message: 'Moonshot 请求受限，请稍后再试。',
    });
  });
});
