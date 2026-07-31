import { App, Notice, requestUrl } from 'obsidian';

import type { CloudUser } from './types';

const API_BASE_URL = 'https://api.wesight.ai';
const REFRESH_TOKEN_SECRET_ID = 'wesight-obsidian-refresh-token';

interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface ExchangeResult extends AuthTokens {
  user: CloudUser;
}

export class CloudAuthRequiredError extends Error {
  constructor() {
    super('Sign in to WeSight before sharing');
  }
}

export class CloudAuthService {
  private accessToken: string | null = null;
  private user: CloudUser | null = null;
  private refreshPromise: Promise<string> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly app: App) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCurrentUser(): CloudUser | null {
    return this.user;
  }

  startLogin(): void {
    const callback = 'obsidian://wesight-auth';
    const loginUrl = `${API_BASE_URL}/login?source=obsidian&callback=${encodeURIComponent(callback)}`;
    window.open(loginUrl, '_blank', 'noopener,noreferrer');
    new Notice('请在浏览器中完成 WeSight 登录，然后返回 Obsidian。');
  }

  async handleAuthCallback(authCode: string): Promise<void> {
    if (!authCode.trim()) {
      throw new Error('Missing WeSight auth code');
    }
    const response = await requestUrl({
      url: `${API_BASE_URL}/api/auth/exchange`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ authCode }),
      throw: false,
    });
    const payload = response.json as ApiEnvelope<ExchangeResult>;
    if (response.status >= 400 || payload.code !== 0 || !payload.data) {
      throw new Error(payload.message || 'WeSight login failed');
    }
    this.accessToken = payload.data.accessToken;
    this.user = payload.data.user;
    this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, payload.data.refreshToken);
    this.emitChange();
  }

  async restoreSession(): Promise<CloudUser | null> {
    if (this.user && this.accessToken) return this.user;
    const refreshToken = this.readRefreshToken();
    if (!refreshToken) return null;
    try {
      await this.refreshAccessToken();
      this.user = await this.fetchProfile();
      this.emitChange();
      return this.user;
    } catch {
      this.clearSession();
      return null;
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (!this.readRefreshToken()) throw new CloudAuthRequiredError();
    return this.refreshAccessToken();
  }

  async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.rotateRefreshToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  clearSession(): void {
    this.accessToken = null;
    this.user = null;
    this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, '');
    this.emitChange();
  }

  private readRefreshToken(): string | null {
    return this.app.secretStorage.getSecret(REFRESH_TOKEN_SECRET_ID)?.trim() || null;
  }

  private async rotateRefreshToken(): Promise<string> {
    const refreshToken = this.readRefreshToken();
    if (!refreshToken) throw new CloudAuthRequiredError();
    const response = await requestUrl({
      url: `${API_BASE_URL}/api/auth/refresh`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ refreshToken }),
      throw: false,
    });
    const payload = response.json as ApiEnvelope<AuthTokens>;
    if (response.status >= 400 || payload.code !== 0 || !payload.data) {
      this.clearSession();
      throw new CloudAuthRequiredError();
    }
    this.accessToken = payload.data.accessToken;
    this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, payload.data.refreshToken);
    return payload.data.accessToken;
  }

  private async fetchProfile(): Promise<CloudUser> {
    const token = this.accessToken;
    if (!token) throw new CloudAuthRequiredError();
    const response = await requestUrl({
      url: `${API_BASE_URL}/api/user/profile`,
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    const payload = response.json as ApiEnvelope<CloudUser>;
    if (response.status >= 400 || payload.code !== 0 || !payload.data) {
      throw new Error(payload.message || 'Could not load WeSight profile');
    }
    return payload.data;
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
