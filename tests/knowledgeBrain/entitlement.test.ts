vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

import { generateKeyPairSync, sign } from 'node:crypto';

import { requestUrl } from 'obsidian';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CloudAuthService } from '../../src/share/cloudAuth';
import {
  KnowledgeBrainEntitlementError,
  KnowledgeBrainEntitlementService,
  verifyKnowledgeBrainEntitlementToken,
} from '../../src/knowledgeBrain/entitlement';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const baseNow = Date.parse('2026-08-09T08:00:00.000Z');

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function entitlementToken(options: {
  sub?: string;
  iat?: number;
  exp?: number;
  feature?: string;
  audience?: string;
} = {}): string {
  const iat = options.iat ?? Math.floor(baseNow / 1000);
  const header = encode({ alg: 'EdDSA', typ: 'JWT', kid: 'wesight-kb-beta-2026-08' });
  const payload = encode({
    iss: 'wesight-api',
    aud: options.audience ?? 'wesight-obsidian',
    sub: options.sub ?? userId,
    feature: options.feature ?? 'knowledge-brain-beta',
    type: 'feature-entitlement',
    jti: 'test-entitlement',
    iat,
    exp: options.exp ?? iat + 7 * 24 * 60 * 60,
  });
  const body = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(body), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

function auth(currentUser: { userId: string } | null = { userId }): CloudAuthService {
  return {
    getCurrentUser: vi.fn(() => currentUser),
    getAccessToken: vi.fn(async () => 'access-token'),
    refreshAccessToken: vi.fn(async () => 'refreshed-token'),
    clearSession: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  } as unknown as CloudAuthService;
}

function secrets(initial = ''): {
  getSecret: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  value: () => string;
} {
  let value = initial;
  return {
    getSecret: vi.fn(() => value),
    setSecret: vi.fn((_id: string, next: string) => { value = next; }),
    value: () => value,
  };
}

describe('KnowledgeBrainEntitlementService', () => {
  beforeEach(() => vi.clearAllMocks());

  test('verifies signature and rejects altered identity, feature, expiry, and future issuance', () => {
    expect(verifyKnowledgeBrainEntitlementToken(entitlementToken(), userId, baseNow, publicKey)).not.toBeNull();
    expect(verifyKnowledgeBrainEntitlementToken(entitlementToken({ sub: 'other' }), userId, baseNow, publicKey)).toBeNull();
    expect(verifyKnowledgeBrainEntitlementToken(entitlementToken({ feature: 'other' }), userId, baseNow, publicKey)).toBeNull();
    expect(verifyKnowledgeBrainEntitlementToken(entitlementToken({ exp: Math.floor(baseNow / 1000) }), userId, baseNow, publicKey)).toBeNull();
    expect(verifyKnowledgeBrainEntitlementToken(entitlementToken({ iat: Math.floor(baseNow / 1000) + 601 }), userId, baseNow, publicKey)).toBeNull();

    const parts = entitlementToken().split('.');
    const altered = `${parts[0]}.${encode({ sub: userId })}.${parts[2]}`;
    expect(verifyKnowledgeBrainEntitlementToken(altered, userId, baseNow, publicKey)).toBeNull();
  });

  test('stores a valid online entitlement', async () => {
    const storage = secrets();
    const token = entitlementToken();
    const transport = vi.fn(async () => ({
      status: 200,
      json: {
        code: 0,
        data: {
          eligible: true,
          reason: 'active-member',
          token,
          expiresAt: new Date(baseNow + 7 * 86400_000).toISOString(),
          membershipExpiresAt: new Date(baseNow + 30 * 86400_000).toISOString(),
          checkoutUrl: 'https://pay.wesight.ai/billing',
        },
      },
    }));
    const service = new KnowledgeBrainEntitlementService(auth(), storage as never, {
      now: () => baseNow,
      publicKey,
      transport,
    });

    await expect(service.probe(true)).resolves.toMatchObject({
      state: 'eligible',
      allowed: true,
      verifiedOnline: true,
    });
    expect(storage.value()).toBe(token);
  });

  test('uses a still-valid cached token when refresh fails', async () => {
    const token = entitlementToken({ iat: Math.floor(baseNow / 1000) - 3600 });
    const storage = secrets(token);
    const service = new KnowledgeBrainEntitlementService(auth(), storage as never, {
      now: () => baseNow,
      publicKey,
      transport: vi.fn(async () => { throw new Error('offline'); }),
    });

    await expect(service.probe(true)).resolves.toMatchObject({
      state: 'offline-grace',
      allowed: true,
      verifiedOnline: false,
    });
  });

  test('clears cached access after an authoritative membership denial', async () => {
    const storage = secrets(entitlementToken());
    const service = new KnowledgeBrainEntitlementService(auth(), storage as never, {
      now: () => baseNow,
      publicKey,
      transport: vi.fn(async () => ({
        status: 200,
        json: {
          code: 0,
          data: {
            eligible: false,
            reason: 'membership-required',
            token: null,
            expiresAt: null,
            membershipExpiresAt: null,
            checkoutUrl: 'https://pay.wesight.ai/billing',
          },
        },
      })),
    });

    const access = await service.probe(true);
    expect(access).toMatchObject({ state: 'membership-required', allowed: false, verifiedOnline: true });
    expect(storage.value()).toBe('');
    await expect(service.requireCoreAccess()).rejects.toBeInstanceOf(KnowledgeBrainEntitlementError);
  });

  test('requires login without contacting the entitlement endpoint', async () => {
    const storage = secrets(entitlementToken());
    const transport = vi.fn();
    const service = new KnowledgeBrainEntitlementService(auth(null), storage as never, {
      now: () => baseNow,
      publicKey,
      transport,
    });

    await expect(service.probe(true)).resolves.toMatchObject({ state: 'login-required', allowed: false });
    expect(storage.value()).toBe('');
    expect(transport).not.toHaveBeenCalled();
  });

  test('sends only the bearer credential to the entitlement endpoint', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: {
        code: 0,
        data: {
          eligible: false,
          reason: 'membership-required',
          token: null,
          expiresAt: null,
          membershipExpiresAt: null,
          checkoutUrl: 'https://pay.wesight.ai/billing',
        },
      },
    } as never);
    const service = new KnowledgeBrainEntitlementService(auth(), secrets() as never, {
      now: () => baseNow,
      publicKey,
    });

    await service.probe(true);

    expect(requestUrl).toHaveBeenCalledWith({
      url: 'https://api.wesight.ai/api/features/knowledge-brain/entitlement',
      headers: { Authorization: 'Bearer access-token' },
      throw: false,
    });
    const serialized = JSON.stringify(vi.mocked(requestUrl).mock.calls);
    expect(serialized).not.toContain('question-canary');
    expect(serialized).not.toContain('answer-canary');
    expect(serialized).not.toContain('/Users/canary/vault');
  });
});
