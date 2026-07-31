import path from 'path';
import { App, FileSystemAdapter, TFile } from 'obsidian';

export function getVaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return null;
}

export function resolveVaultAbsolutePath(app: App, vaultPath: string): string | null {
  const basePath = getVaultBasePath(app);
  return basePath ? path.join(basePath, vaultPath) : null;
}

export function getActiveMarkdownFile(app: App): TFile | null {
  const file = app.workspace.getActiveFile();
  return file?.extension === 'md' ? file : null;
}

export function guessMimeType(file: TFile): string | undefined {
  const ext = file.extension.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  }
  if (ext === 'md') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  return undefined;
}
