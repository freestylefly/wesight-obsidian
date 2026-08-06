import path from 'path';

import { vaultTemplateThemePacksDir } from '../paths';
import {
  type ParsedCssRule,
  parseTemplateThemeCss,
  scopeTemplateThemeCss,
  validateTemplateThemeCss,
} from './templateThemeCss';
import type {
  LoadedTemplateTheme,
  TemplateThemeAdapter,
  TemplateThemeFeatures,
  TemplateThemePackManifest,
} from './templateThemeTypes';
import type { WeChatThemeDefinition } from './themes';

import cangheStyleCss from '../../assets/theme/canghe-demos/themes/canghe-style-tes.css.txt?raw';
import cangheVioletCss from '../../assets/theme/canghe-demos/themes/canghe-violet.css.txt?raw';
 import cangheOrangeCss from '../../assets/theme/canghe-demos/themes/canghe-orange.css.txt?raw';
 import cangheCyanCss from '../../assets/theme/canghe-demos/themes/canghe-cyan.css.txt?raw';
 import cangheRedCss from '../../assets/theme/canghe-demos/themes/canghe-red.css.txt?raw';
 import cangheBlueCss from '../../assets/theme/canghe-demos/themes/canghe-blue.css.txt?raw';
 import cangheGeekBlackCss from '../../assets/theme/canghe-demos/themes/canghe-geek-black.css.txt?raw';
 import canghePinkCss from '../../assets/theme/canghe-demos/themes/canghe-pink.css.txt?raw';
import builtInManifestRaw from '../../assets/theme/canghe-demos/template-themes.json?raw';

const BUILT_IN_PACK_ID = 'canghe-demos';
const MANIFEST_FILE = 'template-themes.json';

const BUILT_IN_CSS_BY_THEME_ID: Record<string, string> = {
  'canghe-style-tes': cangheStyleCss,
  'canghe-violet': cangheVioletCss,
  'canghe-orange': cangheOrangeCss,
  'canghe-cyan': cangheCyanCss,
  'canghe-red': cangheRedCss,
  'canghe-blue': cangheBlueCss,
  'canghe-geek-black': cangheGeekBlackCss,
  'canghe-pink': canghePinkCss,
};

const DEFAULT_TEMPLATE_THEME_FEATURES: Required<TemplateThemeFeatures> = {
  decorateHeading: true,
  wrapTables: true,
  decorateCode: true,
  replaceTaskCheckbox: true,
};

function loadTemplateThemePackManifest(text: string): TemplateThemePackManifest {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('清单不是 JSON 对象');
  if (!('packId' in parsed) || typeof (parsed as TemplateThemePackManifest).packId !== 'string') {
    throw new Error('清单缺少 packId');
  }
  if (!('themes' in parsed) || !Array.isArray((parsed as TemplateThemePackManifest).themes)) {
    throw new Error('清单缺少 themes 数组');
  }
  return parsed as TemplateThemePackManifest;
}

function mergeFeatures(features?: TemplateThemeFeatures): Required<TemplateThemeFeatures> {
  return {
    ...DEFAULT_TEMPLATE_THEME_FEATURES,
    ...features,
  };
}

export function containerClassForTemplateThemeId(themeId: string): string {
  return `wesight-wechat-template-${themeId}`;
}

export class TemplateThemeService {
  private readonly _packsDir: string;
  private readonly builtInManifest: TemplateThemePackManifest;
  private loadedThemes: LoadedTemplateTheme[] | null = null;

  constructor(
    private readonly adapter: TemplateThemeAdapter,
    private readonly pluginDir: string,
  ) {
    this._packsDir = vaultTemplateThemePacksDir(pluginDir);
    this.builtInManifest = loadTemplateThemePackManifest(builtInManifestRaw);
  }

  async loadTemplateThemes(): Promise<LoadedTemplateTheme[]> {
    if (this.loadedThemes) return this.loadedThemes;
    await this.ensureBuiltInPack();
    if (!(await this.adapter.exists(this._packsDir))) {
      return [];
    }
    const listing = await this.adapter.list(this._packsDir);
    const themes: LoadedTemplateTheme[] = [];
    for (const folder of listing.folders) {
      // Obsidian's DataAdapter returns Vault-relative paths here, while file-system
      // adapters commonly return child names. Normalize both forms to a pack id.
      const packId = path.posix.basename(folder.replace(/\\/g, '/'));
      const loaded = await this.loadPack(packId);
      if (loaded) themes.push(...loaded);
    }
    this.loadedThemes = themes;
    return this.loadedThemes;
  }

  async getTemplateTheme(themeId: string): Promise<LoadedTemplateTheme | null> {
    const themes = await this.loadTemplateThemes();
    return themes.find(theme => theme.manifest.id === themeId) ?? null;
  }

  getLoadedTemplateThemes(): LoadedTemplateTheme[] {
    return this.loadedThemes ?? [];
  }

  reload(): void {
    this.loadedThemes = null;
  }

  get packsDir(): string {
    return this._packsDir;
  }

  parseCssForTheme(theme: LoadedTemplateTheme): ParsedCssRule[] {
    return parseTemplateThemeCss(theme.cssText).rules;
  }

  private async ensureBuiltInPack(): Promise<void> {
    const packDir = path.join(this._packsDir, BUILT_IN_PACK_ID);
    const manifestPath = path.join(packDir, MANIFEST_FILE);
    if (await this.adapter.exists(manifestPath)) return;
    await this.adapter.mkdir(packDir);
    await this.adapter.mkdir(path.join(packDir, 'themes'));
    await this.adapter.write(manifestPath, builtInManifestRaw);
    for (const theme of this.builtInManifest.themes) {
      const cssPath = path.join(packDir, theme.cssFile);
      const cssText = BUILT_IN_CSS_BY_THEME_ID[theme.id] ?? cangheStyleCss;
      await this.adapter.write(cssPath, cssText);
    }
  }

  private async loadPack(folder: string): Promise<LoadedTemplateTheme[] | null> {
    const packDir = path.join(this._packsDir, folder);
    const manifestPath = path.join(packDir, MANIFEST_FILE);
    if (!(await this.adapter.exists(manifestPath))) {
      return null;
    }
    let text: string;
    try {
      text = await this.adapter.read(manifestPath);
    } catch {
      return null;
    }
    let manifest: TemplateThemePackManifest;
    try {
      manifest = loadTemplateThemePackManifest(text);
    } catch {
      return null;
    }
    if (manifest.packId !== folder) {
      return null;
    }
    const loaded: LoadedTemplateTheme[] = [];
    for (const theme of manifest.themes) {
      const cssPath = path.join(packDir, theme.cssFile);
      if (!(await this.adapter.exists(cssPath))) {
        continue;
      }
      let cssText: string;
      try {
        cssText = await this.adapter.read(cssPath);
      } catch {
        continue;
      }
      const scoped = scopeTemplateThemeCss(cssText, containerClassForTemplateThemeId(theme.id));
      const errors = validateTemplateThemeCss(scoped);
      if (errors.length) {
        continue;
      }
      const definition: WeChatThemeDefinition = {
        id: theme.id,
        label: theme.label,
        kind: 'template',
        color: theme.color,
      };
      loaded.push({
        packId: manifest.packId,
        manifest: theme,
        definition,
        cssText: scoped,
        features: mergeFeatures(theme.features),
        preview: theme.preview ? path.join(packDir, theme.preview) : undefined,
        absoluteBasePath: packDir,
      });
    }
    return loaded;
  }
}
