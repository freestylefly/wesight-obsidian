import type { ShareAssetDraft } from '../share/types';

export interface TencentDocsConnectionState {
  status: 'needs-auth' | 'connected' | 'error';
  connected: boolean;
  accountName: string | null;
  message: string | null;
}

export interface TencentDocsPublishInput {
  title: string;
  markdown: string;
  assets?: ShareAssetDraft[];
  documentId?: string;
  url?: string;
}

export interface TencentDocsDocumentResult {
  documentId: string;
  url: string;
}
