import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RuntimeEventListener, RuntimeManager } from '../src/runtime/runtimeManager';
import type { ProviderStore } from '../src/storage/providerStore';
import {
  DEFAULT_SETTINGS,
  type ChatTurnRequest,
  type WeSightObsidianSettings,
} from '../src/types';
import {
  WeChatThemeService,
  normalizeGeneratedThemeHtml,
  resolveGzhSkillRoot,
  validateGeneratedThemeHtml,
} from '../src/wechat/themeService';
import { WECHAT_RENDERER_VERSION, type WeChatPreviewSnapshot } from '../src/wechat/types';

const ASSET_TOKEN = `wesight-wechat-asset://${'a'.repeat(64)}`;

function makeSettings(): WeSightObsidianSettings {
  return {
    ...DEFAULT_SETTINGS,
    configSources: { ...DEFAULT_SETTINGS.configSources },
    configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths },
    providerProfileByAgent: { ...DEFAULT_SETTINGS.providerProfileByAgent },
    localModelByAgent: { ...DEFAULT_SETTINGS.localModelByAgent },
  };
}

function makeSnapshot(contentHash = 'snapshot-v1'): WeChatPreviewSnapshot {
  return {
    sourcePath: '公众号/主题生成.md',
    title: '主题生成',
    author: '苍何',
    digest: '主题服务测试',
    contentSourceUrl: '',
    markdown: `正文\n\n![](${ASSET_TOKEN})`,
    contentHash,
    assets: [{
      token: ASSET_TOKEN,
      source: '图片.png',
      fileName: '图片.png',
      mimeType: 'image/png',
      contentHash: 'a'.repeat(64),
      body: new ArrayBuffer(1),
      previewUrl: 'app://local/图片.png',
    }],
    warnings: [],
    thumbMediaId: '',
    coverAssetToken: null,
    rendererVersion: WECHAT_RENDERER_VERSION,
  };
}

function validHtml(token = ASSET_TOKEN): string {
  return [
    '<section style="font-size:14px;">',
    '  <p><span leaf="">公众号主题正文。</span></p>',
    `  <img src="${token}" style="max-width:100%;height:auto;">`,
    '</section>',
  ].join('\n');
}

function createSkillRoot(root: string): string {
  const skillRoot = path.join(root, 'gzh-design');
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# gzh-design\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'theme-index.md'), '# themes\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'common-components.md'), '# common\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'theme-moyu-green.md'), '# green v1\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'theme-generator.md'), '# generator v1\n');
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'validate_gzh_html.py'), '# validator\n');
  return skillRoot;
}

function runtimeWriting(
  output: string | null,
  options: { asText?: boolean; error?: { message: string; detail?: string } } = {},
): RuntimeManager {
  return {
    runTurn: vi.fn(async (request: ChatTurnRequest, onEvent: RuntimeEventListener) => {
      if (options.error) {
        onEvent({ type: 'error', ...options.error });
        return;
      }
      if (output && options.asText) onEvent({ type: 'text', content: `完成\n${output}\n` });
      else if (output) fs.writeFileSync(path.join(request.cwd, 'article.html'), output);
      onEvent({ type: 'done' });
    }),
  } as unknown as RuntimeManager;
}

