import { describe, expect, test, vi } from 'vitest';

import type { MultiPublishSnapshot } from '../src/multiPublish/types';
import { buildQuickPublishBatchSnapshot } from '../src/quickTransform/publish';
import { buildXPostPublishSnapshot, X_POST_IMAGE_BYTES } from '../src/xPost/publish';

const source = { sourcePath: '文章.md', title: '很长的原始文章标题', contentHash: 'source-hash' } as MultiPublishSnapshot;
const images = ['one.gif', 'two.png', 'three.jpg', 'four.webp', 'five.png', 'six.png'].map((fileName, index) => ({
  id: String(index), vaultPath: fileName, fileName,
  mimeType: index === 0 ? 'image/gif' : index === 2 ? 'image/jpeg' : index === 3 ? 'image/webp' : 'image/png',
}));

describe('X quick transform snapshot', () => {
  test('exports X-only copy and first four supported images without leaking article titles or changing other selections', async () => {
    const readBinary = vi.fn(async (name: string) => new TextEncoder().encode(name).buffer);
    const result = await buildXPostPublishSnapshot({ source, copy: { body: '独立 X 短文案。', topics: ['AI'] }, images, readBinary });
    expect(result.markdown).toBe('独立 X 短文案。');
    expect(result.targetOptions).toEqual({ xPost: { includeTitle: false } });
    expect(result.assets.map(asset => asset.fileName)).toEqual(['two.png', 'three.jpg', 'four.webp', 'five.png']);
    expect(readBinary.mock.calls.map(call => call[0])).toEqual(['two.png', 'three.jpg', 'four.webp', 'five.png']);
    expect(result.warnings).toHaveLength(2);
    expect(images).toHaveLength(6);
    const batch = buildQuickPublishBatchSnapshot(['x-post', 'jike-post'], {
      'x-post': result,
      'jike-post': { ...result, markdown: '即刻的长文案', targetOptions: { jikePost: { circle: 'AI 探索站' } } },
    });
    expect(batch.targetPayloads?.['x-post']?.targetOptions?.xPost?.includeTitle).toBe(false);
    expect(batch.targetPayloads?.['x-post']?.article.markdown).toBe('独立 X 短文案。');
    expect(batch.targetPayloads?.['jike-post']?.article.markdown).toBe('即刻的长文案');
  });

  test('rejects overlong edited text before binary reads and checks actual image bytes', async () => {
    const readBinary = vi.fn(async () => new ArrayBuffer(X_POST_IMAGE_BYTES + 1));
    await expect(buildXPostPublishSnapshot({ source, copy: { body: '长'.repeat(141), topics: [] }, images, readBinary })).rejects.toThrow('280');
    expect(readBinary).not.toHaveBeenCalled();
    await expect(buildXPostPublishSnapshot({ source, copy: { body: '完整短句。', topics: [] }, images, readBinary })).rejects.toThrow('5 MB');
  });
});
