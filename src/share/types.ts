export interface ShareAssetDraft {
  token: string;
  vaultPath: string;
  fileName: string;
  mimeType: string;
  contentHash: string;
  body: ArrayBuffer;
}

export interface ShareSnapshot {
  title: string;
  markdown: string;
  contentHash: string;
  assets: ShareAssetDraft[];
  warnings: string[];
}

export interface UploadedShareAsset {
  contentHash: string;
  url: string;
  pathname: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ShareState {
  id: string;
  slug: string;
  url: string;
  title: string;
  contentHash: string;
  commentsEnabled: boolean;
  commentCount: number;
  enabled: boolean;
  publishedAt: string;
  updatedAt: string;
  assets: UploadedShareAsset[];
}

export interface CloudUser {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
}
