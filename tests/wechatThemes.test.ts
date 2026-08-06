import {
  DEFAULT_WECHAT_THEME_ID,
  WECHAT_THEME_DEFINITIONS,
  createTemplateThemeDocument,
  getWeChatTheme,
  hashSkillThemeDocument,
  isWeChatThemeId,
  listWeChatThemes,
  setTemplateThemeDefinitions,
} from '../src/wechat/themes';
import { WECHAT_RENDERER_VERSION, type WeChatPreviewSnapshot } from '../src/wechat/types';

function snapshot(contentHash = 'source-hash'): WeChatPreviewSnapshot {
  return {
    sourcePath: '公众号/测试.md',
    title: '主题测试',
    author: '苍何',
    digest: '验证主题注册和哈希。',
    contentSourceUrl: '',
    markdown: '正文',
    contentHash,
    assets: [],
    warnings: [],
    thumbMediaId: '',
    coverAssetToken: null,
    rendererVersion: WECHAT_RENDERER_VERSION,
  };
}

describe('WeChat themes', () => {
  beforeEach(() => {
    setTemplateThemeDefinitions([
      { id: 'canghe-style-tes', label: '苍绿', kind: 'template', color: '#2ea765' },
    ]);
  });

  test('keeps resource-pack Canghe Style as the default and exposes only Skill and AI custom built-ins', () => {
    expect(DEFAULT_WECHAT_THEME_ID).toBe('canghe-style-tes');
    expect(WECHAT_THEME_DEFINITIONS.map(theme => theme.id)).toEqual([
      'moyu-green',
      'red-white',
      'graphite-minimal',
      'zen-whitespace',
      'moyu-ticket',
      'olive-journal',
      'ai-custom',
    ]);
    expect(listWeChatThemes('template').map(theme => theme.label)).toEqual(['苍绿']);
    expect(listWeChatThemes('skill').map(theme => theme.label)).toEqual([
      '摸鱼绿',
      '红白色系',
      '石墨极简风',
      '留白禅意风',
      '摸鱼票据风',
      '橄榄手记',
    ]);
    expect(listWeChatThemes('custom').map(theme => theme.label)).toEqual(['AI自定义主题']);
  });

  test('recognizes registered ids and falls back to the default theme', () => {
    expect(isWeChatThemeId('moyu-green')).toBe(true);
    expect(isWeChatThemeId('ai-custom')).toBe(true);
    expect(isWeChatThemeId('unknown')).toBe(false);
    expect(getWeChatTheme('unknown').id).toBe(DEFAULT_WECHAT_THEME_ID);
  });

  test('uses the source hash for templates and all generation inputs for Skill hashes', () => {
    expect(createTemplateThemeDocument(snapshot())).toMatchObject({
      themeId: 'canghe-style-tes',
      sourceHash: 'source-hash',
      contentHash: 'source-hash',
      html: null,
    });
    const base = {
      sourceHash: 'source-hash',
      themeId: 'moyu-green' as const,
      html: '<section></section>',
      generatorSignature: 'generator-v1',
    };
    const hash = hashSkillThemeDocument(base);
    expect(hashSkillThemeDocument(base)).toBe(hash);
    expect(hashSkillThemeDocument({ ...base, html: '<section><p></p></section>' })).not.toBe(hash);
    expect(hashSkillThemeDocument({ ...base, generatorSignature: 'generator-v2' })).not.toBe(hash);
    expect(hashSkillThemeDocument({ ...base, sourceHash: 'updated-source' })).not.toBe(hash);
  });
});
