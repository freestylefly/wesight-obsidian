import { createHash } from 'crypto';
import path from 'path';

import type { MultiPublishSnapshot } from '../multiPublish/types';
import { buildXPostText, normalizeXPostTopics, validateXPostCopy } from './copy';
import type { XPostCopyDraft, XPostImage } from './types';

export const X_POST_MAX_IMAGES = 4;
export const X_POST_IMAGE_BYTES = 5 * 1024 * 1024;

export function selectXPostImages<T extends XPostImage>(images: T[]): { images: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const supported = images.filter(image => {
    const mime = image.mimeType.toLowerCase().split(';')[0].trim();
    const valid = ['image/png', 'image/jpeg', 'image/webp'].includes(mime);
    if (!valid) warnings.push(`X 已跳过不支持的图片“${image.fileName}”`);
    return valid;
  });
  if (supported.length > X_POST_MAX_IMAGES) warnings.push('X 仅使用前 4 张支持的图片，其余平台保留全部已选图片');
  return { images: supported.slice(0, X_POST_MAX_IMAGES), warnings };
}

export async function buildXPostPublishSnapshot(input: {
  source: MultiPublishSnapshot;
  copy: XPostCopyDraft;
  images: XPostImage[];
  readBinary: (reference: string) => Promise<ArrayBuffer>;
}): Promise<MultiPublishSnapshot> {
  const error = validateXPostCopy(input.copy);
  if (error) throw new Error(error);
  const selected = selectXPostImages(input.images);
  const assets: MultiPublishSnapshot['assets'] = [];
  for (const image of selected.images) {
    if (image.size && image.size > X_POST_IMAGE_BYTES) throw new Error(`X 配图“${image.fileName}”超过 5 MB`);
    let body: ArrayBuffer;
    try {
      body = await input.readBinary(image.vaultPath);
    } catch {
      throw new Error(`X 配图“${image.fileName}”读取失败，请重新选择`);
    }
    if (!body.byteLength) throw new Error(`X 配图“${image.fileName}”为空`);
    if (body.byteLength > X_POST_IMAGE_BYTES) throw new Error(`X 配图“${image.fileName}”超过 5 MB`);
    const sha256 = createHash('sha256').update(Buffer.from(body)).digest('hex');
    if (assets.some(asset => asset.sha256 === sha256)) {
      selected.warnings.push(`X 已合并重复图片“${image.fileName}”`);
      continue;
    }
    assets.push({
      id: sha256, sha256, body, size: body.byteLength,
      fileName: path.posix.basename(image.fileName) || 'x-post.png',
      mimeType: image.mimeType, vaultPath: image.vaultPath,
    });
  }
  const markdown = input.copy.body.trim().normalize('NFC');
  const tags = normalizeXPostTopics(input.copy.topics);
  const text = buildXPostText(markdown, tags);
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    sourcePath: input.source.sourcePath,
    contentHash: createHash('sha256').update(JSON.stringify({ source: input.source.contentHash, text, assets: assets.map(asset => asset.sha256) })).digest('hex'),
    title: 'X 动态', digest: markdown, markdown,
    html: `<p>${escaped.replace(/\n/g, '<br>')}</p>`,
    tags, coverAssetId: assets[0]?.id ?? null, assets,
    warnings: selected.warnings,
    targetOptions: { xPost: { includeTitle: false } },
  };
}
