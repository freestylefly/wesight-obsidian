export type FeishuCapabilityId = 'im' | 'docs' | 'base' | 'calendar' | 'drive';

export type FeishuCliStatus = 'missing' | 'ready';

export type FeishuAuthorizationMode = 'all';

export interface LarkAuthorizationRecord {
  authorizationMode: FeishuAuthorizationMode;
  scopeVersion: number;
  cliVersion: string | null;
  authorizedAt: string;
}

export interface FeishuCapabilityState {
  id: FeishuCapabilityId;
  label: string;
  description: string;
  granted: boolean;
  verified: boolean;
  error?: string;
}

export type FeishuConnectionStatus =
  | 'missing-cli'
  | 'needs-config'
  | 'needs-auth'
  | 'admin-action-required'
  | 'connected'
  | 'error';

export interface FeishuConnectionState {
  status: FeishuConnectionStatus;
  cliPath: string | null;
  cliVersion: string | null;
  cliStatus: FeishuCliStatus;
  configured: boolean;
  connected: boolean;
  authorizationMode: FeishuAuthorizationMode | null;
  permissionsComplete: boolean;
  authorizedAt: string | null;
  accountName: string | null;
  accountOpenId: string | null;
  tenantName: string | null;
  capabilities: Record<FeishuCapabilityId, FeishuCapabilityState>;
  consoleUrl: string | null;
  message: string | null;
}

export interface FeishuAssetDraft {
  placeholder: string;
  vaultPath: string;
  fileName: string;
  mimeType: string;
  contentHash: string;
  alt: string;
}

export interface FeishuSnapshot {
  title: string;
  markdown: string;
  contentHash: string;
  assets: FeishuAssetDraft[];
  warnings: string[];
  vaultBasePath: string;
}

export interface FeishuPublishState {
  documentId: string;
  url: string;
  contentHash: string;
  updatedAt: string;
  title: string;
}

export type FeishuAuthPhase =
  | 'idle'
  | 'detecting'
  | 'configuring'
  | 'waiting-auth'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface FeishuAuthProgress {
  phase: FeishuAuthPhase;
  message: string;
  detail?: string;
  verificationUrl?: string;
  qrCodeDataUrl?: string;
  expiresAt?: string;
  consoleUrl?: string;
}

export interface FeishuDocumentResult {
  documentId: string;
  url: string;
}

export interface FeishuFolderResult {
  folderToken: string;
  url: string | null;
}
