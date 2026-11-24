import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { MemberAiService, memberGatewayUrl } from '../src/memberAi/service';
import { memberAiConfigSources } from '../src/memberAi/settings';
import { managedProjection } from '../src/memberAi/projection';
import { MemberRequestIdentity } from '../src/memberAi/requestIdentity';
import { DEFAULT_SETTINGS } from '../src/types';
import type { MemberAiStatus } from '../src/memberAi/types';
import type { CloudAuthService } from '../src/share/cloudAuth';
import type { tokenDanceRequest } from '../src/tokendance/transport';

const ready: MemberAiStatus = {
  state: 'ready',
  membership: { active: true, expiresAt: null },
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash' }],
  defaultModel: 'deepseek-v4.1-flash',
  quota: { remainingPercent: 100, resetsAt: null },
  gatewayUrl: 'https://ai-gateway.canghecode.com',
};
const services: MemberAiService[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
});
function reply(value: unknown, status = 200): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(value))]) as IncomingMessage;
  stream.statusCode = status;
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}
function setup(status = ready) {
  let user = { userId: 'test-user' } as ReturnType<CloudAuthService['getCurrentUser']>;
  let change = () => {};
  const confirmDisclosure = vi.fn(async () => true);
  const auth = {
    getCurrentUser: () => user,
    getAccessToken: vi.fn(async () => 'private-wesight-login'),
    refreshAccessToken: vi.fn(async () => 'refreshed'),
    onChange: (fn: () => void) => {
      change = fn;
      return () => {};
    },
  };
  const request = vi.fn<typeof tokenDanceRequest>(async (url) =>
    reply(url.endsWith('/status') ? { code: 0, data: status } : { content: [{ type: 'text', text: 'ok' }] }),
  );
  const service = new MemberAiService({ auth, confirmDisclosure, request });
  services.push(service);
  return {
    service,
    request,
    auth,
    confirmDisclosure,
    logout: () => {
      user = null;
      change();
    },
    change,
  };
}
describe('member configuration migration', () => {
  it('uses the same request identity for SDK retries, but new user sends get new IDs', () => {
    const ids = new MemberRequestIdentity();
    const body = Buffer.from('private-prompt');
    const first = ids.resolve(body, {}, 1);
    expect(ids.resolve(body, { 'x-stainless-retry-count': '1' }, 2)).toBe(first);
    expect(ids.resolve(body, {}, 3)).not.toBe(first);
    expect(() => ids.resolve(Buffer.from('unknown'), { 'x-stainless-retry-count': '1' }, 4)).toThrow();
    ids.clear();
    expect(() => ids.resolve(body, { 'x-stainless-retry-count': '1' }, 5)).toThrow();
  });
  it('defaults new installs only, preserves existing local/custom choices', () => {
    expect(memberAiConfigSources(null).claude).toBe('wesightManaged');
    expect(memberAiConfigSources({}).claude).toBe('wesightManaged');
    expect(memberAiConfigSources({ defaultAgentId: 'opencode' }).claude).toBe('localCli');
    expect(
      memberAiConfigSources({
        configSources: { claude: 'providerProfile', codex: 'localCli', opencode: 'providerProfile', antigravity: 'localCli' },
      }),
    ).toEqual({ claude: 'providerProfile', codex: 'localCli', opencode: 'providerProfile', antigravity: 'localCli' });
    expect(DEFAULT_SETTINGS.defaultAgentId).toBe('claude');
  });
  it('accepts only the exact TLS gateway origin', () => {
    expect(memberGatewayUrl(ready.gatewayUrl)).toBe(ready.gatewayUrl);
    for (const value of [
      'http://ai-gateway.canghecode.com',
      'https://evil.example',
      'https://ai-gateway.canghecode.com.evil.example',
      'https://key@ai-gateway.canghecode.com',
      'https://ai-gateway.canghecode.com/v1',
      'https://ai-gateway.canghecode.com?key=x',
      'https://ai-gateway.canghecode.com:444',
    ]) {
      expect(() => memberGatewayUrl(value)).toThrow();
    }
  });
});
describe('member loopback gateway', () => {
  it('uses only an ephemeral credential in Claude and keeps the login token at the plugin boundary', async () => {
    const { service, request } = setup();
    const profile = await service.runtimeProfile();
    expect(profile.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(profile)).not.toContain('private-wesight-login');
    const response = await fetch(`${profile.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ model: ready.defaultModel, messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ text: 'ok' }] });
    const forwarded = request.mock.calls.find(([url]) => url.endsWith('/v1/messages'))!;
    expect(forwarded[1]?.headers?.Authorization).toBe('Bearer private-wesight-login');
    expect(forwarded[1]?.headers?.['X-Request-Id']).toMatch(/^[a-f0-9-]{36}$/);
    const projection = managedProjection(profile, {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'personal',
      CLAUDE_CODE_USE_BEDROCK: '1',
      OPENAI_API_KEY: 'personal-openai',
      WESIGHT_ACCESS_TOKEN: 'private-wesight-login',
      NODE_OPTIONS: '--require malicious.js',
      HTTPS_PROXY: 'http://proxy.invalid',
    });
    expect(JSON.stringify(projection)).not.toMatch(/personal|private-wesight-login|malicious/);
    expect(projection.env.CLAUDE_CODE_USE_BEDROCK).toBe('0');
    expect(projection.env.ANTHROPIC_AUTH_TOKEN).toBe(profile.apiKey);
    expect(projection.args[0]).toBe('--settings');
    expect(JSON.parse(projection.args[1])).toMatchObject({
      apiKeyHelper: '',
      env: { ANTHROPIC_BASE_URL: profile.baseUrl, ANTHROPIC_API_KEY: '' },
    });
    expect(() => managedProjection({ ...profile, baseUrl: 'https://remote.example' }, {})).toThrow();
  });
  it('rejects wrong loopback tokens/endpoints and rotates on logout', async () => {
    const { service, logout } = setup();
    const profile = await service.runtimeProfile();
    expect((await fetch(`${profile.baseUrl}/v1/messages`, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(`${profile.baseUrl}/v1/unknown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${profile.apiKey}` },
        })
      ).status,
    ).toBe(404);
    logout();
    expect(
      (
        await fetch(`${profile.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${profile.apiKey}` },
        })
      ).status,
    ).toBe(401);
    expect(service.status.state).toBe('login-required');
  });
  it('retains the request ID when refreshing expired authentication once', async () => {
    const { service, request, auth } = setup();
    const profile = await service.runtimeProfile();
    let first = true;
    request.mockImplementation(async (url) => {
      if (url.endsWith('/status')) return reply({ code: 0, data: ready });
      if (first) {
        first = false;
        return reply({}, 401);
      }
      return reply({ ok: true });
    });
    await fetch(`${profile.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      body: '{}',
    });
    const attempts = request.mock.calls.filter(([url]) => url.endsWith('/v1/messages'));
    expect(attempts).toHaveLength(2);
    expect(auth.refreshAccessToken).toHaveBeenCalledOnce();
    expect(attempts[0][1]?.headers?.['X-Request-Id']).toBe(attempts[1][1]?.headers?.['X-Request-Id']);
  });
  it.each(['membership-required', 'expired', 'quota-exhausted', 'unavailable'] as const)(
    'blocks %s without creating a runtime credential',
    async (state) => {
      const { service, confirmDisclosure } = setup({ ...ready, state });
      await expect(service.runtimeProfile()).rejects.toThrow();
      expect(confirmDisclosure).not.toHaveBeenCalled();
    },
  );
  it('requires consent, rejects removed models, and rejects a logout during consent', async () => {
    const { service, confirmDisclosure, logout } = setup();
    await expect(service.requireReady('removed')).rejects.toThrow('停用');
    confirmDisclosure.mockResolvedValueOnce(false);
    await expect(service.requireReady()).rejects.toThrow('取消');
    confirmDisclosure.mockImplementationOnce(async () => {
      logout();
      return true;
    });
    await expect(service.requireReady()).rejects.toThrow('改变');
  });
  it('fails closed on malformed/cloud error responses', async () => {
    const { service, request } = setup();
    request.mockResolvedValueOnce(reply({ code: 0, data: { ...ready, gatewayUrl: 'https://evil.example' } }));
    expect((await service.refresh()).state).toBe('unavailable');
  });
});
