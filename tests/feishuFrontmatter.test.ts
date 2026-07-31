import {
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
  parseFeishuPublishState,
} from '../src/feishu/frontmatter';

describe('Feishu frontmatter', () => {
  test('reads the linked document state', () => {
    expect(parseFeishuPublishState({
      [FEISHU_DOC_ID_FRONTMATTER_KEY]: 'doxcn123',
      [FEISHU_DOC_URL_FRONTMATTER_KEY]: 'https://example.feishu.cn/docx/doxcn123',
      [FEISHU_CONTENT_HASH_FRONTMATTER_KEY]: 'sha256',
      [FEISHU_PUBLISHED_AT_FRONTMATTER_KEY]: '2026-07-30T01:00:00.000Z',
      [FEISHU_TITLE_FRONTMATTER_KEY]: 'Shared note',
    })).toEqual({
      documentId: 'doxcn123',
      url: 'https://example.feishu.cn/docx/doxcn123',
      contentHash: 'sha256',
      updatedAt: '2026-07-30T01:00:00.000Z',
      title: 'Shared note',
    });
  });

  test('ignores incomplete state without a document id', () => {
    expect(parseFeishuPublishState({
      [FEISHU_DOC_URL_FRONTMATTER_KEY]: 'https://example.feishu.cn/docx/doxcn123',
    })).toBeNull();
  });
});
