import type { WeChatThemeDefinition } from './themes';

export interface TemplateThemeAdapter {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  mkdir: (path: string) => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
}

export interface TemplateThemeFeatures {
  decorateHeading?: boolean;
  wrapTables?: boolean;
  decorateCode?: boolean;
  replaceTaskCheckbox?: boolean;
}

export interface TemplateThemeManifest {
  id: string;
  label: string;
  color: string;
  cssFile: string;
  preview?: string;
  features?: TemplateThemeFeatures;
}

export interface TemplateThemePackManifest {
  packId: string;
  version: string;
  source?: string;
  themes: TemplateThemeManifest[];
}

export interface LoadedTemplateTheme {
  packId: string;
  manifest: TemplateThemeManifest;
  definition: WeChatThemeDefinition;
  cssText: string;
  features: TemplateThemeFeatures;
  preview?: string;
  absoluteBasePath: string;
}
