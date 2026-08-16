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
import { buildWeChatSnapshot, withWeChatSnapshotCover } from '../src/wechat/snapshot';
import type { WeChatPreviewSnapshot } from '../src/wechat/types';

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

  test('restores a persisted cover from the article frontmatter', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '封面恢复测试',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    const coverFile = new TFile();
    coverFile.path = '附件/公众号封面.png';
    coverFile.name = '公众号封面.png';
    coverFile.extension = 'png';
    const getFirstLinkpathDest = vi.fn().mockReturnValue(coverFile);
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: { cover: coverFile.path },
        }),
        getFirstLinkpathDest,
      },
      vault: {
        readBinary: vi.fn().mockResolvedValue(PNG_BYTES),
        getResourcePath: vi.fn().mockReturnValue('app://vault/公众号封面.png'),
      },
    } as unknown as App;
    const articleFile = new TFile();
    articleFile.path = '文章/封面恢复测试.md';

    const snapshot = await buildWeChatSnapshot(app, articleFile);

    expect(getFirstLinkpathDest)
      .toHaveBeenCalledWith(coverFile.path, articleFile.path);
    expect(snapshot.coverAssetToken).toBe(snapshot.assets[0].token);
    expect(snapshot.assets[0]).toMatchObject({
      source: coverFile.path,
      fileName: coverFile.name,
      mimeType: 'image/png',
      previewUrl: 'app://vault/公众号封面.png',
    });
    expect(snapshot.warnings).toEqual([]);
  });

  test('updates the current snapshot after a cover is persisted', () => {
    const contentToken = `wesight-wechat-asset://${'a'.repeat(64)}`;
    const oldCoverToken = `wesight-wechat-asset://${'b'.repeat(64)}`;
    const newCoverToken = `wesight-wechat-asset://${'c'.repeat(64)}`;
    const snapshot: WeChatPreviewSnapshot = {
      sourcePath: '文章/测试.md',
      title: '测试',
      author: '',
      digest: '',
      contentSourceUrl: '',
      markdown: `![正文图片](${contentToken})`,
      contentHash: 'old-content-hash',
      themeSourceHash: 'old-theme-hash',
      assets: [
        {
          token: contentToken,
          source: '附件/正文.png',
          fileName: '正文.png',
          mimeType: 'image/png',
          contentHash: 'a'.repeat(64),
          body: PNG_BYTES,
          previewUrl: 'app://vault/正文.png',
        },
        {
          token: oldCoverToken,
          source: '附件/旧封面.png',
          fileName: '旧封面.png',
          mimeType: 'image/png',
          contentHash: 'b'.repeat(64),
          body: PNG_BYTES,
          previewUrl: 'app://vault/旧封面.png',
        },
      ],
      warnings: [{ code: 'cover', message: '旧封面无法读取', blocking: true }],
      thumbMediaId: '',
      coverAssetToken: oldCoverToken,
      rendererVersion: 'canghe-style-wechat-v2',
    };

    const updated = withWeChatSnapshotCover(snapshot, {
      token: newCoverToken,
      source: '附件/新封面.png',
      fileName: '新封面.png',
      mimeType: 'image/png',
      contentHash: 'c'.repeat(64),
      body: PNG_BYTES,
      previewUrl: 'app://vault/新封面.png',
    });

    expect(updated.coverAssetToken).toBe(newCoverToken);
    expect(updated.assets.map(asset => asset.token)).toEqual([contentToken, newCoverToken]);
    expect(updated.warnings).toEqual([]);
    expect(updated.contentHash).not.toBe(snapshot.contentHash);
    expect(updated.themeSourceHash).not.toBe(snapshot.themeSourceHash);
  });
});
