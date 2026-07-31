import type { FeishuPublishState } from './types';

export const FEISHU_DOC_ID_FRONTMATTER_KEY = 'wesight-feishu-doc-id';
export const FEISHU_DOC_URL_FRONTMATTER_KEY = 'wesight-feishu-doc-url';
export const FEISHU_CONTENT_HASH_FRONTMATTER_KEY = 'wesight-feishu-content-hash';
export const FEISHU_PUBLISHED_AT_FRONTMATTER_KEY = 'wesight-feishu-published-at';
export const FEISHU_TITLE_FRONTMATTER_KEY = 'wesight-feishu-title';

export const FEISHU_FRONTMATTER_KEYS = [
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
] as const;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseFeishuPublishState(
  frontmatter: Record<string, unknown> | null | undefined,
): FeishuPublishState | null {
  if (!frontmatter) return null;
  const documentId = stringValue(frontmatter[FEISHU_DOC_ID_FRONTMATTER_KEY]);
  if (!documentId) return null;
  return {
    documentId,
    url: stringValue(frontmatter[FEISHU_DOC_URL_FRONTMATTER_KEY]),
    contentHash: stringValue(frontmatter[FEISHU_CONTENT_HASH_FRONTMATTER_KEY]),
    updatedAt: stringValue(frontmatter[FEISHU_PUBLISHED_AT_FRONTMATTER_KEY]),
    title: stringValue(frontmatter[FEISHU_TITLE_FRONTMATTER_KEY]),
  };
}
