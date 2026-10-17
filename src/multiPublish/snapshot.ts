import type { App, TFile } from 'obsidian';

import { buildWeChatSnapshot } from '../wechat/snapshot';
import { markdownToPlatformHtml, stripLeadingPublishDecoration } from './content';
import type { MultiPublishSnapshot } from './types';

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TASK_BYTES = 100 * 1024 * 1024;

function metadataTags(frontmatter: Record<string, unknown> | undefined): string[] {
  const value = frontmatter?.tags ?? frontmatter?.标签;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
      .map(item => item.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[，,\s]+/)
      .map(item => item.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function metadataBoolean(frontmatter: Record<string, unknown> | undefined): boolean | undefined {
  const value = frontmatter?.original ?? frontmatter?.原创;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return undefined;
}

function publishAssetToken(contentHash: string): string {
  return `wesight-asset://${contentHash}`;
}

export async function buildMultiPublishSnapshot(app: App, file: TFile): Promise<MultiPublishSnapshot> {
  const source = await buildWeChatSnapshot(app, file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const warnings = source.warnings.map(warning => warning.message);
  // Different paths or URLs can contain identical bytes. The bridge identifies
  // assets by their hash, so send each binary once and keep every body reference.
  const uniqueAssets = new Map(source.assets.map(asset => [asset.contentHash, asset]));
  const assets = Array.from(uniqueAssets.values()).map(asset => ({
    id: asset.contentHash,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.body.byteLength,
    sha256: asset.contentHash,
    body: asset.body,
    vaultPath: /^https?:\/\//i.test(asset.source) ? undefined : asset.source,
    previewUrl: asset.previewUrl,
  }));
  const oversize = assets.find(asset => asset.size > MAX_ASSET_BYTES);
  if (oversize) warnings.push(`图片“${oversize.fileName}”超过 10 MB，无法加入任务`);
  const totalBytes = assets.reduce((total, asset) => total + asset.size, 0);
  if (totalBytes > MAX_TASK_BYTES) warnings.push('任务图片总大小超过 100 MB，无法启动');

  let markdown = stripLeadingPublishDecoration(source.markdown);
  for (const asset of source.assets) {
    markdown = markdown.split(asset.token).join(publishAssetToken(asset.contentHash));
  }
  const coverHash = source.coverAssetToken
    ? source.assets.find(asset => asset.token === source.coverAssetToken)?.contentHash ?? null
    : /!\[[^\]]*\]\(wesight-asset:\/\/([^\s)]+)\)/.exec(markdown)?.[1] ?? null;
  if (!coverHash) warnings.push('正文没有可用图片，部分平台需要在编辑页手动补充封面');

  return {
    sourcePath: source.sourcePath,
    contentHash: source.contentHash,
    title: source.title,
    digest: source.digest,
    markdown,
    html: markdownToPlatformHtml(markdown),
    coverAssetId: coverHash,
    tags: metadataTags(frontmatter),
    original: metadataBoolean(frontmatter),
    assets,
    warnings: Array.from(new Set(warnings)),
  };
}
