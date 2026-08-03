import {
  WECHAT_ARTICLE_URL_FRONTMATTER_KEY,
  WECHAT_CONTENT_HASH_FRONTMATTER_KEY,
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  WECHAT_PUBLISHED_AT_FRONTMATTER_KEY,
  normalizeWeChatArticleUrl,
  parseWeChatPublishState,
  writeWeChatDraftFrontmatter,
} from '../src/wechat/frontmatter';
import { WECHAT_RENDERER_VERSION } from '../src/wechat/types';

describe('WeChat publishing metadata', () => {
  test('reads only the internal draft linkage fields', () => {
    expect(parseWeChatPublishState({
      [WECHAT_DRAFT_ID_FRONTMATTER_KEY]: 'draft_123',
      [WECHAT_CONTENT_HASH_FRONTMATTER_KEY]: 'a'.repeat(64),
      [WECHAT_PUBLISHED_AT_FRONTMATTER_KEY]: '2026-07-30T03:00:00.000Z',
      [WECHAT_ARTICLE_URL_FRONTMATTER_KEY]: 'https://mp.weixin.qq.com/s/article-id',
      thumb_media_id: 'wechat-secret-media-id',
    })).toEqual({
      draftId: 'draft_123',
      contentHash: 'a'.repeat(64),
      updatedAt: '2026-07-30T03:00:00.000Z',
      articleUrl: 'https://mp.weixin.qq.com/s/article-id',
    });
  });

  test('ignores incomplete metadata without a WeSight draft id', () => {
    expect(parseWeChatPublishState({
      [WECHAT_CONTENT_HASH_FRONTMATTER_KEY]: 'a'.repeat(64),
    })).toBeNull();
  });

  test('normalizes supported Official Account article links', () => {
    expect(normalizeWeChatArticleUrl('mp.weixin.qq.com/s/article-id#wechat_redirect'))
      .toBe('https://mp.weixin.qq.com/s/article-id');
    expect(normalizeWeChatArticleUrl('https://mp.weixin.qq.com/s?__biz=test&mid=1'))
      .toBe('https://mp.weixin.qq.com/s?__biz=test&mid=1');
  });

  test('rejects links outside Official Account article pages', () => {
    expect(normalizeWeChatArticleUrl('https://example.com/s/article-id')).toBeNull();
    expect(normalizeWeChatArticleUrl('https://mp.weixin.qq.com/profile')).toBeNull();
    expect(normalizeWeChatArticleUrl('https://mp.weixin.qq.com.evil.test/s/article-id')).toBeNull();
  });

  test('clears a published link when a different draft replaces the current draft', () => {
    const frontmatter: Record<string, unknown> = {
      [WECHAT_DRAFT_ID_FRONTMATTER_KEY]: 'draft_old',
      [WECHAT_ARTICLE_URL_FRONTMATTER_KEY]: 'https://mp.weixin.qq.com/s/article-id',
    };
    writeWeChatDraftFrontmatter(frontmatter, {
      draftId: 'draft_new',
      contentHash: 'b'.repeat(64),
      updatedAt: '2026-08-02T01:00:00.000Z',
    });
    expect(frontmatter[WECHAT_ARTICLE_URL_FRONTMATTER_KEY]).toBeUndefined();
  });

  test('keeps a published link when the same draft is updated', () => {
    const frontmatter: Record<string, unknown> = {
      [WECHAT_DRAFT_ID_FRONTMATTER_KEY]: 'draft_123',
      [WECHAT_ARTICLE_URL_FRONTMATTER_KEY]: 'https://mp.weixin.qq.com/s/article-id',
    };
    writeWeChatDraftFrontmatter(frontmatter, {
      draftId: 'draft_123',
      contentHash: 'c'.repeat(64),
      updatedAt: '2026-08-02T02:00:00.000Z',
    });
    expect(frontmatter[WECHAT_ARTICLE_URL_FRONTMATTER_KEY])
      .toBe('https://mp.weixin.qq.com/s/article-id');
  });

  test('pins the first renderer contract', () => {
    expect(WECHAT_RENDERER_VERSION).toBe('canghe-style-wechat-v2');
  });
});