describe('WeChat theme generation validation', () => {
  test('accepts a compliant section and all expected image tokens', () => {
    expect(validateGeneratedThemeHtml(validHtml(), [ASSET_TOKEN])).toEqual([]);
  });

  test.each([
    ['empty output', '', '生成结果为空'],
    ['document shell', '<html><body></body></html>', 'section 正文片段'],
    ['script', '<section><script>alert(1)</script></section>', '不支持的标签'],
    ['div', '<section><div></div></section>', '不支持的标签'],
    ['event handler', '<section onclick="go()"></section>', '不允许的属性'],
    ['fixed position', '<section style="position:fixed"></section>', '不安全或不兼容的 CSS'],
    ['css variables', '<section style="color:var(--text)"></section>', '不安全或不兼容的 CSS'],
    ['javascript url', '<section><a href="javascript:alert(1)"></a></section>', '不安全链接'],
    ['missing leaf wrappers', '<section><p>中文正文。</p></section>', '缺少 span leaf'],
  ])('rejects %s', (_name, html, expected) => {
    expect(validateGeneratedThemeHtml(html).join('；')).toContain(expected);
  });

  test('rejects any source image omitted by the generated theme', () => {
    expect(validateGeneratedThemeHtml(validHtml('https://example.com/other.png'), [ASSET_TOKEN]))
      .toContain(`生成结果遗漏图片 ${ASSET_TOKEN}`);
  });

  test('removes decorative SVG blocks before final validation', () => {
    const html = validHtml().replace(
      '</section>',
      '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg></section>',
    );
    const normalized = normalizeGeneratedThemeHtml(html);

    expect(normalized).not.toContain('<svg');
    expect(normalized).not.toContain('<path');
    expect(validateGeneratedThemeHtml(normalized, [ASSET_TOKEN])).toEqual([]);
  });
});

