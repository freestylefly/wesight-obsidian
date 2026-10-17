import { App, Notice } from 'obsidian';

import { CloudAuthRequiredError, type CloudAuthService } from '../share/cloudAuth';
import type { CloudBillingSummary } from '../share/types';
import { confirmShareAction } from './shareConfirm';

const pendingChecks = new WeakSet<CloudAuthService>();

function isActiveMembership(billing: CloudBillingSummary | null): boolean {
  const membership = billing?.membership;
  const expiresAt = membership?.expiresAt;
  const expiresTime = expiresAt == null ? null : Date.parse(expiresAt);
  return membership?.active === true
    && (expiresTime === null || (Number.isFinite(expiresTime) && expiresTime > Date.now()));
}

/** Cached status for rendering only; operations still need requireMemberFeature. */
export function hasActiveMembership(auth: CloudAuthService): boolean {
  return !!auth.getCurrentUser() && isActiveMembership(auth.getBillingSummary());
}

/** Check current server membership before starting a member-only operation. */
export async function requireMemberFeature(
  app: App,
  auth: CloudAuthService,
  feature: string,
): Promise<boolean> {
  if (pendingChecks.has(auth)) return false;
  pendingChecks.add(auth);
  try {
    const user = await auth.restoreSession();
    if (!user) {
      guideLogin(auth, feature);
      return false;
    }
    const userId = user.userId;
    if (auth.getCurrentUser()?.userId !== userId) {
      new Notice('WeSight 账号已变更，请重新点击后再试。');
      return false;
    }

    const billing = await auth.refreshBillingSummary(false);
    if (auth.getCurrentUser()?.userId !== userId) {
      new Notice('WeSight 账号已变更，请重新点击后再试。');
      return false;
    }
    if (isActiveMembership(billing)) return true;

    const confirmed = await confirmShareAction(app, {
      title: '会员专享功能',
      message: `「${feature}」为会员专享功能。当前账号尚未开通有效会员，请充值会员后使用。`,
      confirmText: '去充值会员',
    });
    if (confirmed && auth.getCurrentUser()?.userId === userId) auth.openBilling();
    return false;
  } catch (error) {
    if (error instanceof CloudAuthRequiredError) {
      guideLogin(auth, feature);
    } else {
      new Notice('无法验证会员状态，请检查网络后重试。');
    }
    return false;
  } finally {
    pendingChecks.delete(auth);
  }
}

function guideLogin(auth: CloudAuthService, feature: string): void {
  new Notice(`请先登录 WeSight，开通会员后使用「${feature}」。`);
  auth.startLogin();
}
