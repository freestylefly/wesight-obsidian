import { normalizePath } from 'obsidian';

import type { TemplateThemeAdapter } from './templateThemeTypes';

export function obsidianTemplateThemeAdapter(adapter: {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  mkdir: (path: string) => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
}): TemplateThemeAdapter {
  return {
    exists: (filePath: string) => adapter.exists(normalizePath(filePath)),
    read: (filePath: string) => adapter.read(normalizePath(filePath)),
    list: (filePath: string) => adapter.list(normalizePath(filePath)),
    mkdir: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      if (await adapter.exists(normalized)) return;
      const parts = normalized.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (await adapter.exists(current)) continue;
        try {
          await adapter.mkdir(current);
        } catch (error) {
          if (!(await adapter.exists(current))) throw error;
        }
      }
    },
    write: (filePath: string, content: string) => adapter.write(normalizePath(filePath), content),
  };
}
