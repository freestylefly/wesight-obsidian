import { randomBytes } from 'crypto';
import { requestUrl } from 'obsidian';

import { recordFromUnknown } from '../utils/records';

const AUTH_PAGE = 'https://docs.qq.com/scenario/open-claw.html';
const TOKEN_ENDPOINT = 'https://docs.qq.com/oauth/v2/mcp/token/get';
const AUTH_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;

export interface TencentDocsVerificationInfo {
  verificationUrl: string;
  userCode?: string;
}

export class TencentDocsBrowserAuthError extends Error {
  constructor(message: string, readonly code: 'auth' | 'permission' | 'network' | 'protocol' | 'cancelled' | 'expired') {
    super(message);
    this.name = 'TencentDocsBrowserAuthError';
  }
}

function cancelled(): TencentDocsBrowserAuthError {
  return new TencentDocsBrowserAuthError('腾讯文档登录已取消。', 'cancelled');
}

function expired(): TencentDocsBrowserAuthError {
  return new TencentDocsBrowserAuthError('腾讯文档授权链接已过期，请重新登录授权。', 'expired');
}

/**
 * Official desktop authorization flow, documented in tencent-docs/setup.sh:
 * https://cdn.addon.tencentsuite.com/static/tencent-docs.zip
 * The one-time code lasts five minutes and remains in memory only.
 */
export class TencentDocsBrowserAuth {
  private revision = 0;
  private cancelPending: (() => void) | null = null;

  cancel(): void {
    this.revision += 1;
    const cancel = this.cancelPending;
    this.cancelPending = null;
    cancel?.();
  }

  async authorize(onVerification: (info: TencentDocsVerificationInfo) => void): Promise<string> {
    this.cancel();
    const revision = this.revision;
    const code = randomBytes(8).toString('hex');
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    const verification = new URL(AUTH_PAGE);
    verification.search = new URLSearchParams({ nlc: '1', authType: '1', code, mcp_source: 'desktop' }).toString();
    const tokenUrl = new URL(TOKEN_ENDPOINT);
    tokenUrl.search = new URLSearchParams({ code }).toString();
    onVerification({ verificationUrl: verification.href });

    while (true) {
      this.assertActive(revision, deadline);
      await this.pause(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), revision);
      this.assertActive(revision, deadline);
      let response: Awaited<ReturnType<typeof requestUrl>>;
      try {
        response = await this.poll(tokenUrl.href, revision, deadline);
      } catch (error) {
        if (error instanceof TencentDocsBrowserAuthError) throw error;
        throw new TencentDocsBrowserAuthError('无法查询腾讯文档授权结果，请检查网络后重新登录。', 'network');
      }
      this.assertActive(revision, deadline);
      if (response.status < 200 || response.status >= 300) {
        throw new TencentDocsBrowserAuthError('腾讯文档授权服务暂时不可用，请稍后重新登录。', 'network');
      }
      let payload: Record<string, unknown> | null;
      try { payload = recordFromUnknown(JSON.parse(response.text)); } catch { payload = null; }
      if (!payload) throw new TencentDocsBrowserAuthError('腾讯文档返回了无效的授权结果，请重新登录。', 'protocol');
      const data = recordFromUnknown(payload.data);
      const ret = Number(payload.ret ?? payload.retcode ?? 0);
      if (data?.expired === true) throw expired();
      if (ret === 11510) continue;
      if (ret === 400006) throw new TencentDocsBrowserAuthError('腾讯文档授权已失效，请重新登录授权。', 'auth');
      if (ret === 400007) throw new TencentDocsBrowserAuthError('腾讯文档账号权限不足，请检查腾讯文档会员权益后重试。', 'permission');
      const token = typeof data?.token === 'string' ? data.token.trim() : '';
      if (ret === 0 && token && !/[\r\n]/.test(token)) return token;
      // Upstream messages may contain credentials. Keep errors local and generic.
      throw new TencentDocsBrowserAuthError('腾讯文档授权未完成，请重新登录后确认授权。', 'protocol');
    }
  }

  private assertActive(revision: number, deadline: number): void {
    if (revision !== this.revision) throw cancelled();
    if (Date.now() >= deadline) throw expired();
  }

  private pause(durationMs: number, revision: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        window.clearTimeout(timer);
        reject(cancelled());
      };
      const timer = window.setTimeout(() => {
        if (this.cancelPending === cancel) this.cancelPending = null;
        if (revision !== this.revision) reject(cancelled());
        else resolve();
      }, durationMs);
      this.cancelPending = cancel;
    });
  }

  private poll(url: string, revision: number, deadline: number): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (this.cancelPending === cancel) this.cancelPending = null;
        callback();
      };
      const cancel = () => finish(() => reject(cancelled()));
      const timer = window.setTimeout(() => finish(() => reject(expired())), Math.max(0, deadline - Date.now()));
      this.cancelPending = cancel;
      try {
        void requestUrl({ url, method: 'GET', throw: false }).then(
          response => finish(() => {
            if (revision !== this.revision) reject(cancelled());
            else resolve(response);
          }),
          () => finish(() => reject(new TencentDocsBrowserAuthError('无法连接腾讯文档授权服务，请检查网络后重试。', 'network'))),
        );
      } catch {
        finish(() => reject(new TencentDocsBrowserAuthError('无法连接腾讯文档授权服务，请检查网络后重试。', 'network')));
      }
    });
  }
}
