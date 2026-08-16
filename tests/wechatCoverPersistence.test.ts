vi.mock('obsidian', () => ({
  TFile: class TFile {
    path = '';
    name = '';
  },
}));

import { TFile, type App } from 'obsidian';

import { persistWeChatCover } from '../src/wechat/coverPersistence';
import type { WeChatAssetDraft } from '../src/wechat/types';

describe('WeChat cover persistence', () => {
  test('writes the cover into the Vault and stores its path in frontmatter', async () => {
    const body = new Uint8Array([137, 80, 78, 71]).buffer;
    const frontmatter: Record<string, unknown> = {};
    const coverFile = new TFile();
    coverFile.path = '附件/公众号封面.png';
    coverFile.name = '公众号封面.png';
    const getAvailablePathForAttachment = vi.fn()
      .mockResolvedValue(coverFile.path);
    const createBinary = vi.fn().mockResolvedValue(coverFile);
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, update: (value: Record<string, unknown>) => void) => {
        update(frontmatter);
      },
    );
    const app = {
      fileManager: { getAvailablePathForAttachment, processFrontMatter },
      vault: {
        createBinary,
        getResourcePath: vi.fn().mockReturnValue('app://vault/公众号封面.png'),
      },
    } as unknown as App;
    const articleFile = new TFile();
    articleFile.path = '文章/测试文章.md';
    const asset: WeChatAssetDraft = {
      token: '',
      source: '公众号封面.png',
      fileName: '公众号封面.png',
      mimeType: 'image/png',
      contentHash: '',
      body,
      previewUrl: 'blob:temporary-cover',
    };

    const persisted = await persistWeChatCover(app, articleFile, asset);

    expect(getAvailablePathForAttachment)
      .toHaveBeenCalledWith('公众号封面.png', articleFile.path);
    expect(createBinary).toHaveBeenCalledWith(coverFile.path, body);
    expect(frontmatter.cover).toBe(coverFile.path);
    expect(persisted).toMatchObject({
      vaultPath: coverFile.path,
      asset: {
        source: coverFile.path,
        fileName: coverFile.name,
        mimeType: 'image/png',
        previewUrl: 'app://vault/公众号封面.png',
      },
    });
    expect(persisted.asset.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.asset.token)
      .toBe(`wesight-wechat-asset://${persisted.asset.contentHash}`);
  });

  test('sanitizes the filename and aligns its extension with the image type', async () => {
    const getAvailablePathForAttachment = vi.fn().mockResolvedValue('bad-name.png');
    const app = {
      fileManager: {
        getAvailablePathForAttachment,
        processFrontMatter: vi.fn(),
      },
      vault: {
        createBinary: vi.fn().mockResolvedValue({ path: 'bad-name.png', name: 'bad-name.png' }),
        getResourcePath: vi.fn().mockReturnValue('app://vault/bad-name.png'),
      },
    } as unknown as App;
    const articleFile = new TFile();
    articleFile.path = '文章.md';

    await persistWeChatCover(app, articleFile, {
      token: '',
      source: '../bad:name%#.webp',
      fileName: '../bad:name%#.webp',
      mimeType: 'image/png',
      contentHash: 'a'.repeat(64),
      body: new Uint8Array([1]).buffer,
      previewUrl: 'blob:cover',
    });

    expect(getAvailablePathForAttachment)
      .toHaveBeenCalledWith('bad-name--.png', articleFile.path);
  });
});
