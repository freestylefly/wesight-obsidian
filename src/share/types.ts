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
  isAdmin?: boolean;
}

export interface CloudBillingSummary {
  planName: string;
  subscriptionStatus: 'free' | 'active';
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  totalCreditsRemaining: number;
  balances: {
    free: number;
    membership: number;
    purchased: number;
  };
  membership: {
    active: boolean;
    planCode: string | null;
    planName: string | null;
    expiresAt: string | null;
  };
  creditItems: Array<{
    type: 'subscription' | 'boost' | 'free';
    label: string;
    labelEn: string;
    creditsRemaining: number;
    expiresAt: string | null;
  }>;
  publishCost: number;
  checkoutUrl: string;
}
