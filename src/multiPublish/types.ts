export const MULTI_PLATFORM_IDS = [
  'zhihu',
  'csdn',
  'juejin',
  'bilibili-article',
  'toutiao',
  'weibo-article',
  'x-article',
] as const;

export const PUBLISH_PLATFORM_IDS = [
  ...MULTI_PLATFORM_IDS,
  'xiaohongshu',
  'weibo-post',
  'jike-post',
  'x-post',
] as const;

export type MultiPlatformId = (typeof PUBLISH_PLATFORM_IDS)[number];
export type MultiPublishSelectablePlatformId = (typeof MULTI_PLATFORM_IDS)[number];

export const MULTI_PLATFORM_STATUS = [
  'queued',
  'opening',
  'login_required',
  'filling',
  'ready',
  'failed',
  'cancelled',
] as const;
export type MultiPlatformTaskStatus = (typeof MULTI_PLATFORM_STATUS)[number];

export interface MultiPublishAsset {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  body: ArrayBuffer;
  vaultPath?: string;
  previewUrl?: string;
}

export interface MultiPublishArticleV1 {
  title: string;
  digest: string;
  markdown: string;
  html: string;
  coverAssetId: string | null;
  tags: string[];
  original?: boolean;
}

export interface MultiPublishTargetOptions {
  xPost?: {
    includeTitle: boolean;
  };
  jikePost?: {
    circle: string;
  };
}

export interface MultiPublishTargetPayloadV1 {
  article: MultiPublishArticleV1;
  assetIds: string[];
  targetOptions?: MultiPublishTargetOptions;
}

export interface MultiPublishSnapshot {
  sourcePath: string;
  contentHash: string;
  title: string;
  digest: string;
  markdown: string;
  html: string;
  coverAssetId: string | null;
  tags: string[];
  original?: boolean;
  assets: MultiPublishAsset[];
  warnings: string[];
  targetOptions?: MultiPublishTargetOptions;
  targetPayloads?: Partial<Record<MultiPlatformId, MultiPublishTargetPayloadV1>>;
}

export interface PublishTaskV1 {
  protocolVersion: 1;
  taskId: string;
  createdAt: string;
  expiresAt: string;
  source: {
    vaultPath: string;
    contentHash: string;
  };
  article: MultiPublishArticleV1;
  targetOptions?: MultiPublishTargetOptions;
  targetPayloads?: Partial<Record<MultiPlatformId, MultiPublishTargetPayloadV1>>;
  assets: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    sha256: string;
  }>;
  targets: MultiPlatformId[];
  /** Present when the extension's publish center should let the user pick platforms. */
  compose?: {
    /** Omitted by earlier article handoffs. */
    kind?: 'article' | 'dynamic';
    maxTargets: number | null;
  };
  behavior: {
    finalAction: 'manual';
    groupTabs: true;
  };
}

export interface MultiPlatformTaskState {
  platformId: MultiPlatformId;
  status: MultiPlatformTaskStatus;
  message?: string;
  tabId?: number;
  draftUrl?: string;
  warnings: string[];
  occurredAt: string;
}

export interface MultiPublishTaskState {
  taskId: string;
  compose?: boolean;
  sourcePath?: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  targets: MultiPlatformId[];
  platforms: Record<MultiPlatformId, MultiPlatformTaskState>;
}

export interface MultiPublishPairing {
  clientId: string;
  secret: string;
  pairedAt: string;
}

export interface MultiPublishConnectionState {
  running: boolean;
  paired: boolean;
  connected: boolean;
  baseUrl: string | null;
  extensionVersion: string | null;
  supportedPlatforms: MultiPlatformId[] | null;
  capabilities: string[] | null;
}

export interface MultiPublishTaskEventV1 {
  protocolVersion: 1;
  taskId: string;
  platformId: MultiPlatformId;
  status: MultiPlatformTaskStatus;
  message?: string;
  tabId?: number;
  draftUrl?: string;
  warnings?: string[];
  occurredAt: string;
}
