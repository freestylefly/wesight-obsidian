export const WECHAT_RENDERER_VERSION = 'canghe-style-wechat-v2';

export interface WeChatConnectionState {
  id: string;
  displayName: string;
  appId: string;
  verified: boolean;
  defaultCoverMediaId: string | null;
  egressIp: string | null;
  lastVerifiedAt: string | null;
  updatedAt: string;
}

export interface WeChatServiceInfo {
  egressIp: string | null;
  configured: boolean;
}

export interface WeChatAssetDraft {
  token: string;
  source: string;
  fileName: string;
  mimeType: string;
  contentHash: string;
  body: ArrayBuffer;
  previewUrl: string;
}

export interface WeChatWarning {
  code: string;
  message: string;
  blocking: boolean;
}

export interface WeChatPreviewSnapshot {
  sourcePath: string;
  title: string;
  author: string;
  digest: string;
  contentSourceUrl: string;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  markdown: string;
  contentHash: string;
  assets: WeChatAssetDraft[];
  warnings: WeChatWarning[];
  thumbMediaId: string;
  coverAssetToken: string | null;
  rendererVersion: typeof WECHAT_RENDERER_VERSION;
}

export interface WeChatDraftState {
  id: string;
  title: string;
  contentHash: string;
  status: string;
  syncedAt: string;
  updatedAt: string;
}

export interface UploadedWeChatAsset {
  kind: 'content' | 'cover';
  url?: string;
  mediaId?: string;
  connection?: WeChatConnectionState;
}

export interface WeChatDraftPayload {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  contentHash: string;
  thumbMediaId: string;
  contentSourceUrl?: string;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
}

export interface WeChatPublishState {
  draftId: string;
  contentHash: string;
  updatedAt: string;
}
