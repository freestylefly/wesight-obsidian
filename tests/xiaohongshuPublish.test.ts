import { describe, expect, test, vi } from 'vitest';

import type { MultiPublishSnapshot } from '../src/multiPublish/types';
import {
  buildXiaohongshuPublishSnapshot,
  validateXiaohongshuPublishInput,
} from '../src/xiaohongshu/publish';
import type { XhsCopyDraft, XhsGeneratedPage } from '../src/xiaohongshu/types';

const source: MultiPublishSnapshot = {
  sourcePath: '文章/测试.md',
  contentHash: 'a'.repeat(64),
  title: '原始标题',
  digest: '',
  markdown: '原始正文',
  html: '<p>原始正文</p>',
  coverAssetId: null,
  tags: [],
  assets: [],
  warnings: [],
};

const copy: XhsCopyDraft = {
  title: '小红书发布助手',
  body: '这是准备填入小红书编辑器的正文。',
  tags: ['AI工具', '#效率#'],
};

function page(pageNumber: number): XhsGeneratedPage {
  return {
    id: `page-${pageNumber}`,
    type: 'image',
    vaultPath: `.wesight/xiaohongshu/page-${pageNumber}.png`,
    mimeType: 'image/png',
    createdAt: 1,
    pageNumber,
    label: pageNumber === 1 ? '封面' : `第 ${pageNumber} 页`,
  };
}

describe('xiaohongshu publish snapshot', () => {
  test('orders generated pages, uses the first page as cover, and keeps copy fields separate', async () => {
    const readBinary = vi.fn(async (vaultPath: string) => (
      new Uint8Array([Number(vaultPath.match(/(\d+)/)?.[1] ?? 0)]).buffer
    ));
    const snapshot = await buildXiaohongshuPublishSnapshot({
      source,
      copy,
      pageCount: 3,
      pages: [page(3), page(1), page(2)],
      readBinary,
    });

    expect(snapshot.assets.map(asset => asset.fileName)).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);
    expect(snapshot.coverAssetId).toBe(snapshot.assets[0]?.id);
    expect(snapshot.markdown).toBe(copy.body);
    expect(snapshot.tags).toEqual(['AI工具', '效率']);
    expect(snapshot.assets.every(asset => asset.id.length === 64 && asset.sha256.length === 64)).toBe(true);
  });

  test('blocks incomplete images, blank copy, duplicate pages, and long titles', () => {
    const errors = validateXiaohongshuPublishInput({
      title: '这是一个超过二十个字符的小红书标题需要阻止发布',
      body: '',
      tags: [],
    }, 3, [page(1), page(1)]);

    expect(errors.join(' ')).toContain('标题不能超过 20 个字符');
    expect(errors.join(' ')).toContain('请先填写小红书正文');
    expect(errors.join(' ')).toContain('当前 2/3 张');
    expect(errors.join(' ')).toContain('缺少第 2 张图片');
    expect(errors.join(' ')).toContain('页码存在重复');
  });

  test('reports unreadable image files before creating a task', async () => {
    await expect(buildXiaohongshuPublishSnapshot({
      source,
      copy,
      pageCount: 1,
      pages: [page(1)],
      readBinary: async () => { throw new Error('missing'); },
    })).rejects.toThrow('第 1 张图片读取失败');
  });

  test('counts Unicode text, topic markers, spaces and blank lines against the 1000-character limit', async () => {
    // Two blank lines, #AI, one space and #效率 use nine characters.
    const atLimit = { ...copy, body: '😀'.repeat(991), tags: ['AI', '效率'] };
    expect(validateXiaohongshuPublishInput(atLimit, 1, [page(1)])).toEqual([]);
    const tooLong = { ...atLimit, body: `${atLimit.body}字` };
    expect(validateXiaohongshuPublishInput(tooLong, 1, [page(1)]).join(' ')).toContain('正文和话题合计不能超过 1000 字');
    const readBinary = vi.fn(async () => new Uint8Array([1]).buffer);
    await expect(buildXiaohongshuPublishSnapshot({ source, copy: tooLong, pageCount: 1, pages: [page(1)], readBinary }))
      .rejects.toThrow('正文和话题合计不能超过 1000 字');
    expect(readBinary).not.toHaveBeenCalled();
    expect(tooLong.body).toBe(`${atLimit.body}字`);
  });
});
