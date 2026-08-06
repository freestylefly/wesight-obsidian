import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  parseTemplateThemeCss,
  validateTemplateThemeCss,
} from '../src/wechat/templateThemeCss';
import { TemplateThemeService } from '../src/wechat/templateThemeService';
import type { TemplateThemeAdapter } from '../src/wechat/templateThemeTypes';
import {
  containerClassForTemplateThemeId,
} from '../src/wechat/templateThemeService';

function fsAdapter(baseDir: string, fullPathListings = false): TemplateThemeAdapter {
  const fullPath = (filePath: string) => path.resolve(baseDir, filePath);
  return {
    exists: async filePath => {
      try {
        await fs.access(fullPath(filePath));
        return true;
      } catch {
        return false;
      }
    },
    read: async filePath => fs.readFile(fullPath(filePath), 'utf8'),
    list: async filePath => {
      const entries = await fs.readdir(fullPath(filePath), { withFileTypes: true });
      const listedPath = (name: string) => fullPathListings
        ? path.posix.join(filePath.replace(/\\/g, '/'), name)
        : name;
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => listedPath(entry.name)),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => listedPath(entry.name)),
      };
    },
    mkdir: async filePath => {
      await fs.mkdir(fullPath(filePath), { recursive: true });
    },
    write: async (filePath, content) => fs.writeFile(fullPath(filePath), content, 'utf8'),
  };
}

const TEST_CONFIG_DIR = 'obsidian';
 const TEST_PLUGIN_ID = 'wesight';
 const TEST_PLUGIN_DIR = path.join(TEST_CONFIG_DIR, 'plugins', TEST_PLUGIN_ID);

function createTempService() {
  const tmpDir = path.join(os.tmpdir(), `wesight-template-test-${Date.now()}`);
  return {
    tmpDir,
    service: new TemplateThemeService(fsAdapter(tmpDir), TEST_PLUGIN_DIR),
  };
}

describe('Template theme CSS parser', () => {
  test('parses simple scoped rules', () => {
    const parsed = parseTemplateThemeCss(`
      .wesight-wechat-template-test {
        color: #333;
        font-size: 16px;
      }
      .wesight-wechat-template-test p {
        margin: 10px;
      }
    `);
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0].selectors).toEqual(['.wesight-wechat-template-test']);
    expect(parsed.rules[0].declarations).toHaveLength(2);
  });

  test('rejects unsafe declarations', () => {
    const errors = validateTemplateThemeCss(`
      .wesight-wechat-template-test {
        position: fixed;
        color: red;
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects at-rules', () => {
    const errors = validateTemplateThemeCss(`
      @media screen { .wesight-wechat-template-test { color: red; } }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('TemplateThemeService', () => {
  test('writes the built-in canghe-demos pack and loads it', async () => {
    const { tmpDir, service } = createTempService();
    try {
      const themes = await service.loadTemplateThemes();
      const ids = themes.map(theme => theme.manifest.id);
      expect(ids).toContain('canghe-style-tes');
      const canghe = themes.find(theme => theme.manifest.id === 'canghe-style-tes');
      expect(canghe?.definition.kind).toBe('template');
      expect(canghe?.definition.label).toBe('苍绿');
      expect(canghe?.cssText).toContain(containerClassForTemplateThemeId('canghe-style-tes'));
      const manifestPath = path.join(
        tmpDir,
        TEST_PLUGIN_DIR,
        'assets',
        'theme',
        'canghe-demos',
        'template-themes.json',
      );
      expect(await fs.access(manifestPath).then(() => true, () => false)).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loads a user-provided pack', async () => {
    const { tmpDir, service } = createTempService();
    try {
      const packDir = path.join(tmpDir, TEST_PLUGIN_DIR, 'assets', 'theme', 'my-pack');
      await fs.mkdir(path.join(packDir, 'themes'), { recursive: true });
      await fs.writeFile(
        path.join(packDir, 'template-themes.json'),
        JSON.stringify({
          packId: 'my-pack',
          version: '1.0.0',
          themes: [
            {
              id: 'my-theme',
              label: 'My Theme',
              color: '#123456',
              cssFile: 'themes/my-theme.css',
            },
          ],
        }),
        'utf8',
      );
      await fs.writeFile(
        path.join(packDir, 'themes', 'my-theme.css'),
        `.wesight-wechat-template-my-theme { color: #123456; }`,
        'utf8',
      );
      // Let the service also write the built-in pack; total themes should be >= 2.
      const themes = await service.loadTemplateThemes();
      expect(themes.map(theme => theme.manifest.id)).toContain('my-theme');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loads packs when directory listings contain Vault-relative paths', async () => {
    const tmpDir = path.join(os.tmpdir(), `wesight-template-test-${Date.now()}`);
    const service = new TemplateThemeService(
      fsAdapter(tmpDir, true),
      TEST_CONFIG_DIR,
    );
    try {
      const themes = await service.loadTemplateThemes();
      expect(themes.map(theme => theme.manifest.id)).toContain('canghe-style-tes');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
