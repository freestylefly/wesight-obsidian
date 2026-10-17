import {
  MULTI_PUBLISH_FREE_LIMIT_NOTICE,
  MULTI_PUBLISH_LOGIN_PROMPT,
  resolveMultiPublishAccess,
  normalizeMultiPublishSelection,
  validateMultiPublishTargetCount,
} from '../src/multiPublish/access';
import type { CloudBillingSummary, CloudUser } from '../src/share/types';
import { MULTI_PLATFORM_IDS } from '../src/multiPublish/types';
import { DEFAULT_SETTINGS } from '../src/types';

const user: CloudUser = {
  userId: 'user_1',
  nickname: 'WeSight user',
  avatarUrl: null,
};

function billing(membershipActive: boolean): CloudBillingSummary {
  return {
    planName: membershipActive ? '创作者会员' : '免费用户',
    subscriptionStatus: membershipActive ? 'active' : 'free',
    creditsLimit: 0,
    creditsUsed: 0,
    creditsRemaining: 0,
    totalCreditsRemaining: 0,
    balances: { free: 0, membership: 0, purchased: 0 },
    membership: {
      active: membershipActive,
      planCode: membershipActive ? 'creator' : null,
      planName: membershipActive ? '创作者会员' : null,
      expiresAt: membershipActive ? '2027-01-01T00:00:00.000Z' : null,
    },
    creditItems: [],
    publishCost: 0,
    checkoutUrl: 'https://pay.wesight.ai/billing',
  };
}

describe('multi-platform membership access', () => {
  test('defines seven article platforms and defaults new users to Zhihu only', () => {
    expect(MULTI_PLATFORM_IDS).toEqual([
      'zhihu', 'csdn', 'juejin', 'bilibili-article', 'toutiao', 'weibo-article', 'x-article',
    ]);
    expect(DEFAULT_SETTINGS.multiPublishPlatforms).toEqual(['zhihu']);
  });
  test('requires login before any platform sync', () => {
    const access = resolveMultiPublishAccess(null, null);
    expect(access).toEqual({ state: 'login-required', maxTargets: 0 });
    expect(validateMultiPublishTargetCount(access, 1)).toBe(MULTI_PUBLISH_LOGIN_PROMPT);
  });

  test('allows a signed-in free user to sync exactly one platform', () => {
    const access = resolveMultiPublishAccess(user, billing(false));
    expect(access).toEqual({ state: 'single-platform', maxTargets: 1 });
    expect(validateMultiPublishTargetCount(access, 1)).toBeNull();
    expect(validateMultiPublishTargetCount(access, 2)).toBe(MULTI_PUBLISH_FREE_LIMIT_NOTICE);
  });

  test('uses the one-platform limit while billing status is unavailable', () => {
    const access = resolveMultiPublishAccess(user, null);
    expect(access).toEqual({ state: 'single-platform', maxTargets: 1 });
    expect(validateMultiPublishTargetCount(access, 2)).toBe(MULTI_PUBLISH_FREE_LIMIT_NOTICE);
  });

  test('allows an active member to sync multiple platforms', () => {
    const access = resolveMultiPublishAccess(user, billing(true));
    expect(access).toEqual({ state: 'multi-platform', maxTargets: null });
    expect(validateMultiPublishTargetCount(access, 6)).toBeNull();
  });

  test('keeps only the first historical platform for a signed-in free user', () => {
    const access = resolveMultiPublishAccess(user, billing(false));
    expect(normalizeMultiPublishSelection(access, ['csdn', 'zhihu', 'toutiao'])).toEqual({
      platforms: ['csdn'],
      limited: true,
    });
  });

  test('keeps all six selected platforms for an active member', () => {
    const access = resolveMultiPublishAccess(user, billing(true));
    expect(normalizeMultiPublishSelection(access, [
      'zhihu', 'csdn', 'juejin', 'bilibili-article', 'toutiao', 'weibo-article',
    ])).toEqual({
      platforms: ['zhihu', 'csdn', 'juejin', 'bilibili-article', 'toutiao', 'weibo-article'],
      limited: false,
    });
  });
});
