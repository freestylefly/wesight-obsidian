import { createHash } from 'crypto';

import type { FeishuAssetDraft, FeishuSnapshot } from './types';

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function demoteMarkdownHeadings(source: string): string {
  let fence: string | null = null;
  return source
    .split(/\r?\n/)
    .map((line) => {
      const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        fence = fence === marker ? null : fence ?? marker;
        return line;
      }
      if (fence) return line;
      return line.replace(/^(#{1,5})(\s+)/, (_match, hashes: string, spacing: string) => (
        `${hashes}#${spacing}`
      ));
    })
    .join('\n');
}

export function hashFeishuSnapshot(
  title: string,
  markdown: string,
  assets: FeishuAssetDraft[],
): string {
  return hashValue(JSON.stringify({
    title,
    markdown,
    assets: assets.map((asset) => ({
      placeholder: asset.placeholder,
      contentHash: asset.contentHash,
    })),
  }));
}

export function withFeishuSnapshotTitle(
  snapshot: FeishuSnapshot,
  rawTitle: string,
): FeishuSnapshot {
  const title = rawTitle.trim() || snapshot.title;
  const markdown = snapshot.markdown.replace(/^# [^\r\n]*/, `# ${title}`);
  return {
    ...snapshot,
    title,
    markdown,
    contentHash: hashFeishuSnapshot(title, markdown, snapshot.assets),
  };
}
