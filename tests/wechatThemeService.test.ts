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
  extractStreamingThemeHtml,
  mergeRuntimeText,
  prepareThemeGenerationContext,
  ThemeGenerationCancelledError,
  WeChatThemeService,
  normalizeGeneratedThemeHtml,
  resolveGzhSkillRoot,
  validateGeneratedThemeHtml,
} from '../src/wechat/themeService';
 import { setTemplateThemeDefinitions } from '../src/wechat/themes';
import { WECHAT_RENDERER_VERSION, type WeChatPreviewSnapshot } from '../src/wechat/types';

 beforeEach(() => {
   setTemplateThemeDefinitions([
    { id: 'canghe-style-tes', label: '苍绿', kind: 'template', color: '#2ea765' },
   ]);
 });

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
  options: {
    asText?: boolean;
    chunks?: string[];
    error?: { message: string; detail?: string };
  } = {},
): RuntimeManager {
  return {
    runTurn: vi.fn(async (request: ChatTurnRequest, onEvent: RuntimeEventListener) => {
      if (options.error) {
        onEvent({ type: 'error', ...options.error });
        return;
      }
      if (options.chunks) {
        for (const chunk of options.chunks) onEvent({ type: 'text', content: chunk });
      } else if (output && options.asText) onEvent({ type: 'text', content: `完成\n${output}\n` });
      else if (output) fs.writeFileSync(path.join(request.cwd, 'article.html'), output);
      onEvent({ type: 'done' });
    }),
  } as unknown as RuntimeManager;
}

