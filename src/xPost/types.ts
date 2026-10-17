export interface XPostCopyDraft {
  body: string;
  topics: string[];
}

export interface XPostImage {
  id: string;
  vaultPath: string;
  fileName: string;
  mimeType: string;
  size?: number;
}
