import { requestUrl, type RequestUrlParam } from 'obsidian';

import { CloudAuthRequiredError, CloudAuthService } from './cloudAuth';
import type {
  ShareSnapshot,
  ShareState,
  UploadedShareAsset,
} from './types';

const API_BASE_URL = 'https://api.wesight.ai';

interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
  error?: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class ShareCloudApi {
  constructor(private readonly auth: CloudAuthService) {}

  async getShare(shareId: string): Promise<ShareState> {
    return this.request<ShareState>({
      url: `${API_BASE_URL}/api/shares/${encodeURIComponent(shareId)}`,
    });
  }

  async createShare(
    snapshot: ShareSnapshot,
    idempotencyKey?: string,
  ): Promise<ShareState> {
    const prepared = await this.prepareSnapshot(snapshot, []);
    return this.request<ShareState>({
      url: `${API_BASE_URL}/api/shares`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(prepared),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  async updateShare(
    shareId: string,
    snapshot: ShareSnapshot,
    existingAssets: UploadedShareAsset[],
  ): Promise<ShareState> {
    const prepared = await this.prepareSnapshot(snapshot, existingAssets);
    return this.request<ShareState>({
      url: `${API_BASE_URL}/api/shares/${encodeURIComponent(shareId)}`,
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(prepared),
    });
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request<{ revoked: boolean }>({
      url: `${API_BASE_URL}/api/shares/${encodeURIComponent(shareId)}`,
      method: 'DELETE',
    });
  }

  async setCommentsEnabled(
    shareId: string,
    enabled: boolean,
  ): Promise<ShareState> {
    return this.request<ShareState>({
      url: `${API_BASE_URL}/api/shares/${encodeURIComponent(shareId)}/comments`,
      method: 'PATCH',
      contentType: 'application/json',
      body: JSON.stringify({ enabled }),
    });
  }

  private async prepareSnapshot(
    snapshot: ShareSnapshot,
    existingAssets: UploadedShareAsset[],
  ): Promise<{
    title: string;
    markdown: string;
    contentHash: string;
    assets: UploadedShareAsset[];
  }> {
    const existingByHash = new Map(existingAssets.map((asset) => [asset.contentHash, asset]));
    const assets: UploadedShareAsset[] = [];
    let markdown = snapshot.markdown;
    for (const draft of snapshot.assets) {
      const asset = existingByHash.get(draft.contentHash) ?? await this.uploadAsset(draft);
      assets.push(asset);
      markdown = markdown.split(draft.token).join(asset.url);
    }
    return {
      title: snapshot.title,
      markdown,
      contentHash: snapshot.contentHash,
      assets,
    };
  }

  private async uploadAsset(
    draft: ShareSnapshot['assets'][number],
  ): Promise<UploadedShareAsset> {
    return this.request<UploadedShareAsset>({
      url: `${API_BASE_URL}/api/shares/assets`,
      method: 'POST',
      contentType: draft.mimeType,
      body: draft.body,
      headers: {
        'x-wesight-content-hash': draft.contentHash,
        'x-wesight-file-name': encodeURIComponent(draft.fileName),
      },
    });
  }

  private async request<T>(options: RequestUrlParam, allowRefresh = true): Promise<T> {
    const token = await this.auth.getAccessToken();
    const response = await requestUrl({
      ...options,
      headers: {
        ...(options.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      throw: false,
    });
    if (response.status === 401 && allowRefresh) {
      await this.auth.refreshAccessToken();
      return this.request<T>(options, false);
    }
    const payload = response.json as ApiEnvelope<T>;
    if (response.status >= 400 || payload.code !== 0 || payload.data === undefined) {
      if (response.status === 401) {
        this.auth.clearSession();
        throw new CloudAuthRequiredError();
      }
      throw new CloudApiError(
        payload.message || 'WeSight Cloud request failed',
        response.status,
        payload.error,
        payload.data,
      );
    }
    return payload.data;
  }
}