describe('WeChat theme Skill discovery and generation', () => {
  let tempDir: string;
  let skillRoot: string;
  let env: NodeJS.ProcessEnv;
  let settings: WeSightObsidianSettings;
  let providerStore: ProviderStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-wechat-theme-'));
    skillRoot = createSkillRoot(tempDir);
    env = {
      HOME: path.join(tempDir, 'empty-home'),
      WESIGHT_HOME: path.join(tempDir, 'wesight-home'),
      WESIGHT_GZH_SKILL_PATH: skillRoot,
    };
    settings = makeSettings();
    providerStore = { find: vi.fn(() => null) } as unknown as ProviderStore;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('finds an explicit Skill path and a standard Codex Skill path', () => {
    expect(resolveGzhSkillRoot('moyu-green', env)).toBe(skillRoot);

    const standardHome = path.join(tempDir, 'standard-home');
    const standardRoot = createSkillRoot(path.join(standardHome, '.codex', 'skills'));
    expect(resolveGzhSkillRoot('moyu-green', { HOME: standardHome })).toBe(standardRoot);
    expect(resolveGzhSkillRoot('ai-custom', env)).toBe(skillRoot);
    expect(resolveGzhSkillRoot('canghe-style', env)).toBeNull();
  });

  test('ignores incomplete Skill installations', () => {
    fs.rmSync(path.join(skillRoot, 'references', 'common-components.md'));
    expect(resolveGzhSkillRoot('moyu-green', env)).toBeNull();
  });

  test('caches generated HTML and invalidates it for article, model, and Skill changes', async () => {
    const runtimeManager = runtimeWriting(validHtml());
    const runTurn = vi.spyOn(runtimeManager, 'runTurn');
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });
    const progress = vi.fn();
    const first = await service.generate(makeSnapshot(), 'moyu-green', { onProgress: progress });

    expect(first).toMatchObject({
      themeId: 'moyu-green',
      sourceHash: 'snapshot-v1',
      html: validHtml(),
    });
    expect(first.contentHash).not.toBe('snapshot-v1');
    expect(progress).toHaveBeenCalledWith({ label: '正在使用 摸鱼绿 生成排版…' });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(service.getCached(makeSnapshot(), 'moyu-green')).toEqual(first);
    expect(await service.generate(makeSnapshot(), 'moyu-green')).toEqual(first);
    expect(runTurn).toHaveBeenCalledOnce();

    await service.generate(makeSnapshot('snapshot-v2'), 'moyu-green');
    expect(runTurn).toHaveBeenCalledTimes(2);

    settings.localModelByAgent = { ...settings.localModelByAgent, claude: 'sonnet' };
    await service.generate(makeSnapshot('snapshot-v2'), 'moyu-green');
    expect(runTurn).toHaveBeenCalledTimes(3);

    fs.appendFileSync(path.join(skillRoot, 'references', 'theme-moyu-green.md'), '# green v2\n');
    await service.generate(makeSnapshot('snapshot-v2'), 'moyu-green');
    expect(runTurn).toHaveBeenCalledTimes(4);

    const runsDir = path.join(env.WESIGHT_HOME!, 'tmp', 'wechat-theme-runs');
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  test('can recover a compliant section from textual runtime output', async () => {
    const runtimeManager = runtimeWriting(validHtml(), { asText: true });
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });

    await expect(service.generate(makeSnapshot(), 'moyu-green'))
      .resolves.toMatchObject({ html: validHtml() });
  });

  test('generates and caches a reusable AI custom theme from the saved style brief', async () => {
    const runtimeManager = runtimeWriting(validHtml());
    const runTurn = vi.spyOn(runtimeManager, 'runTurn');
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });
    const customTheme = {
      name: '雾蓝科技刊',
      description: '浅色科技杂志风，雾蓝色点缀，大留白，适合 AI 产品深度评测。',
    };

    const generated = await service.generate(makeSnapshot(), 'ai-custom', { customTheme });
    expect(generated).toMatchObject({
      themeId: 'ai-custom',
      sourceHash: 'snapshot-v1',
      html: validHtml(),
    });
    const request = runTurn.mock.calls[0][0];
    expect(request.prompt).toContain('theme-generator.md');
    expect(request.prompt).toContain('雾蓝科技刊');
    expect(request.prompt).toContain(customTheme.description);
    expect(request.prompt).toContain('wesight-wechat-asset://');

    settings.wechatCustomThemeName = customTheme.name;
    settings.wechatCustomThemeDescription = customTheme.description;
    expect(service.getCached(makeSnapshot(), 'ai-custom')).toEqual(generated);
    expect(await service.generate(makeSnapshot(), 'ai-custom')).toEqual(generated);
    expect(runTurn).toHaveBeenCalledOnce();

    settings.wechatCustomThemeDescription = '暖灰纸张质感，低饱和橙色点缀。';
    expect(service.getCached(makeSnapshot(), 'ai-custom')).toBeNull();
  });

  test('requires a style description before generating an AI custom theme', async () => {
    const service = new WeChatThemeService({
      runtimeManager: runtimeWriting(validHtml()),
      providerStore,
      getSettings: () => settings,
      env,
    });

    await expect(service.generate(makeSnapshot(), 'ai-custom'))
      .rejects.toThrow('请先填写 AI 自定义主题描述');
  });

  test('removes decorative SVG generated from a theme component before caching', async () => {
    const withSvg = validHtml().replace(
      '</section>',
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle></svg></section>',
    );
    const service = new WeChatThemeService({
      runtimeManager: runtimeWriting(withSvg),
      providerStore,
      getSettings: () => settings,
      env,
    });

    await expect(service.generate(makeSnapshot(), 'moyu-green'))
      .resolves.toMatchObject({ html: validHtml() });
  });

  test('reports runtime errors and cleans the isolated run directory', async () => {
    const runtimeManager = runtimeWriting(null, {
      error: { message: '模型调用失败', detail: '服务暂不可用' },
    });
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });

    await expect(service.generate(makeSnapshot(), 'moyu-green'))
      .rejects.toThrow('模型调用失败：服务暂不可用');
    expect(fs.readdirSync(path.join(env.WESIGHT_HOME!, 'tmp', 'wechat-theme-runs'))).toEqual([]);
  });

  test('reports missing and invalid generated output', async () => {
    const missingService = new WeChatThemeService({
      runtimeManager: runtimeWriting(null),
      providerStore,
      getSettings: () => settings,
      env,
    });
    await expect(missingService.generate(makeSnapshot(), 'moyu-green'))
      .rejects.toThrow('模型没有生成公众号 HTML 文件');

    const invalidService = new WeChatThemeService({
      runtimeManager: runtimeWriting(validHtml('https://example.com/other.png')),
      providerStore,
      getSettings: () => settings,
      env,
    });
    await expect(invalidService.generate(makeSnapshot(), 'moyu-green', { force: true }))
      .rejects.toThrow(`生成结果遗漏图片 ${ASSET_TOKEN}`);
  });
});
