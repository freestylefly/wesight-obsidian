import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ProviderStore } from '../storage/providerStore';
import { appendLocalLog } from '../storage/localLog';
import type { WeSightObsidianSettings } from '../types';
import { RuntimeManager } from '../runtime/runtimeManager';
import { createId } from '../utils/id';
import { ensureDir, fileExists, readJsonFile, safeRemoveDir, writeJsonFile } from '../utils/fs';
import { tmpDir, wechatThemeCacheDir } from '../paths';
import type { WeChatPreviewSnapshot } from './types';
import {
  getWeChatTheme,
  hashSkillThemeDocument,
  type WeChatCustomThemePreferences,
  type WeChatThemeDocument,
  type WeChatThemeId,
} from './themes';

interface CachedThemeDocument extends WeChatThemeDocument {
  version: 1;
  cacheKey: string;
}

export interface ThemeGenerationProgress {
  label: string;
}

export interface GenerateThemeOptions {
  force?: boolean;
  customTheme?: WeChatCustomThemePreferences;
  onProgress?: (progress: ThemeGenerationProgress) => void;
}

export interface WeChatThemeServiceOptions {
  runtimeManager: RuntimeManager;
  providerStore: ProviderStore;
  getSettings: () => WeSightObsidianSettings;
  env?: NodeJS.ProcessEnv;
}

const MAX_GENERATED_HTML_BYTES = 2 * 1024 * 1024;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function skillCandidates(env: NodeJS.ProcessEnv): string[] {
  const configured = env.WESIGHT_GZH_SKILL_PATH?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return [
    configured || '',
    path.join(home, '.agents', 'skills', 'gzh-design'),
    path.join(home, '.agents', 'skills', 'gzh-design-skill'),
    path.join(home, '.claude', 'skills', 'gzh-design'),
    path.join(home, '.codex', 'skills', 'gzh-design'),
    path.join(home, '.config', 'opencode', 'skills', 'gzh-design'),
  ].filter(Boolean);
}

export function resolveGzhSkillRoot(
  themeId: WeChatThemeId,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const theme = getWeChatTheme(themeId);
  if (theme.kind === 'template') return null;
  for (const candidate of skillCandidates(env)) {
    const themeSourceExists = theme.kind === 'custom'
      ? fileExists(path.join(candidate, 'references', 'theme-generator.md'))
      : Boolean(theme.skillReference && fileExists(path.join(candidate, theme.skillReference)));
    if (
      fileExists(path.join(candidate, 'SKILL.md'))
      && fileExists(path.join(candidate, 'references', 'theme-index.md'))
      && fileExists(path.join(candidate, 'references', 'common-components.md'))
      && themeSourceExists
      && fileExists(path.join(candidate, 'scripts', 'validate_gzh_html.py'))
    ) return candidate;
  }
  return null;
}

function skillSignature(skillRoot: string, themeId: WeChatThemeId): string {
  const theme = getWeChatTheme(themeId);
  const themeSource = theme.kind === 'custom'
    ? path.join(skillRoot, 'references', 'theme-generator.md')
    : path.join(skillRoot, theme.skillReference ?? '');
  const sources = [
    path.join(skillRoot, 'SKILL.md'),
    path.join(skillRoot, 'references', 'theme-index.md'),
    path.join(skillRoot, 'references', 'common-components.md'),
    themeSource,
  ];
  return sha256(sources.map(source => fs.readFileSync(source, 'utf8')).join('\n---\n'));
}

function customThemeFromSettings(settings: WeSightObsidianSettings): WeChatCustomThemePreferences {
  return {
    name: settings.wechatCustomThemeName.trim(),
    description: settings.wechatCustomThemeDescription.trim(),
  };
}

