import { createHash } from 'crypto';
import path from 'path';

import type { MultiPublishSnapshot } from '../multiPublish/types';
import { buildXhsPostText, XHS_BODY_LIMIT, XHS_TITLE_LIMIT } from './copy';
import type { XhsCopyDraft, XhsGeneratedPage } from './types';

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TASK_BYTES = 100 * 1024 * 1024;

export interface XiaohongshuPublishInput {
  source: MultiPublishSnapshot;
  copy: XhsCopyDraft;
  pageCount: number;
  pages: XhsGeneratedPage[];
  readBinary: (vaultPath: string) => Promise<ArrayBuffer>;
}

export function validateXiaohongshuPublishInput(
  copy: XhsCopyDraft,
  pageCount: number,
  pages: XhsGeneratedPage[],
): string[] {
  const errors: string[] = [];
  if (!copy.title.trim()) errors.push('请先填写小红书标题');
  if (Array.from(copy.title.trim()).length > XHS_TITLE_LIMIT) {
    errors.push(`小红书标题不能超过 ${XHS_TITLE_LIMIT} 个字符`);
  }
  if (!copy.body.trim()) errors.push('请先填写小红书正文');
  if (Array.from(buildXhsPostText(copy.body, copy.tags)).length > XHS_BODY_LIMIT) {
    errors.push(`小红书正文和话题合计不能超过 ${XHS_BODY_LIMIT} 字，请精简后再同步`);
  }
  if (pages.length !== pageCount) errors.push(`请先生成完整图片（当前 ${pages.length}/${pageCount} 张）`);
  const pageNumbers = new Set(pages.map(page => page.pageNumber));
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (!pageNumbers.has(pageNumber)) errors.push(`缺少第 ${pageNumber} 张图片`);
  }
  if (pageNumbers.size !== pages.length) errors.push('图片页码存在重复，请重新生成图片');
  if (pages.some(page => !page.vaultPath.trim())) errors.push('存在未保存到仓库的图片');
  return Array.from(new Set(errors));
}

export async function buildXiaohongshuPublishSnapshot(
  input: XiaohongshuPublishInput,
): Promise<MultiPublishSnapshot> {
  const validationErrors = validateXiaohongshuPublishInput(input.copy, input.pageCount, input.pages);
  if (validationErrors.length) throw new Error(validationErrors[0]);

  const orderedPages = [...input.pages].sort((left, right) => left.pageNumber - right.pageNumber);
  const assets = [] as MultiPublishSnapshot['assets'];
  let totalBytes = 0;

  for (const page of orderedPages) {
    let body: ArrayBuffer;
    try {
      body = await input.readBinary(page.vaultPath);
    } catch {
      throw new Error(`第 ${page.pageNumber} 张图片读取失败，请重新生成或调整图片`);
    }
    if (body.byteLength <= 0) throw new Error(`第 ${page.pageNumber} 张图片为空`);
    if (body.byteLength > MAX_ASSET_BYTES) throw new Error(`第 ${page.pageNumber} 张图片超过 10 MB`);
    totalBytes += body.byteLength;
    if (totalBytes > MAX_TASK_BYTES) throw new Error('小红书图片总大小不能超过 100 MB');

    const sha256 = createHash('sha256').update(Buffer.from(body)).digest('hex');
    const id = createHash('sha256')
      .update(`${page.pageNumber}:${page.vaultPath}:${sha256}`)
      .digest('hex');
    assets.push({
      id,
      fileName: path.posix.basename(page.fileName || page.vaultPath) || `xiaohongshu-${page.pageNumber}.png`,
      mimeType: page.mimeType || 'image/png',
      size: body.byteLength,
      sha256,
      body,
    });
  }

  const title = Array.from(input.copy.title.trim()).slice(0, XHS_TITLE_LIMIT).join('');
  const markdown = input.copy.body.trim();
  const tags = input.copy.tags.map(tag => tag.replace(/^#+|#+$/g, '').trim()).filter(Boolean);
  const contentHash = createHash('sha256').update(JSON.stringify({
    sourceHash: input.source.contentHash,
    title,
    markdown,
    tags,
    assets: assets.map(asset => ({ id: asset.id, sha256: asset.sha256 })),
  })).digest('hex');

  return {
    sourcePath: input.source.sourcePath,
    contentHash,
    title,
    digest: markdown.slice(0, 120),
    markdown,
    html: `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`,
    coverAssetId: assets[0]?.id ?? null,
    tags,
    assets,
    warnings: [],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
