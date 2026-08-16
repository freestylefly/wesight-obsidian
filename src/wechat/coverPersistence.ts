import { createHash } from 'crypto';
import path from 'path';
import type { App, TFile } from 'obsidian';

import type { WeChatAssetDraft } from './types';

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface PersistedWeChatCover {
  asset: WeChatAssetDraft;
  vaultPath: string;
}

function coverFileName(asset: WeChatAssetDraft): string {
  const extension = IMAGE_MIME_TO_EXTENSION[asset.mimeType];
  if (!extension) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 封面。');

  const original = path.posix.basename(asset.fileName.replace(/\\/g, '/'));
  const currentExtension = path.posix.extname(original);
  const rawStem = currentExtension ? original.slice(0, -currentExtension.length) : original;
  const printableStem = Array.from(rawStem, character => (
    character.charCodeAt(0) <= 31 ? '-' : character
  )).join('');
  const stem = printableStem
    .replace(/[#%<>:"/\\|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100) || 'article-cover';
  return `${stem}${extension}`;
}

export async function persistWeChatCover(
  app: App,
  articleFile: TFile,
  asset: WeChatAssetDraft,
): Promise<PersistedWeChatCover> {
  if (!asset.body.byteLength) throw new Error('封面图片为空。');

  const fileName = coverFileName(asset);
  const vaultPath = await app.fileManager.getAvailablePathForAttachment(
    fileName,
    articleFile.path,
  );
  const coverFile = await app.vault.createBinary(vaultPath, asset.body);
  await app.fileManager.processFrontMatter(articleFile, (frontmatter: Record<string, unknown>) => {
    frontmatter.cover = coverFile.path;
  });

  const contentHash = asset.contentHash || createHash('sha256')
    .update(Buffer.from(asset.body))
    .digest('hex');
  return {
    vaultPath: coverFile.path,
    asset: {
      ...asset,
      token: `wesight-wechat-asset://${contentHash}`,
      source: coverFile.path,
      fileName: coverFile.name,
      contentHash,
      previewUrl: app.vault.getResourcePath(coverFile),
    },
  };
}
