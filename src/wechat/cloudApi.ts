import { requestUrl, type RequestUrlParam } from 'obsidian';

import { CloudApiError } from '../share/cloudApi';
import { CloudAuthRequiredError, CloudAuthService } from '../share/cloudAuth';
import type {
  UploadedWeChatAsset,
  WeChatAssetDraft,
  WeChatConnectionState,
  WeChatDraftPayload,
  WeChatDraftState,
  WeChatServiceInfo,
} from './types';

const API_BASE_URL = 'https://api.wesight.ai';

interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

export class WeChatCloudApi {
  constructor(private readonly auth: CloudAuthService) {}

  getConnection(): Promise<WeChatConnectionState | null> {
    return this.request({
      url: `${API_BASE_URL}/api/integrations/wechat`,
    });
  }

  getServiceInfo(): Promise<WeChatServiceInfo> {
    return this.request({
      url: `${API_BASE_URL}/api/integrations/wechat/egress`,
    });
  }

  saveConnection(input: {
    displayName: string;
    appId: string;
    appSecret?: string;
  }): Promise<WeChatConnectionState> {
    return this.request({
      url: `${API_BASE_URL}/api/integrations/wechat`,
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(input),
    });
  }

  verifyConnection(): Promise<WeChatConnectionState> {
    return this.request({
      url: `${API_BASE_URL}/api/integrations/wechat/verify`,
      method: 'POST',
    });
  }

  async deleteConnection(): Promise<void> {
    await this.request({
      url: `${API_BASE_URL}/api/integrations/wechat`,
      method: 'DELETE',
    });
  }

  uploadAsset(kind: 'content' | 'cover', asset: WeChatAssetDraft): Promise<UploadedWeChatAsset> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/assets`,
      method: 'POST',
      contentType: asset.mimeType,
      body: asset.body,
      headers: {
        'x-wesight-wechat-kind': kind,
        'x-wesight-file-name': encodeURIComponent(asset.fileName),
      },
    });
  }

  getDraft(draftId: string): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts/${encodeURIComponent(draftId)}`,
    });
  }

  createDraft(payload: WeChatDraftPayload): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  }

  updateDraft(draftId: string, payload: WeChatDraftPayload): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts/${encodeURIComponent(draftId)}`,
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(payload),
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
      throw new CloudApiError(payload.message || '公众号服务请求失败', response.status);
    }
    return payload.data;
  }
}
