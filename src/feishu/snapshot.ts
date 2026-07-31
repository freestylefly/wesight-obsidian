import path from 'path';
import { App, FileSystemAdapter, TFile } from 'obsidian';

import { buildShareSnapshot } from '../share/snapshot';
import type { ShareSnapshot } from '../share/types';
import { demoteMarkdownHeadings, hashFeishuSnapshot } from './markdown';
import type { FeishuAssetDraft, FeishuSnapshot } from './types';

export { withFeishuSnapshotTitle } from './markdown';

function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  const compatible = adapter as typeof adapter & { getBasePath?: () => string };
  if (typeof compatible.getBasePath === 'function') return compatible.getBasePath();
  throw new Error('飞书发布仅支持本地文件系统 Vault。');
}

function buildMarkdown(
  title: string,
  shareSnapshot: ShareSnapshot,
): { markdown: string; assets: FeishuAssetDraft[] } {
  const draftsByToken = new Map(shareSnapshot.assets.map((asset) => [asset.token, asset]));
  const assets: FeishuAssetDraft[] = [];
  const body = shareSnapshot.markdown.replace(
    /!\[([^\]]*)\]\((wesight-asset:\/\/[a-f0-9]+)\)/gi,
    (_match, rawAlt: string, token: string) => {
      const draft = draftsByToken.get(token);
      if (!draft) return _match;
      const index = assets.length + 1;
      const placeholder = `WESIGHT_FEISHU_IMAGE_${String(index).padStart(4, '0')}_${draft.contentHash.slice(0, 12)}`;
      assets.push({
        placeholder,
        vaultPath: draft.vaultPath,
        fileName: draft.fileName,
        mimeType: draft.mimeType,
        contentHash: draft.contentHash,
        alt: rawAlt.trim() || path.posix.basename(draft.vaultPath),
      });
      return placeholder;
    },
  );
  return {
    markdown: `# ${title}\n\n${demoteMarkdownHeadings(body).trim()}\n`,
    assets,
  };
}

export async function buildFeishuSnapshot(app: App, file: TFile): Promise<FeishuSnapshot> {
  const shareSnapshot = await buildShareSnapshot(app, file);
  const prepared = buildMarkdown(shareSnapshot.title, shareSnapshot);
  return {
    title: shareSnapshot.title,
    markdown: prepared.markdown,
    contentHash: hashFeishuSnapshot(shareSnapshot.title, prepared.markdown, prepared.assets),
    assets: prepared.assets,
    warnings: shareSnapshot.warnings,
    vaultBasePath: vaultBasePath(app),
  };
}
