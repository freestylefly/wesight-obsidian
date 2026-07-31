import { App, TFile } from 'obsidian';

import type { FileAttachment } from '../types';
import { resolveVaultAbsolutePath, guessMimeType } from './vault';
export { findMentionQuery, findSlashQuery } from './inputQueries';

export interface MentionResolution {
  prompt: string;
  attachments: FileAttachment[];
}

const MENTION_RE = /@(?:"([^"]+)"|([^\s]+))/g;

export async function resolveMentions(app: App, prompt: string, maxChars: number): Promise<MentionResolution> {
  const attachments: FileAttachment[] = [];
  const contextSections: string[] = [];
  const seen = new Set<string>();

  for (const match of prompt.matchAll(MENTION_RE)) {
    const rawPath = (match[1] || match[2] || '').trim();
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const file = app.vault.getAbstractFileByPath(rawPath);
    if (!(file instanceof TFile)) continue;
    const absolutePath = resolveVaultAbsolutePath(app, file.path);
    if (!absolutePath) continue;
    const mimeType = guessMimeType(file);
    attachments.push({ vaultPath: file.path, absolutePath, mimeType });
    if (mimeType?.startsWith('image/')) continue;
    try {
      const text = await app.vault.cachedRead(file);
      contextSections.push([
        `File: ${file.path}`,
        '```',
        text.slice(0, maxChars),
        text.length > maxChars ? '\n[truncated]' : '',
        '```',
      ].join('\n'));
    } catch {
      contextSections.push(`File: ${file.path}\n[Could not read file]`);
    }
  }

  if (contextSections.length === 0) {
    return { prompt, attachments };
  }

  return {
    prompt: `${prompt}\n\nReferenced vault context:\n\n${contextSections.join('\n\n')}`,
    attachments,
  };
}
