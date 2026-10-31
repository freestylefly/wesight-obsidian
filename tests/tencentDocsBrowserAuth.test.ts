import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

import { requestUrl, type RequestUrlParam } from 'obsidian';
import { TencentDocsBrowserAuth, type TencentDocsVerificationInfo } from '../src/tencentDocs/browserAuth';

function response(value: unknown, status = 200) {
  return { status, headers: {}, text: JSON.stringify(value) } as never;
}

function start(auth = new TencentDocsBrowserAuth()) {
  const onVerification = vi.fn<(info: TencentDocsVerificationInfo) => void>();
  const outcome = auth.authorize(onVerification).then(token => ({ token, error: null }), (error: unknown) => ({ token: null, error }));
  return { auth, onVerification, outcome };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tencent Docs official browser authorization', () => {
  test('opens the official one-time-code page and retrieves the token after approval', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response({ ret: 11510 }))
      .mockResolvedValueOnce(response({ ret: 0, data: { token: '  authorized-token  ', expired: false } }));
    const f = start();
    expect(f.onVerification).toHaveBeenCalledOnce();
    const verification = new URL(f.onVerification.mock.calls[0][0].verificationUrl);
    expect(`${verification.origin}${verification.pathname}`).toBe('https://docs.qq.com/scenario/open-claw.html');
    expect(verification.searchParams.get('authType')).toBe('1');
    expect(verification.searchParams.get('mcp_source')).toBe('desktop');
    const code = verification.searchParams.get('code');
    expect(code).toMatch(/^[a-f0-9]{16}$/);
    expect(requestUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await f.outcome).toEqual({ token: 'authorized-token', error: null });
    const request = vi.mocked(requestUrl).mock.calls[0][0] as RequestUrlParam;
    const endpoint = new URL(request.url);
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe('https://docs.qq.com/oauth/v2/mcp/token/get');
    expect(endpoint.searchParams.get('code')).toBe(code);
    expect(request.headers).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('cancels a pending wait immediately and gives a retry its own code', async () => {
    const f = start();
    const firstUrl = f.onVerification.mock.calls[0][0].verificationUrl;
    f.auth.cancel();
    expect(await f.outcome).toMatchObject({ token: null, error: { code: 'cancelled' } });
    expect(requestUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(requestUrl).mockResolvedValueOnce(response({ ret: 0, data: { token: 'retry-token' } }));
    const retry = start(f.auth);
    expect(retry.onVerification.mock.calls[0][0].verificationUrl).not.toBe(firstUrl);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await retry.outcome).toEqual({ token: 'retry-token', error: null });
  });

  test('cancels an in-flight token query and ignores its later token', async () => {
    let complete!: (value: never) => void;
    vi.mocked(requestUrl).mockReturnValueOnce(new Promise<never>(resolve => { complete = resolve; }) as never);
    const f = start();
    await vi.advanceTimersByTimeAsync(3_000);
    f.auth.cancel();
    expect(await f.outcome).toMatchObject({ token: null, error: { code: 'cancelled' } });
    expect(vi.getTimerCount()).toBe(0);
    complete(response({ ret: 0, data: { token: 'late-token' } }));
    await Promise.resolve();
    expect(await f.outcome).toMatchObject({ token: null, error: { code: 'cancelled' } });
  });

  test('a new authorization replaces an earlier waiting operation', async () => {
    const first = start();
    vi.mocked(requestUrl).mockResolvedValueOnce(response({ data: { token: 'new-token' } }));
    const second = start(first.auth);
    expect(await first.outcome).toMatchObject({ error: { code: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await second.outcome).toMatchObject({ token: 'new-token', error: null });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('expires pending authorization after five minutes and stops polling', async () => {
    vi.mocked(requestUrl).mockResolvedValue(response({ ret: 11510 }));
    const f = start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await f.outcome).toMatchObject({ error: { code: 'expired' } });
    const calls = vi.mocked(requestUrl).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestUrl).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('also expires a token query that never returns', async () => {
    vi.mocked(requestUrl).mockReturnValueOnce(new Promise<never>(() => {}) as never);
    const f = start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await f.outcome).toMatchObject({ error: { code: 'expired' } });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    [{ ret: 400006, msg: 'secret-token' }, 'auth'],
    [{ ret: 400007, msg: 'secret-token' }, 'permission'],
    [{ ret: 0, data: { expired: true, token: 'secret-token' } }, 'expired'],
    [{ ret: 12345, data: { token: 'secret-token' } }, 'protocol'],
    [{ ret: 0, data: { token: 'secret-token\r\nheader' } }, 'protocol'],
  ])('handles provider failures without exposing the returned token (%j)', async (payload, code) => {
    vi.mocked(requestUrl).mockResolvedValueOnce(response(payload));
    const f = start();
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await f.outcome;
    expect(result).toMatchObject({ token: null, error: { code } });
    expect((result.error as Error).message).not.toContain('secret-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('sanitizes transport failures', async () => {
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('Authorization: secret-token'));
    const f = start();
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await f.outcome;
    expect(result).toMatchObject({ error: { code: 'network' } });
    expect((result.error as Error).message).not.toContain('secret-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejects a malformed provider response', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, headers: {}, text: '<html>unavailable</html>' } as never);
    const f = start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await f.outcome).toMatchObject({ error: { code: 'protocol' } });
  });
});