function generatorSignature(
  settings: WeSightObsidianSettings,
  providerStore: ProviderStore,
): string {
  const agentId = settings.defaultAgentId;
  const source = settings.configSources[agentId];
  if (source === 'providerProfile') {
    const selected = settings.providerProfileByAgent[agentId];
    const profile = providerStore.find(agentId, selected || undefined);
    return [
      agentId,
      source,
      profile?.id ?? 'missing',
      profile?.defaultModel || profile?.model || 'default',
      profile?.updatedAt ?? 0,
    ].join(':');
  }
  return [agentId, source, settings.localModelByAgent[agentId] || 'default'].join(':');
}

function cacheKey(values: {
  sourceHash: string;
  themeId: WeChatThemeId;
  skillSignature: string;
  generatorSignature: string;
}): string {
  return sha256(JSON.stringify(values));
}

function cachePath(key: string, env: NodeJS.ProcessEnv): string {
  return path.join(wechatThemeCacheDir(env), `${key}.json`);
}

function usedAssetTokens(snapshot: WeChatPreviewSnapshot): string[] {
  return snapshot.assets
    .map(asset => asset.token)
    .filter(token => snapshot.markdown.includes(token));
}

export function validateGeneratedThemeHtml(
  html: string,
  expectedAssetTokens: string[] = [],
): string[] {
  const errors: string[] = [];
  const normalized = html.trim();
  if (!normalized) errors.push('生成结果为空');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_GENERATED_HTML_BYTES) {
    errors.push('生成结果超过 2 MB');
  }
  if (!/^<section\b/i.test(normalized) || !/<\/section>\s*$/i.test(normalized)) {
    errors.push('生成结果必须是 section 正文片段');
  }
  if (/<(?:!doctype|html|head|body|script|style|link|div|iframe|object|embed|form|button|input|textarea|select|video|audio|canvas|svg)\b/i.test(normalized)) {
    errors.push('生成结果包含公众号不支持的标签');
  }
  if (/\s(?:class|id|on[a-z]+)\s*=/i.test(normalized)) {
    errors.push('生成结果包含不允许的属性');
  }
  if (/(?:position\s*:\s*(?:fixed|absolute|sticky)|float\s*:|display\s*:\s*grid|var\s*\(\s*--|@media|@keyframes|@import|url\s*\()/i.test(normalized)) {
    errors.push('生成结果包含不安全或不兼容的 CSS');
  }
  if (/\b(?:href|src)\s*=\s*["']\s*(?:javascript|data:text\/html):/i.test(normalized)) {
    errors.push('生成结果包含不安全链接');
  }
  if (/[\u3400-\u9fff]/u.test(normalized) && !/<span\b[^>]*\bleaf(?:\s*=|\s|>)/i.test(normalized)) {
    errors.push('生成结果缺少 span leaf 文字包裹');
  }
  for (const token of expectedAssetTokens) {
    if (!normalized.includes(token)) errors.push(`生成结果遗漏图片 ${token}`);
  }
  return errors;
}

function extractHtmlFromOutput(output: string): string | null {
  const start = output.indexOf('<section');
  const end = output.lastIndexOf('</section>');
  return start >= 0 && end > start ? output.slice(start, end + '</section>'.length) : null;
}

export function normalizeGeneratedThemeHtml(html: string): string {
  return html
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<svg\b[^>]*\/\s*>/gi, '')
    .trim();
}

function generationPrompt(values: {
  skillRoot: string;
  themeLabel: string;
  themeReference?: string;
  customTheme?: WeChatCustomThemePreferences;
  inputPath: string;
  outputPath: string;
}): string {
  const themeInstruction = values.customTheme
    ? [
      `这是 WeSight 的 AI 自定义主题自动化流程。请完整读取 ${path.join(values.skillRoot, 'references', 'theme-generator.md')}。`,
      `用户给主题取名为“${values.customTheme.name || 'AI自定义主题'}”。主题描述如下：\n${values.customTheme.description}`,
      '先依据 theme-generator.md 推导主题结构模型、颜色系统、字体、圆角、阴影和组件语言，再把这套风格直接应用到当前文章。',
      '用户会在 WeSight 的文章预览中整体确认本次风格，因此不要提问，也不要创建或修改 gzh-design Skill 内的主题文件。',
    ]
    : [
      `本次固定使用主题“${values.themeLabel}”，主题组件库为 ${path.join(values.skillRoot, values.themeReference ?? '')}。`,
    ];
  return [
    `请完整读取并严格执行 ${path.join(values.skillRoot, 'SKILL.md')}。`,
    ...themeInstruction,
    `输入文章位于 ${values.inputPath}。这是全自动排版，不要提问，不要改变或遗漏原文实质内容。`,
    '必须原样保留所有 wesight-wechat-asset:// 开头的图片地址，不得替换、删除或重写。',
    '禁止使用 svg、iframe、object、embed、form、button、input、textarea、select、video、audio、canvas；装饰图标请改用纯文字或 emoji。',
    `最终只生成公众号正文 section 片段，将其写入 ${values.outputPath}。`,
    `使用 ${path.join(values.skillRoot, 'scripts', 'validate_gzh_html.py')} 校验并修复到 0 ERROR。`,
    '完成后只需简短说明已写入文件；不要在回复中重复整篇 HTML。',
  ].join('\n');
}

export class WeChatThemeService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: WeChatThemeServiceOptions) {
    this.env = options.env ?? process.env;
  }

  getCached(
    snapshot: WeChatPreviewSnapshot,
    themeId: WeChatThemeId,
  ): WeChatThemeDocument | null {
    const context = this.resolveContext(snapshot, themeId);
    if (!context) return null;
    return this.getCachedForContext(snapshot, themeId, context);
  }

  async generate(
    snapshot: WeChatPreviewSnapshot,
    themeId: WeChatThemeId,
    options: GenerateThemeOptions = {},
  ): Promise<WeChatThemeDocument> {
    const theme = getWeChatTheme(themeId);
    if (theme.kind === 'template') {
      throw new Error('当前主题不需要通过 Skill 生成');
    }
    const settings = this.options.getSettings();
    const customTheme = theme.kind === 'custom'
      ? options.customTheme ?? customThemeFromSettings(settings)
      : undefined;
    if (theme.kind === 'custom' && !customTheme?.description.trim()) {
      throw new Error('请先填写 AI 自定义主题描述');
    }
    const context = this.resolveContext(snapshot, themeId, customTheme);
    if (!context) {
      throw new Error(
        '未检测到 gzh-design Skill，请先按项目说明安装：https://github.com/isjiamu/gzh-design-skill',
      );
    }
    if (!options.force) {
      const cached = this.getCachedForContext(snapshot, themeId, context);
      if (cached) return cached;
    }

    const runDir = path.join(tmpDir(this.env), 'wechat-theme-runs', createId('run'));
    ensureDir(runDir);
    const inputPath = path.join(runDir, 'article.md');
    const outputPath = path.join(runDir, 'article.html');
    const agentId = settings.defaultAgentId;
    const outputParts: string[] = [];
    let runtimeError: string | null = null;
    const themeLabel = customTheme?.name || theme.label;
    options.onProgress?.({ label: `正在使用 ${themeLabel} 生成排版…` });
    try {
      fs.writeFileSync(inputPath, snapshot.markdown, { encoding: 'utf8', mode: 0o600 });
      await this.options.runtimeManager.runTurn({
        conversationId: createId('wechat-theme'),
        agentId,
        prompt: generationPrompt({
          skillRoot: context.skillRoot,
          themeLabel,
          themeReference: theme.skillReference,
          customTheme,
          inputPath,
          outputPath,
        }),
        cwd: runDir,
        configSource: settings.configSources[agentId],
        providerProfileId: settings.providerProfileByAgent[agentId] || undefined,
        model: settings.localModelByAgent[agentId] || undefined,
        planMode: false,
      }, event => {
        if (event.type === 'text') outputParts.push(event.content);
        if (event.type === 'error') runtimeError = [event.message, event.detail].filter(Boolean).join('：');
      });
      appendLocalLog('wechat_theme_runtime_complete', {
        themeId,
        sourceHash: snapshot.contentHash,
        outputFileExists: fileExists(outputPath),
        outputTextParts: outputParts.length,
        runtimeError: runtimeError ? 'present' : null,
      }, this.env);
      if (runtimeError) throw new Error(runtimeError);
      const rawHtml = fileExists(outputPath)
        ? fs.readFileSync(outputPath, 'utf8')
        : extractHtmlFromOutput(outputParts.join('\n'));
      if (!rawHtml) throw new Error('模型没有生成公众号 HTML 文件');
      const html = normalizeGeneratedThemeHtml(rawHtml);
      options.onProgress?.({ label: `正在校验 ${themeLabel} 排版…` });
      const errors = validateGeneratedThemeHtml(html, usedAssetTokens(snapshot));
      if (errors.length) {
        appendLocalLog('wechat_theme_validation_failed', {
          themeId,
          sourceHash: snapshot.contentHash,
          outputBytes: Buffer.byteLength(html, 'utf8'),
          errors,
        }, this.env);
        throw new Error(errors.join('；'));
      }
      const document: CachedThemeDocument = {
        version: 1,
        cacheKey: context.key,
        themeId,
        sourceHash: snapshot.contentHash,
        contentHash: hashSkillThemeDocument({
          sourceHash: snapshot.contentHash,
          themeId,
          html: html.trim(),
          generatorSignature: context.signature,
        }),
        html: html.trim(),
        generatedAt: new Date().toISOString(),
        generatorSignature: context.signature,
      };
      ensureDir(wechatThemeCacheDir(this.env));
      writeJsonFile(cachePath(context.key, this.env), document);
      appendLocalLog('wechat_theme_cached', {
        themeId,
        sourceHash: snapshot.contentHash,
        contentHash: document.contentHash,
        outputBytes: Buffer.byteLength(document.html ?? '', 'utf8'),
      }, this.env);
      return document;
    } catch (error) {
      appendLocalLog('wechat_theme_generation_failed', {
        themeId,
        sourceHash: snapshot.contentHash,
        message: error instanceof Error ? error.message : String(error),
      }, this.env);
      throw error;
    } finally {
      safeRemoveDir(runDir);
    }
  }

  private resolveContext(
    snapshot: WeChatPreviewSnapshot,
    themeId: WeChatThemeId,
    customTheme?: WeChatCustomThemePreferences,
  ): { key: string; signature: string; skillRoot: string } | null {
    const theme = getWeChatTheme(themeId);
    if (theme.kind === 'template') return null;
    const skillRoot = resolveGzhSkillRoot(themeId, this.env);
    if (!skillRoot) return null;
    const skillFingerprint = skillSignature(skillRoot, themeId);
    const generatorFingerprint = generatorSignature(
      this.options.getSettings(),
      this.options.providerStore,
    );
    const themeFingerprint = theme.kind === 'custom'
      ? sha256(JSON.stringify(customTheme ?? customThemeFromSettings(this.options.getSettings())))
      : themeId;
    const signature = [skillFingerprint, generatorFingerprint, themeFingerprint].join(':');
    return {
      skillRoot,
      signature,
      key: cacheKey({
        sourceHash: snapshot.contentHash,
        themeId,
        skillSignature: skillFingerprint,
        generatorSignature: [generatorFingerprint, themeFingerprint].join(':'),
      }),
    };
  }

  private getCachedForContext(
    snapshot: WeChatPreviewSnapshot,
    themeId: WeChatThemeId,
    context: { key: string },
  ): WeChatThemeDocument | null {
    const cached = readJsonFile<CachedThemeDocument | null>(cachePath(context.key, this.env), null);
    if (
      !cached
      || cached.version !== 1
      || cached.cacheKey !== context.key
      || cached.themeId !== themeId
      || cached.sourceHash !== snapshot.contentHash
    ) return null;
    const errors = validateGeneratedThemeHtml(cached.html ?? '', usedAssetTokens(snapshot));
    return errors.length ? null : cached;
  }
}
