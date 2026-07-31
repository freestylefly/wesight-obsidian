export const SHARE_ID_FRONTMATTER_KEY = 'wesight-share-id';

export interface FrontmatterResult {
  markdown: string;
  shareId: string | null;
}

export function stripShareFrontmatter(source: string): FrontmatterResult {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { markdown: source, shareId: null };
  }
  const newline = source.startsWith('---\r\n') ? '\r\n' : '\n';
  const endMarker = `${newline}---${newline}`;
  const endIndex = source.indexOf(endMarker, 3);
  if (endIndex < 0) {
    return { markdown: source, shareId: null };
  }

  const frontmatter = source.slice(3 + newline.length, endIndex);
  let shareId: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = new RegExp(`^${SHARE_ID_FRONTMATTER_KEY}\\s*:\\s*(.+?)\\s*$`).exec(line);
    if (match) {
      shareId = match[1].replace(/^['"]|['"]$/g, '').trim() || null;
    }
  }
  const body = source.slice(endIndex + endMarker.length);
  return {
    markdown: body,
    shareId,
  };
}

export function transformWikiLinks(source: string): string {
  return source.replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
    const [target, alias] = inner.split('|', 2);
    return (alias || target).trim();
  });
}

export function omitMermaidBlocks(source: string): { markdown: string; found: boolean } {
  let found = false;
  const markdown = source.replace(
    /^```mermaid[^\r\n]*\r?\n[\s\S]*?^```[ \t]*$/gim,
    () => {
      found = true;
      return '> Mermaid 图表未随分享发布。';
    },
  );
  return { markdown, found };
}
