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
  error?: string;
}

interface WeChatUploadTicket {
  uploadUrl: string;
  uploadToken: string;
  expiresAt: string;
}

interface GatewayUploadEnvelope {
  ok?: boolean;
  data?: {
    url?: string;
    media_id?: string;
  };
  message?: string;
  errcode?: number;
}

function directUploadErrorMessage(message: string | undefined): string {
  if (message === 'invalid_upload_token' || message === 'upload_token_expired') {
    return '图片上传凭证已失效，请重试';
  }
  if (message === 'invalid_file_size' || message === 'request_too_large') {
    return '图片为空或超过 10 MB 限制';
  }
  if (message === 'invalid_mime_type' || message === 'invalid_file') {
    return '图片内容与文件类型不一致';
  }
  return message || '阿里云图片网关上传失败';
}

function normalizeWeChatImageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudApiError('微信返回的正文图片地址无效', 502);
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') {
    throw new CloudApiError('微信返回的正文图片地址不安全', 502);
  }
  return url.toString();
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

  async uploadAsset(
    kind: 'content' | 'cover',
    asset: WeChatAssetDraft,
  ): Promise<UploadedWeChatAsset> {
    const ticket = await this.request<WeChatUploadTicket>({
      url: `${API_BASE_URL}/api/wechat/assets/ticket`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        kind,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        contentLength: asset.body.byteLength,
      }),
    });
    const response = await requestUrl({
      url: ticket.uploadUrl,
      method: 'POST',
      contentType: asset.mimeType,
      body: asset.body,
      headers: {
        'x-wesight-upload-token': ticket.uploadToken,
      },
      throw: false,
    });
    let payload: GatewayUploadEnvelope = {};
    try {
      payload = response.json as GatewayUploadEnvelope;
    } catch {
      payload = {};
    }
    if (response.status >= 400 || !payload.ok || !payload.data) {
      const suffix = payload.errcode ? `（微信错误码 ${payload.errcode}）` : '';
      throw new CloudApiError(
        `${directUploadErrorMessage(payload.message)}${suffix}`,
        response.status,
      );
    }
    if (kind === 'content') {
      if (!payload.data.url) throw new CloudApiError('微信未返回正文图片地址', 502);
      return { kind, url: normalizeWeChatImageUrl(payload.data.url) };
    }
    if (!payload.data.media_id) throw new CloudApiError('微信未返回封面素材 ID', 502);
    return this.request({
      url: `${API_BASE_URL}/api/wechat/assets/complete`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ mediaId: payload.data.media_id }),
    });
  }

  getDraft(draftId: string): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts/${encodeURIComponent(draftId)}`,
    });
  }

  createDraft(payload: WeChatDraftPayload, idempotencyKey?: string): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(payload),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  updateDraft(
    draftId: string,
    payload: WeChatDraftPayload,
    idempotencyKey?: string,
  ): Promise<WeChatDraftState> {
    return this.request({
      url: `${API_BASE_URL}/api/wechat/drafts/${encodeURIComponent(draftId)}`,
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(payload),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
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
        payload.message || '公众号服务请求失败',
        response.status,
        payload.error,
        payload.data,
      );
    }
    return payload.data;
  }
}
