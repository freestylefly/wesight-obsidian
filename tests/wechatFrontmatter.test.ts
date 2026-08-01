import {
  WECHAT_CONTENT_HASH_FRONTMATTER_KEY,
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  WECHAT_PUBLISHED_AT_FRONTMATTER_KEY,
  parseWeChatPublishState,
} from '../src/wechat/frontmatter';
import { WECHAT_RENDERER_VERSION } from '../src/wechat/types';

describe('WeChat publishing metadata', () => {
  test('reads only the internal draft linkage fields', () => {
    expect(parseWeChatPublishState({
      [WECHAT_DRAFT_ID_FRONTMATTER_KEY]: 'draft_123',
      [WECHAT_CONTENT_HASH_FRONTMATTER_KEY]: 'a'.repeat(64),
      [WECHAT_PUBLISHED_AT_FRONTMATTER_KEY]: '2026-07-30T03:00:00.000Z',
      thumb_media_id: 'wechat-secret-media-id',
    })).toEqual({
      draftId: 'draft_123',
      contentHash: 'a'.repeat(64),
      updatedAt: '2026-07-30T03:00:00.000Z',
    });
  });

  test('ignores incomplete metadata without a WeSight draft id', () => {
    expect(parseWeChatPublishState({
      [WECHAT_CONTENT_HASH_FRONTMATTER_KEY]: 'a'.repeat(64),
    })).toBeNull();
  });

  test('pins the first renderer contract', () => {
    expect(WECHAT_RENDERER_VERSION).toBe('canghe-style-wechat-v2');
  });
});
