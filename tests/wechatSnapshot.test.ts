vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
  TFile: class TFile {},
}));

vi.mock('../src/share/snapshot', () => ({
  buildShareSnapshot: vi.fn(),
}));

import type { App } from 'obsidian';
import { requestUrl, TFile } from 'obsidian';

import { buildShareSnapshot } from '../src/share/snapshot';
import { buildWeChatSnapshot } from '../src/wechat/snapshot';

const CDN_IMAGE_URL = 'https://cdn.canghecode.com/blog/20260728152934.png';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;

describe('WeChat snapshot remote images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('captures CDN images when whitespace appears before the URL parentheses', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: 'CDN 图片测试',
      markdown: [
        `![](${CDN_IMAGE_URL})`,
        `![] (${CDN_IMAGE_URL})`,
        `![CDN 图片] (${CDN_IMAGE_URL} "说明")`,
      ].join('\n'),
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/png' },
      arrayBuffer: PNG_BYTES,
    } as never);

    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(undefined),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/CDN 图片测试.md';

    const snapshot = await buildWeChatSnapshot(app, file);
    const asset = snapshot.assets[0];

    expect(requestUrl).toHaveBeenCalledOnce();
    expect(requestUrl).toHaveBeenCalledWith({ url: CDN_IMAGE_URL, throw: false });
    expect(asset).toMatchObject({
      source: CDN_IMAGE_URL,
      fileName: '20260728152934.png',
      mimeType: 'image/png',
      previewUrl: CDN_IMAGE_URL,
    });
    expect(snapshot.markdown).toBe([
      `![](${asset.token})`,
      `![](${asset.token})`,
      `![CDN 图片](${asset.token})`,
    ].join('\n'));
    expect(snapshot.warnings).toEqual([]);
  });

  test('uses the real image type when a CDN labels PNG content as JPEG', async () => {
    const mismatchedImageUrl = 'https://cdn.canghecode.com/blog/6211738167513_.pic.jpg';
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: 'CDN 图片类型测试',
      markdown: `![](${mismatchedImageUrl})`,
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      arrayBuffer: PNG_BYTES,
    } as never);

    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(undefined),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/CDN 图片类型测试.md';

    const snapshot = await buildWeChatSnapshot(app, file);
    const asset = snapshot.assets[0];

    expect(asset).toMatchObject({
      source: mismatchedImageUrl,
      fileName: '6211738167513_.pic.png',
      mimeType: 'image/png',
      body: PNG_BYTES,
    });
    expect(snapshot.markdown).toBe(`![](${asset.token})`);
    expect(snapshot.warnings).toEqual([]);
  });
});
