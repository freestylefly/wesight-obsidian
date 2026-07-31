import type { WeChatPublishState } from './types';

export const WECHAT_DRAFT_ID_FRONTMATTER_KEY = 'wesight-wechat-draft-id';
export const WECHAT_CONTENT_HASH_FRONTMATTER_KEY = 'wesight-wechat-content-hash';
export const WECHAT_PUBLISHED_AT_FRONTMATTER_KEY = 'wesight-wechat-published-at';

export const WECHAT_FRONTMATTER_KEYS = [
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  WECHAT_CONTENT_HASH_FRONTMATTER_KEY,
  WECHAT_PUBLISHED_AT_FRONTMATTER_KEY,
] as const;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseWeChatPublishState(
  frontmatter: Record<string, unknown> | null | undefined,
): WeChatPublishState | null {
  if (!frontmatter) return null;
  const draftId = stringValue(frontmatter[WECHAT_DRAFT_ID_FRONTMATTER_KEY]);
  if (!draftId) return null;
  return {
    draftId,
    contentHash: stringValue(frontmatter[WECHAT_CONTENT_HASH_FRONTMATTER_KEY]),
    updatedAt: stringValue(frontmatter[WECHAT_PUBLISHED_AT_FRONTMATTER_KEY]),
  };
}
