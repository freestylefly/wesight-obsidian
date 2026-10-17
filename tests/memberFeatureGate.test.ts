import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ App: class {}, Notice: vi.fn() }));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn() }));

import { App, Notice } from 'obsidian';
import { CloudAuthRequiredError, type CloudAuthService } from '../src/share/cloudAuth';
import type { CloudBillingSummary, CloudUser } from '../src/share/types';
import { hasActiveMembership, requireMemberFeature } from '../src/ui/memberFeatureGate';
import { confirmShareAction } from '../src/ui/shareConfirm';

function fixture() {
  let currentUser: CloudUser | null = { userId: 'user-a', nickname: 'A', avatarUrl: null };
  const billing = { membership: { active: true, expiresAt: null } } as CloudBillingSummary;
  const methods = {
    restoreSession: vi.fn().mockImplementation(async () => currentUser),
    getCurrentUser: vi.fn().mockImplementation(() => currentUser),
    getBillingSummary: vi.fn().mockReturnValue(billing),
    refreshBillingSummary: vi.fn().mockResolvedValue(billing),
    startLogin: vi.fn(),
    openBilling: vi.fn(),
  };
  const auth = methods as unknown as CloudAuthService;
  const app = {} as App;
  return {
    auth, app, methods, billing,
    setUser(user: CloudUser | null) { currentUser = user; },
    check: () => requireMemberFeature(app, auth, '转为图文到多平台'),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('member feature access', () => {
  test('checks fresh billing before granting access, even when the cached summary is free', async () => {
    const f = fixture();
    f.methods.getBillingSummary.mockReturnValue({ membership: { active: false } });
    expect(await f.check()).toBe(true);
    expect(f.methods.restoreSession).toHaveBeenCalledOnce();
    expect(f.methods.refreshBillingSummary).toHaveBeenCalledExactlyOnceWith(false);
    expect(confirmShareAction).not.toHaveBeenCalled();
  });

  test('signed-out access guides login without looking up billing or opening recharge', async () => {
    const f = fixture();
    f.setUser(null);
    expect(await f.check()).toBe(false);
    expect(f.methods.startLogin).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('请先登录 WeSight'));
    expect(f.methods.refreshBillingSummary).not.toHaveBeenCalled();
    expect(f.methods.openBilling).not.toHaveBeenCalled();
    expect(confirmShareAction).not.toHaveBeenCalled();
  });

  test.each([
    { active: false, expiresAt: null },
    { active: true, expiresAt: '2000-01-01T00:00:00.000Z' },
    { active: true, expiresAt: 'invalid-expiry' },
  ])('blocks missing or expired membership and opens recharge only after confirmation: %j', async membership => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockResolvedValue({ ...f.billing, membership });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(true);
    expect(await f.check()).toBe(false);
    const prompt = vi.mocked(confirmShareAction).mock.calls.at(-1)?.[1];
    expect(prompt?.message).toContain('尚未开通有效会员');
    expect(prompt?.confirmText).toBe('去充值会员');
    expect(f.methods.openBilling).toHaveBeenCalledOnce();
  });

  test('cancelling recharge keeps access blocked without navigation', async () => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockResolvedValue({ membership: { active: false } });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(false);
    expect(await f.check()).toBe(false);
    expect(f.methods.openBilling).not.toHaveBeenCalled();
  });

  test('billing errors do not become membership rejections and a later click can retry', async () => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockRejectedValueOnce(new Error('offline'));
    expect(await f.check()).toBe(false);
    expect(Notice).toHaveBeenCalledWith('无法验证会员状态，请检查网络后重试。');
    expect(confirmShareAction).not.toHaveBeenCalled();
    expect(f.methods.openBilling).not.toHaveBeenCalled();
    expect(await f.check()).toBe(true);
  });

  test('expired authentication guides login and keeps the feature blocked', async () => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockRejectedValueOnce(new CloudAuthRequiredError());
    expect(await f.check()).toBe(false);
    expect(f.methods.startLogin).toHaveBeenCalledOnce();
    expect(confirmShareAction).not.toHaveBeenCalled();
  });

  test('a concurrent second feature does not open another check or recharge dialog', async () => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockResolvedValue({ membership: { active: false } });
    let finish!: (confirmed: boolean) => void;
    vi.mocked(confirmShareAction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(confirmShareAction).toHaveBeenCalledOnce();
    expect(await requireMemberFeature(f.app, f.auth, '浏览器发布助手连接')).toBe(false);
    expect(f.methods.refreshBillingSummary).toHaveBeenCalledOnce();
    finish(true);
    expect(await first).toBe(false);
    expect(f.methods.openBilling).toHaveBeenCalledOnce();
  });

  test.each(['account-switch', 'sign-out'])('stale membership cannot grant access after %s', async action => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockImplementationOnce(async () => {
      f.setUser(action === 'sign-out' ? null : { userId: 'user-b', nickname: 'B', avatarUrl: null });
      return f.billing;
    });
    expect(await f.check()).toBe(false);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('账号已变更'));
    expect(confirmShareAction).not.toHaveBeenCalled();
  });

  test('switching accounts during the recharge prompt prevents navigation for the old account', async () => {
    const f = fixture();
    f.methods.refreshBillingSummary.mockResolvedValue({ membership: { active: false } });
    vi.mocked(confirmShareAction).mockImplementationOnce(async () => {
      f.setUser({ userId: 'user-b', nickname: 'B', avatarUrl: null });
      return true;
    });
    expect(await f.check()).toBe(false);
    expect(f.methods.openBilling).not.toHaveBeenCalled();
  });

  test('future expiry grants access and cached rendering performs no network requests', async () => {
    const f = fixture();
    f.billing.membership.expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(hasActiveMembership(f.auth)).toBe(true);
    expect(f.methods.restoreSession).not.toHaveBeenCalled();
    expect(f.methods.refreshBillingSummary).not.toHaveBeenCalled();
    expect(await f.check()).toBe(true);
    f.billing.membership.expiresAt = '2000-01-01T00:00:00.000Z';
    expect(hasActiveMembership(f.auth)).toBe(false);
    f.billing.membership.expiresAt = null;
    f.setUser(null);
    expect(hasActiveMembership(f.auth)).toBe(false);
  });
});
