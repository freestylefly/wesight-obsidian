import { verify } from 'node:crypto';

import { requestUrl } from 'obsidian';
import type { SecretStorage } from 'obsidian';

import type { CloudAuthService } from '../share/cloudAuth';
import type {
  KnowledgeBrainAccessState,
  KnowledgeBrainAccessStatus,
  KnowledgeBrainEntitlementServiceContract,
} from './types';

const API_URL = 'https://api.wesight.ai/api/features/knowledge-brain/entitlement';
const TOKEN_SECRET_ID = 'wesight-obsidian-knowledge-brain-entitlement';
const FEATURE = 'knowledge-brain-beta';
const AUDIENCE = 'wesight-obsidian';
const ISSUER = 'wesight-api';
const KEY_ID = 'wesight-kb-beta-2026-08';
const REFRESH_AFTER_MS = 15 * 60 * 1000;
const MAX_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_TOLERANCE_SECONDS = 5 * 60;

export const KNOWLEDGE_BRAIN_ENTITLEMENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvGmSsj9bx5FLI0hW1qN2i2evDAgImpBWCw7XmFEaulQ=
-----END PUBLIC KEY-----`;

type EntitlementReason =
  | 'active-member'
  | 'membership-required'
  | 'membership-expired'
  | 'beta-paused';

interface EntitlementResponse {
  eligible: boolean;
  reason: EntitlementReason;
  token: string | null;
  expiresAt: string | null;
  membershipExpiresAt: string | null;
  checkoutUrl: string;
}

interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

interface VerifiedToken {
  issuedAtMs: number;
  expiresAtMs: number;
}

interface EntitlementTransportResponse {
  status: number;
  json: unknown;
}

type EntitlementTransport = (token: string) => Promise<EntitlementTransportResponse>;

interface EntitlementOptions {
  now?: () => number;
  transport?: EntitlementTransport;
  publicKey?: string;
}

export class KnowledgeBrainEntitlementError extends Error {
  constructor(readonly access: KnowledgeBrainAccessStatus) {
    super(access.reason || '知识大脑会员权益不可用。');
  }
}

function status(
  state: KnowledgeBrainAccessState,
  options: Partial<Omit<KnowledgeBrainAccessStatus, 'state' | 'allowed'>> = {},
): KnowledgeBrainAccessStatus {
  return {
    state,
    allowed: state === 'eligible' || state === 'offline-grace',
    verifiedOnline: options.verifiedOnline ?? false,
    expiresAt: options.expiresAt ?? null,
    reason: options.reason ?? accessReason(state),
  };
}

export function accessReason(state: KnowledgeBrainAccessState): string | null {
  const reasons: Record<KnowledgeBrainAccessState, string | null> = {
    checking: '正在检查知识大脑会员资格…',
    eligible: null,
    'offline-grace': '当前离线，正在使用最近一次有效的会员凭证。',
    'login-required': '登录 WeSight 后可验证知识大脑会员资格。',
    'membership-required': '知识大脑内测仅向 WeSight 有效会员开放。',
    expired: 'WeSight 会员已到期，续费后可继续使用知识大脑。',
    'beta-paused': '知识大脑会员内测暂未开放。',
    unavailable: '暂时无法验证知识大脑会员资格，请稍后重试。',
  };
  return reasons[state];
}

function parseSegment(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function verifyKnowledgeBrainEntitlementToken(
  token: string,
  userId: string,
  nowMs = Date.now(),
  publicKey = KNOWLEDGE_BRAIN_ENTITLEMENT_PUBLIC_KEY,
): VerifiedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseSegment(encodedHeader);
  const payload = parseSegment(encodedPayload);
  if (!header || !payload) return null;
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || header.kid !== KEY_ID) return null;
  const signature = Buffer.from(encodedSignature, 'base64url');
  const validSignature = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    signature,
  );
  if (!validSignature) return null;
  if (
    payload.iss !== ISSUER
    || payload.aud !== AUDIENCE
    || payload.sub !== userId
    || payload.feature !== FEATURE
    || payload.type !== 'feature-entitlement'
    || typeof payload.jti !== 'string'
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
  ) return null;
  if (payload.exp <= payload.iat) return null;
  if (payload.exp - payload.iat > MAX_TOKEN_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS || payload.exp <= nowSeconds) return null;
  return { issuedAtMs: payload.iat * 1000, expiresAtMs: payload.exp * 1000 };
}

function mapDeniedReason(reason: EntitlementReason): KnowledgeBrainAccessState {
  if (reason === 'membership-expired') return 'expired';
  if (reason === 'beta-paused') return 'beta-paused';
  return 'membership-required';
}

export class KnowledgeBrainEntitlementService implements KnowledgeBrainEntitlementServiceContract {
  private current = status('checking');
  private listeners = new Set<() => void>();
  private refreshPromise: Promise<KnowledgeBrainAccessStatus> | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly transport: EntitlementTransport;
  private readonly publicKey: string;

  constructor(
    private readonly auth: CloudAuthService,
    private readonly secretStorage: SecretStorage,
    options: EntitlementOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.publicKey = options.publicKey ?? KNOWLEDGE_BRAIN_ENTITLEMENT_PUBLIC_KEY;
    this.transport = options.transport ?? (async token => {
      const response = await requestUrl({
        url: API_URL,
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      return { status: response.status, json: response.json };
    });
  }

  start(): void {
    if (this.authUnsubscribe) return;
    this.authUnsubscribe = this.auth.onChange(() => {
      if (!this.auth.getCurrentUser()) {
        this.clear();
        return;
      }
      void this.probe(true);
    });
    void this.probe(true);
  }

  dispose(): void {
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
  }

  getCurrentStatus(): KnowledgeBrainAccessStatus {
    return this.current;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
    this.setCurrent(status(this.auth.getCurrentUser() ? 'unavailable' : 'login-required'));
  }

  async probe(forceRefresh = false): Promise<KnowledgeBrainAccessStatus> {
    const user = this.auth.getCurrentUser();
    if (!user) {
      this.clear();
      return this.current;
    }
    const cached = this.readCached(user.userId);
    if (!forceRefresh && cached && this.now() - cached.verified.issuedAtMs < REFRESH_AFTER_MS) {
      this.setCurrent(status('eligible', {
        expiresAt: new Date(cached.verified.expiresAtMs).toISOString(),
      }));
      return this.current;
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.setCurrent(status('checking', {
      expiresAt: cached ? new Date(cached.verified.expiresAtMs).toISOString() : null,
    }));
    this.refreshPromise = this.refreshFromServer(user.userId, cached).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async requireCoreAccess(): Promise<KnowledgeBrainAccessStatus> {
    const access = await this.probe(false);
    if (!access.allowed) throw new KnowledgeBrainEntitlementError(access);
    return access;
  }

  private readCached(userId: string): { token: string; verified: VerifiedToken } | null {
    const token = this.secretStorage.getSecret(TOKEN_SECRET_ID)?.trim();
    if (!token) return null;
    const verified = verifyKnowledgeBrainEntitlementToken(token, userId, this.now(), this.publicKey);
    if (!verified) {
      this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
      return null;
    }
    return { token, verified };
  }

  private async refreshFromServer(
    userId: string,
    cached: { token: string; verified: VerifiedToken } | null,
  ): Promise<KnowledgeBrainAccessStatus> {
    try {
      let accessToken = await this.auth.getAccessToken();
      let response = await this.transport(accessToken);
      if (response.status === 401) {
        accessToken = await this.auth.refreshAccessToken();
        response = await this.transport(accessToken);
      }
      if (response.status === 401) {
        this.auth.clearSession();
        return this.current;
      }
      const envelope = response.json as ApiEnvelope<EntitlementResponse>;
      if (response.status >= 500 || response.status < 200 || response.status >= 300) {
        return this.useOfflineFallback(cached);
      }
      if (envelope.code !== 0 || !envelope.data) {
        this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
        this.setCurrent(status('unavailable'));
        return this.current;
      }
      if (!envelope.data.eligible) {
        this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
        this.setCurrent(status(mapDeniedReason(envelope.data.reason), { verifiedOnline: true }));
        return this.current;
      }
      if (!envelope.data.token) {
        this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
        this.setCurrent(status('unavailable', { verifiedOnline: true }));
        return this.current;
      }
      const verified = verifyKnowledgeBrainEntitlementToken(
        envelope.data.token,
        userId,
        this.now(),
        this.publicKey,
      );
      if (!verified) {
        this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
        this.setCurrent(status('unavailable', {
          verifiedOnline: true,
          reason: '知识大脑会员凭证校验失败，请稍后重试。',
        }));
        return this.current;
      }
      this.secretStorage.setSecret(TOKEN_SECRET_ID, envelope.data.token);
      this.setCurrent(status('eligible', {
        verifiedOnline: true,
        expiresAt: new Date(verified.expiresAtMs).toISOString(),
      }));
      return this.current;
    } catch {
      if (!this.auth.getCurrentUser()) {
        this.secretStorage.setSecret(TOKEN_SECRET_ID, '');
        this.setCurrent(status('login-required'));
        return this.current;
      }
      return this.useOfflineFallback(cached);
    }
  }

  private useOfflineFallback(
    cached: { token: string; verified: VerifiedToken } | null,
  ): KnowledgeBrainAccessStatus {
    if (cached && cached.verified.expiresAtMs > this.now()) {
      this.setCurrent(status('offline-grace', {
        expiresAt: new Date(cached.verified.expiresAtMs).toISOString(),
      }));
    } else {
      this.setCurrent(status('unavailable'));
    }
    return this.current;
  }

  private setCurrent(next: KnowledgeBrainAccessStatus): void {
    if (JSON.stringify(this.current) === JSON.stringify(next)) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
