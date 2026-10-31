vi.mock('obsidian', () => ({ TFile: class TFile {}, normalizePath: (value: string) => value }));

import { TFile, type App } from 'obsidian';

import { buildShareSnapshot } from '../src/share/snapshot';

function fixture(markdown: string, imagePaths: string[]) {
  const images = new Map(imagePaths.map((imagePath) => {
    const image = new TFile();
    image.path = imagePath;
    image.extension = imagePath.split('.').pop() ?? '';
    image.basename = imagePath.slice(imagePath.lastIndexOf('/') + 1, imagePath.lastIndexOf('.'));
    return [imagePath, image] as const;
  }));
  const file = new TFile();
  file.path = '文章/测试.md';
  file.basename = '测试';
  const resolve = vi.fn((target: string) => images.get(target) ?? null);
  const app = {
    vault: { read: async () => markdown, readBinary: async () => new Uint8Array([1, 2, 3]).buffer },
    metadataCache: { getFileCache: () => undefined, getFirstLinkpathDest: resolve },
  } as unknown as App;
  return { app, file, resolve };
}

describe('share snapshot images', () => {
  test('uploads angle-wrapped paths containing spaces and parentheses without leaving local links', async () => {
    const { app, file, resolve } = fixture(
      '前文\n![截图](<附件/截图 2026 (1).png> "图片标题")\n后文',
      ['附件/截图 2026 (1).png'],
    );
    const snapshot = await buildShareSnapshot(app, file);

    expect(resolve).toHaveBeenCalledWith('附件/截图 2026 (1).png', file.path);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.assets[0].fileName).toBe('截图 2026 (1).png');
    expect(snapshot.markdown).toBe(`前文\n![截图](${snapshot.assets[0].token})\n后文`);
    expect(snapshot.warnings).toEqual([]);
  });

  test('resolves URL-encoded spaces and balanced or escaped parentheses', async () => {
    const { app, file } = fixture(
      '![一](附件/截图%20(1).png)\n![二](附件/截图%20\\(2\\).png)',
      ['附件/截图 (1).png', '附件/截图 (2).png'],
    );
    const snapshot = await buildShareSnapshot(app, file);

    expect(snapshot.assets.map(asset => asset.fileName)).toEqual(['截图 (1).png', '截图 (2).png']);
    expect(snapshot.markdown).toBe(`![一](${snapshot.assets[0].token})\n![二](${snapshot.assets[1].token})`);
    expect(snapshot.warnings).toEqual([]);
  });

  test('keeps literal percent signs usable in Markdown and wiki image filenames', async () => {
    const { app, file } = fixture('![统计](附件/100%.png)\n![[附件/完成50%.png]]', ['附件/100%.png', '附件/完成50%.png']);
    const snapshot = await buildShareSnapshot(app, file);

    expect(snapshot.assets.map(asset => asset.fileName).sort()).toEqual(['100%.png', '完成50%.png']);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.markdown).not.toContain('附件/');
  });

  test('preserves remote images and unresolved paths while reporting only missing local images', async () => {
    const { app, file, resolve } = fixture('![远程](<https://example.com/a.png>)\n![缺失](<附件/缺失 (1).png>)', []);
    const snapshot = await buildShareSnapshot(app, file);

    expect(snapshot.assets).toEqual([]);
    expect(snapshot.markdown).toContain('![远程](<https://example.com/a.png>)');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(snapshot.warnings).toEqual(['图片“<附件/缺失 (1).png>”无法解析，线上文章将保留原始链接']);
  });
});
