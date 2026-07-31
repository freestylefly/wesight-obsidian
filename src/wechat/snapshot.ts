import { createHash } from 'crypto';
import path from 'path';
import { App, requestUrl, TFile } from 'obsidian';

import { buildShareSnapshot } from '../share/snapshot';
import type { ShareAssetDraft } from '../share/types';
import {
  WECHAT_RENDERER_VERSION,
  type WeChatAssetDraft,
  type WeChatPreviewSnapshot,
  type WeChatWarning,
} from './types';

const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function hashBytes(value: ArrayBuffer | string): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex');
}

function stringMetadata(
  frontmatter: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = frontmatter?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function booleanMetadata(
  frontmatter: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = frontmatter?.[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
  }
  return undefined;
}

function assetToken(contentHash: string): string {
  return `wesight-wechat-asset://${contentHash}`;
}

function localAsset(app: App, draft: ShareAssetDraft): WeChatAssetDraft {
  const target = app.vault.getAbstractFileByPath(draft.vaultPath);
  return {
    token: assetToken(draft.contentHash),
    source: draft.vaultPath,
    fileName: draft.fileName,
    mimeType: draft.mimeType,
    contentHash: draft.contentHash,
    body: draft.body,
    previewUrl: target instanceof TFile ? app.vault.getResourcePath(target) : '',
  };
}

function resolveLocalImage(app: App, sourcePath: string, rawPath: string): TFile | null {
  const cleanPath = decodeURIComponent(rawPath)
    .replace(/^<|>$/g, '')
    .split('#', 1)[0]
    .trim();
  const target = app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
  return target instanceof TFile && IMAGE_EXTENSION_TO_MIME[target.extension.toLowerCase()]
    ? target
    : null;
}

async function readLocalAsset(app: App, file: TFile): Promise<WeChatAssetDraft> {
  const body = await app.vault.readBinary(file);
  const contentHash = hashBytes(body);
  return {
    token: assetToken(contentHash),
    source: file.path,
    fileName: path.posix.basename(file.path),
    mimeType: IMAGE_EXTENSION_TO_MIME[file.extension.toLowerCase()],
    contentHash,
    body,
    previewUrl: app.vault.getResourcePath(file),
  };
}

async function readRemoteAsset(url: string): Promise<WeChatAssetDraft> {
  const response = await requestUrl({ url, throw: false });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  const mimeType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() || '';
  if (!Object.values(IMAGE_EXTENSION_TO_MIME).includes(mimeType)) {
    throw new Error(`不支持的图片类型 ${mimeType || 'unknown'}`);
  }
  const body = response.arrayBuffer;
  if (!body.byteLength || body.byteLength > 10 * 1024 * 1024) {
    throw new Error('图片为空或超过 10 MB');
  }
  const contentHash = hashBytes(body);
  const urlPath = new URL(url).pathname;
  const fileName = path.posix.basename(urlPath) || `remote-${contentHash.slice(0, 8)}.png`;
  return {
    token: assetToken(contentHash),
    source: url,
    fileName,
    mimeType,
    contentHash,
    body,
    previewUrl: url,
  };
}

async function replaceRemoteImages(
  markdown: string,
  assets: Map<string, WeChatAssetDraft>,
  warnings: WeChatWarning[],
): Promise<string> {
  const matches = Array.from(markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/gi));
  if (!matches.length) return markdown;
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const url = match[2];
    if (replacements.has(match[0])) continue;
    try {
      let asset = assets.get(url);
      if (!asset) {
        asset = await readRemoteAsset(url);
        assets.set(url, asset);
      }
      replacements.set(match[0], `![${match[1]}](${asset.token})`);
    } catch (error) {
      warnings.push({
        code: 'remote-image',
        message: `图片“${url}”无法上传：${error instanceof Error ? error.message : '读取失败'}`,
        blocking: true,
      });
    }
  }
  let result = markdown;
  for (const [source, replacement] of replacements) {
    result = result.split(source).join(replacement);
  }
  return result;
}

function hashSnapshot(snapshot: Omit<WeChatPreviewSnapshot, 'contentHash'>): string {
  return hashBytes(JSON.stringify({
    title: snapshot.title,
    author: snapshot.author,
    digest: snapshot.digest,
    contentSourceUrl: snapshot.contentSourceUrl,
    needOpenComment: snapshot.needOpenComment,
    onlyFansCanComment: snapshot.onlyFansCanComment,
    markdown: snapshot.markdown,
    assets: snapshot.assets.map((asset) => asset.contentHash).sort(),
    rendererVersion: snapshot.rendererVersion,
  }));
}

export async function buildWeChatSnapshot(app: App, file: TFile): Promise<WeChatPreviewSnapshot> {
  const share = await buildShareSnapshot(app, file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const warnings: WeChatWarning[] = share.warnings.map((message) => ({
    code: message.includes('Mermaid') ? 'mermaid' : 'embed',
    message,
    blocking: true,
  }));
  const assets = new Map<string, WeChatAssetDraft>();
  let markdown = share.markdown;
  for (const draft of share.assets) {
    const converted = localAsset(app, draft);
    assets.set(converted.source, converted);
    markdown = markdown.split(draft.token).join(converted.token);
  }
  markdown = await replaceRemoteImages(markdown, assets, warnings);

  const cover = stringMetadata(frontmatter, 'cover', '封面');
  let coverAssetToken: string | null = null;
  if (cover) {
    try {
      let coverAsset: WeChatAssetDraft;
      if (/^https?:\/\//i.test(cover)) {
        coverAsset = assets.get(cover) ?? await readRemoteAsset(cover);
        assets.set(cover, coverAsset);
      } else {
        const coverFile = resolveLocalImage(app, file.path, cover);
        if (!coverFile) throw new Error('Vault 中找不到该图片');
        coverAsset = assets.get(coverFile.path) ?? await readLocalAsset(app, coverFile);
        assets.set(coverFile.path, coverAsset);
      }
      coverAssetToken = coverAsset.token;
    } catch (error) {
      warnings.push({
        code: 'cover',
        message: `封面“${cover}”无法读取：${error instanceof Error ? error.message : '读取失败'}`,
        blocking: true,
      });
    }
  }

  const prepared: Omit<WeChatPreviewSnapshot, 'contentHash'> = {
    sourcePath: file.path,
    title: stringMetadata(frontmatter, 'title', '标题') || share.title,
    author: stringMetadata(frontmatter, 'author', '作者'),
    digest: stringMetadata(frontmatter, 'digest', '摘要'),
    contentSourceUrl: stringMetadata(frontmatter, 'content_source_url', '原文地址'),
    needOpenComment: booleanMetadata(frontmatter, 'need_open_comment', '打开评论'),
    onlyFansCanComment: booleanMetadata(frontmatter, 'only_fans_can_comment', '仅粉丝可评论'),
    markdown,
    assets: Array.from(assets.values()),
    warnings,
    thumbMediaId: stringMetadata(frontmatter, 'thumb_media_id', '封面素材ID'),
    coverAssetToken,
    rendererVersion: WECHAT_RENDERER_VERSION,
  };
  return { ...prepared, contentHash: hashSnapshot(prepared) };
}

export function withWeChatSnapshotMetadata(
  snapshot: WeChatPreviewSnapshot,
  values: Pick<WeChatPreviewSnapshot, 'title' | 'author' | 'digest'>,
): WeChatPreviewSnapshot {
  const prepared = {
    ...snapshot,
    title: values.title.trim() || snapshot.title,
    author: values.author.trim(),
    digest: values.digest.trim(),
  };
  return { ...prepared, contentHash: hashSnapshot(prepared) };
}