describe('WeChat theme generation validation', () => {
  test('extracts partial section HTML and ignores runtime preamble or trailing text', () => {
    expect(extractStreamingThemeHtml('模型正在准备')).toBeNull();
    expect(extractStreamingThemeHtml('准备\n```html\n<section><p>正文'))
      .toBe('<section><p>正文');
    expect(extractStreamingThemeHtml('准备\n<section><p>正文</p></section>\n完成'))
      .toBe('<section><p>正文</p></section>');
    expect(extractStreamingThemeHtml(
      '准备\n<section><section>正文</section></section><section>重复累计消息</section>',
    )).toBe('<section><section>正文</section></section>');
  });

  test('merges runtime deltas while replacing cumulative messages', () => {
    expect(mergeRuntimeText('<section>', '<p>正文')).toBe('<section><p>正文');
    expect(mergeRuntimeText('<section>', '<section><p>正文')).toBe('<section><p>正文');
    expect(mergeRuntimeText('<section>', '<section>')).toBe('<section>');
    const complete = '<section style="margin:0 32px;"><span leaf="">正文</span></section>';
    expect(mergeRuntimeText(complete, complete)).toBe(complete);
  });

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
    ['multiple roots', '<section><span leaf="">一</span></section><section><span leaf="">二</span></section>', '只能包含一个根 section'],
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

  test('prefers an explicit Skill path and supports a standard Codex Skill path', () => {
    expect(resolveGzhSkillRoot('moyu-green', env)).toBe(skillRoot);

    const standardHome = path.join(tempDir, 'standard-home');
    const standardRoot = createSkillRoot(path.join(standardHome, '.codex', 'skills'));
    expect(resolveGzhSkillRoot('moyu-green', { HOME: standardHome })).toBe(standardRoot);
    expect(resolveGzhSkillRoot('ai-custom', env)).toBe(skillRoot);
    expect(resolveGzhSkillRoot('canghe-style-tes', env)).toBeNull();
  });

  test('falls back to the bundled Skill when a local installation is incomplete', () => {
    fs.rmSync(path.join(skillRoot, 'references', 'common-components.md'));
    const resolved = resolveGzhSkillRoot('moyu-green', env);

    expect(resolved).toBe(path.join(
      env.WESIGHT_HOME!,
      'bundled-skills',
      'gzh-design',
      'ba1f4175519b481cb3566616c9e5178705067904',
    ));
    expect(fs.readFileSync(path.join(resolved!, 'SKILL.md'), 'utf8'))
      .toContain('# 公众号文章排版 Skill');
    expect(fs.readFileSync(path.join(resolved!, 'LICENSE.txt'), 'utf8'))
      .toContain('Copyright (C) 2026 甲木 (Jiamu) × 摸鱼小李 (Moyu Xiaoli)');
    expect(resolveGzhSkillRoot('ai-custom', env)).toBe(resolved);
  });

  test('materializes the bundled Skill on a computer without any local Skill', () => {
    const emptyEnv = {
      HOME: path.join(tempDir, 'new-computer-home'),
      WESIGHT_HOME: path.join(tempDir, 'new-computer-wesight-home'),
    };
    const resolved = resolveGzhSkillRoot('olive-journal', emptyEnv);

    expect(resolved).toBeTruthy();
    expect(resolved).toContain(path.join('bundled-skills', 'gzh-design'));
    expect(fs.readFileSync(
      path.join(resolved!, 'references', 'theme-olive-journal.md'),
      'utf8',
    )).toContain('橄榄手记');
    expect(fs.readFileSync(path.join(resolved!, 'UPSTREAM.md'), 'utf8'))
      .toContain('isjiamu/gzh-design-skill');
  });

  test('rejects Skill context files that escape the resolved Skill root', () => {
    const themePath = path.join(skillRoot, 'references', 'theme-moyu-green.md');
    const outsidePath = path.join(tempDir, 'outside-theme.md');
    fs.writeFileSync(outsidePath, '# outside\n');
    fs.rmSync(themePath);
    fs.symlinkSync(outsidePath, themePath);

    expect(() => prepareThemeGenerationContext(skillRoot, 'moyu-green', '正文'))
      .toThrow('gzh-design Skill 文件路径越界');
  });

  test('rejects oversized Skill files and articles before starting a runtime', () => {
    fs.writeFileSync(
      path.join(skillRoot, 'references', 'theme-moyu-green.md'),
      Buffer.alloc(256 * 1024 + 1, 'x'),
    );
    expect(() => prepareThemeGenerationContext(skillRoot, 'moyu-green', '正文'))
      .toThrow('上下文文件超过 256 KB');

    fs.writeFileSync(path.join(skillRoot, 'references', 'theme-moyu-green.md'), '# green\n');
    expect(() => prepareThemeGenerationContext(
      skillRoot,
      'moyu-green',
      '文'.repeat(512 * 1024),
    )).toThrow('公众号文章超过 512 KB');
  });

  test('keeps structural components and removes unrelated Skill context', () => {
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
      '# gzh-design',
      '## 工作流',
      '### 3. 解析 Markdown 结构',
      '保留解析规则。',
      '### 4. 按配方选组件组合',
      '保留装配规则。',
      '## 添加新主题的规范',
      '本次生成不需要。',
    ].join('\n'));
    fs.writeFileSync(path.join(skillRoot, 'references', 'common-components.md'), [
      '# common',
      '## 一、代码块组件',
      '<section>code</section>',
      '## 二、图片 / GIF 组件',
      '<section>image</section>',
      '## 三、小标签标题组件',
      '<section>label</section>',
    ].join('\n'));
    fs.writeFileSync(path.join(skillRoot, 'references', 'theme-moyu-green.md'), [
      '# green',
      '## 设计变量速查表',
      'green tokens',
      '## 组件 1 全局容器',
      '<section>root</section>',
      '## 组件 2 正文段落 paragraph',
      '<p>body</p>',
      '## 组件 3 无关装饰组件',
      '<section>unused</section>',
      '## 组件 4 图片容器',
      '<section>image</section>',
      '## 组件 5 尾部作者签名区',
      '<section>footer</section>',
      '## 完整文章模板骨架',
      '<section>skeleton</section>',
    ].join('\n'));

    const context = prepareThemeGenerationContext(
      skillRoot,
      'moyu-green',
      `## 案例\n正文\n\n![](${ASSET_TOKEN})`,
    );

    expect(context.skillRules).toContain('保留解析规则');
    expect(context.skillRules).not.toContain('添加新主题');
    expect(context.commonComponents).toContain('<section>image</section>');
    expect(context.commonComponents).not.toContain('<section>code</section>');
    expect(context.themeComponents).toContain('<p>body</p>');
    expect(context.themeComponents).toContain('<section>footer</section>');
    expect(context.themeComponents).not.toContain('<section>unused</section>');
    expect(context.bytes.sourceTotal).toBeGreaterThan(context.bytes.total);
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
    expect(progress).toHaveBeenCalledWith({
      phase: 'preparing',
      label: '正在读取 摸鱼绿 主题组件…',
    });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(service.getCached(makeSnapshot(), 'moyu-green')).toEqual(first);
    const readFile = vi.spyOn(fs, 'readFileSync');
    expect(await service.generate(makeSnapshot(), 'moyu-green')).toEqual(first);
    const skillReads = readFile.mock.calls
      .map(call => String(call[0]))
      .filter(filePath => filePath.startsWith(skillRoot));
    readFile.mockRestore();
    expect(skillReads).toEqual([]);
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

  test('streams cumulative section previews before validating and caching the final HTML', async () => {
    const html = validHtml();
    const chunks = [
      '正在读取主题组件\n```html\n',
      html.slice(0, 28),
      html.slice(28, 92),
      html.slice(92),
      '\n```\n',
    ];
    const runtimeManager = runtimeWriting(null, { chunks });
    const runTurn = vi.spyOn(runtimeManager, 'runTurn');
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });
    const previews: string[] = [];
    const progress = vi.fn();

    const result = await service.generate(makeSnapshot(), 'moyu-green', {
      onProgress: progress,
      onPreview: preview => previews.push(preview),
    });

    expect(previews.length).toBeGreaterThanOrEqual(3);
    expect(previews.map(preview => preview.length)).toEqual(
      [...previews.map(preview => preview.length)].sort((left, right) => left - right),
    );
    expect(previews.at(-1)).toBe(html);
    expect(result.html).toBe(html);
    expect(progress).toHaveBeenCalledWith({
      phase: 'streaming',
      label: '正在生成 摸鱼绿 主题…',
    });
    expect(progress).toHaveBeenCalledWith({
      phase: 'validating',
      label: '正在校验 摸鱼绿 排版…',
    });
    const request = runTurn.mock.calls[0][0];
    expect(request.textOnly).toBe(true);
    expect(request.prompt).toContain('最终回复只能包含公众号正文 section 片段');
    expect(request.prompt).toContain('不要创建或修改任何输出文件');
    expect(request.prompt).toContain('禁止调用文件读取、搜索、写入或其他工具');
    expect(request.prompt).toContain('===== GZH-DESIGN SKILL RULES START =====\n# gzh-design');
    expect(request.prompt).toContain('===== COMMON COMPONENTS START =====\n# common');
    expect(request.prompt).toContain('===== THEME COMPONENTS (摸鱼绿) START =====\n# green v1');
    expect(request.prompt).toContain(`===== ARTICLE MARKDOWN START =====\n${makeSnapshot().markdown}`);
    expect(request.prompt).not.toContain(path.join(skillRoot, 'SKILL.md'));
    expect(request.prompt).not.toContain('===== CUSTOM THEME GENERATOR START =====');
  });

  test('cancels one streaming generation without caching its partial HTML', async () => {
    const controller = new AbortController();
    const onPreview = vi.fn();
    const runtimeManager = {
      runTurn: vi.fn(async (_request: ChatTurnRequest, onEvent: RuntimeEventListener) => {
        onEvent({ type: 'text', content: '<section><p><span leaf="">部分正文' });
        controller.abort();
        onEvent({ type: 'done' });
      }),
    } as unknown as RuntimeManager;
    const service = new WeChatThemeService({
      runtimeManager,
      providerStore,
      getSettings: () => settings,
      env,
    });

    await expect(service.generate(makeSnapshot(), 'moyu-green', {
      signal: controller.signal,
      onPreview,
    })).rejects.toBeInstanceOf(ThemeGenerationCancelledError);
    expect(onPreview).toHaveBeenCalledOnce();
    expect(service.getCached(makeSnapshot(), 'moyu-green')).toBeNull();
    expect(settings.wechatThemeId).toBe('canghe-style-tes');
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
    expect(request.prompt).toContain('===== CUSTOM THEME GENERATOR START =====\n# generator v1');
    expect(request.prompt).not.toContain('===== THEME COMPONENTS (');

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
