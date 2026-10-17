import path from 'path';
import { readFile, writeFile } from 'fs/promises';

import type { MultiPublishSnapshot } from '../multiPublish/types';
import type { RuntimeManager } from '../runtime/runtimeManager';
import type { VaultStore } from '../storage/vaultStore';
import type { WeSightObsidianSettings } from '../types';
import { tmpDir } from '../paths';
import { createId } from '../utils/id';
import { ensureDir, safeRemoveDir } from '../utils/fs';
import { mergeRuntimeText } from '../wechat/themeService';
import {
  buildWeiboPostCopyPrompt,
  parseWeiboPostCopyOutput,
} from '../weiboPost/copy';
import type { WeiboPostCopyDraft, WeiboPostTone } from '../weiboPost/types';
import {
  buildJikePostCopyPrompt,
  parseJikePostCopyOutput,
} from '../jikePost/copy';
import type { JikePostCopyDraft, JikePostTone } from '../jikePost/types';
import { buildXPostCopyPrompt, parseXPostCopyOutput } from '../xPost/copy';
import type { XPostCopyDraft } from '../xPost/types';
import {
  buildXhsCopyPrompt,
  buildXhsPageContentsPrompt,
  buildXhsSinglePageContentPrompt,
  parseXhsCopyOutput,
  parseXhsPageContentsOutput,
  parseXhsSinglePageContentOutput,
} from './copy';
import { computeXhsImageCrop } from './image';
import {
  buildXhsRecommendationPrompt,
  parseXhsRecommendationOutput,
} from './recommendation';
import {
  buildXhsTypographyPageInput,
  renderXhsTypographyTemplateBlob,
} from './typographyTemplates';
import {
  getXhsCategory,
  getXhsStyle,
  type XhsCopyDraft,
  type XhsGeneratedPage,
  type XhsImageRatio,
  type XhsPageContent,
  type XhsStyleChoice,
  type XhsStyleRecommendation,
} from './types';

export interface XiaohongshuGenerationServiceOptions {
  runtimeManager: RuntimeManager;
  vaultStore: VaultStore;
  getSettings: () => WeSightObsidianSettings;
  env?: NodeJS.ProcessEnv;
}

export interface XhsImageGenerationProgress {
  completed: number;
  total: number;
  label: string;
}

export class XiaohongshuGenerationService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: XiaohongshuGenerationServiceOptions) {
    this.env = options.env ?? process.env;
  }

  async recommend(snapshot: MultiPublishSnapshot, signal: AbortSignal): Promise<XhsStyleRecommendation> {
    const output = await this.runText(
      'xiaohongshu-style',
      buildXhsRecommendationPrompt(snapshot.markdown),
      signal,
    );
    const recommendation = parseXhsRecommendationOutput(output);
    if (!recommendation) throw new Error('当前引擎没有返回可用的图片风格推荐');
    return recommendation;
  }

  async generateCopy(
    snapshot: MultiPublishSnapshot,
    requirement: string,
    signal: AbortSignal,
  ): Promise<XhsCopyDraft> {
    const output = await this.runText(
      'xiaohongshu-copy',
      buildXhsCopyPrompt(snapshot, requirement),
      signal,
    );
    const copy = parseXhsCopyOutput(output);
    if (!copy) throw new Error('当前引擎没有返回可用的小红书文案');
    return copy;
  }

  async generateWeiboPostCopy(
    snapshot: MultiPublishSnapshot,
    tone: WeiboPostTone,
    customPrompt: string,
    signal: AbortSignal,
  ): Promise<WeiboPostCopyDraft> {
    const output = await this.runText(
      'weibo-post-copy',
      buildWeiboPostCopyPrompt(snapshot, tone, customPrompt),
      signal,
    );
    const copy = parseWeiboPostCopyOutput(output, tone);
    if (!copy) throw new Error('当前引擎没有返回可用的微博文案');
    return copy;
  }

  async generateJikePostCopy(
    snapshot: MultiPublishSnapshot,
    tone: JikePostTone,
    customPrompt: string,
    signal: AbortSignal,
  ): Promise<JikePostCopyDraft> {
    const output = await this.runText(
      'jike-post-copy',
      buildJikePostCopyPrompt(snapshot, tone, customPrompt),
      signal,
    );
    const copy = parseJikePostCopyOutput(output, tone);
    if (!copy) throw new Error('当前引擎没有返回可用的即刻动态文案');
    return copy;
  }

  async generateXPostCopy(
    snapshot: MultiPublishSnapshot,
    customPrompt: string,
    signal: AbortSignal,
  ): Promise<XPostCopyDraft> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
      const requirement = [customPrompt, attempt ? '上次返回格式无效或超出 X 字符限制，请重新组织完整短句；减少话题，中文正文控制在 100 字以内。' : '']
        .filter(Boolean).join('\n');
      const output = await this.runText('x-post-copy', buildXPostCopyPrompt(snapshot, requirement), signal);
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
      const copy = parseXPostCopyOutput(output);
      if (copy) return copy;
    }
    throw new Error('当前引擎未返回符合 X 280 字符限制的完整文案，请重试或调整要求');
  }

  async generatePageContents(
    snapshot: MultiPublishSnapshot,
    copy: XhsCopyDraft,
    pageCount: number,
    signal: AbortSignal,
  ): Promise<XhsPageContent[]> {
    const output = await this.runText(
      'xiaohongshu-page-contents',
      buildXhsPageContentsPrompt(snapshot, copy, pageCount),
      signal,
    );
    const pages = parseXhsPageContentsOutput(output, pageCount);
    if (!pages) throw new Error('当前引擎没有返回完整的逐页图片内容');
    return pages;
  }

  async regeneratePageContent(
    snapshot: MultiPublishSnapshot,
    copy: XhsCopyDraft,
    page: XhsPageContent,
    pageCount: number,
    signal: AbortSignal,
  ): Promise<XhsPageContent> {
    const output = await this.runText(
      `xiaohongshu-page-${page.pageNumber}`,
      buildXhsSinglePageContentPrompt(snapshot, copy, page, pageCount),
      signal,
    );
    const generated = parseXhsSinglePageContentOutput(output, page.pageNumber);
    if (!generated) throw new Error(`当前引擎没有返回第 ${page.pageNumber} 张的可用内容`);
    return generated;
  }

  async generateImages(options: {
    draftId: string;
    copy: XhsCopyDraft;
    pageContents: XhsPageContent[];
    style: XhsStyleChoice;
    customStylePrompt: string;
    imageRatio?: XhsImageRatio;
    referenceImages?: Array<{ fileName: string; mimeType: string; body: ArrayBuffer }>;
    sourceMarkdown?: string;
    pageCount?: number;
    onPage?: (page: XhsGeneratedPage) => void;
    signal: AbortSignal;
    onProgress?: (progress: XhsImageGenerationProgress) => void;
  }): Promise<XhsGeneratedPage[]> {
    if (options.style.categoryId === 'typography') {
      return await this.generateTypographyImages(options);
    }

    const settings = this.options.getSettings();
    if (settings.configSources.codex !== 'localCli') {
      throw new Error('图片生成需要使用本机 Codex 配置');
    }
    const status = await this.options.runtimeManager.refreshCodexStatus();
    if (!status.binaryPath) throw new Error(status.error || '未检测到本机 Codex');
    if (status.imageGeneration !== true) throw new Error('当前 Codex 模型或配置不支持图片生成');

    const total = options.pageContents.length;
    const results: Array<XhsGeneratedPage | null> = Array.from({ length: total }, () => null);
    let nextIndex = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        if (options.signal.aborted) throw new DOMException('已停止生成', 'AbortError');
        const pageContent = options.pageContents[index];
        options.onProgress?.({ completed, total, label: `正在生成第 ${index + 1}/${total} 张` });
        const artifact = await this.generateOneImage({
          draftId: options.draftId,
          copy: options.copy,
          pageContent,
          pageNumber: pageContent.pageNumber,
          pageCount: options.pageCount ?? total,
          style: options.style,
          customStylePrompt: options.customStylePrompt,
          imageRatio: options.imageRatio,
          referenceImages: options.referenceImages,
          sourceMarkdown: options.sourceMarkdown,
          signal: options.signal,
        });
        results[index] = artifact;
        options.onPage?.(artifact);
        completed += 1;
        options.onProgress?.({ completed, total, label: `已完成 ${completed}/${total} 张` });
      }
    };

    const concurrency = Math.min(3, total);
    const workers = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
    const failure = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.filter((page): page is XhsGeneratedPage => Boolean(page));
  }

  private async generateTypographyImages(options: {
    draftId: string;
    copy: XhsCopyDraft;
    pageContents: XhsPageContent[];
    style: XhsStyleChoice;
    signal: AbortSignal;
    onProgress?: (progress: XhsImageGenerationProgress) => void;
  }): Promise<XhsGeneratedPage[]> {
    const total = options.pageContents.length;
    const runDir = path.join(
      tmpDir(this.env),
      'xiaohongshu-template-runs',
      createId('typography'),
    );
    ensureDir(runDir);
    const results: Array<XhsGeneratedPage | null> = Array.from({ length: total }, () => null);
    let nextIndex = 0;
    let completed = 0;
    try {
      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= total) return;
          if (options.signal.aborted) throw new DOMException('已停止生成', 'AbortError');
          const pageContent = options.pageContents[index];
          options.onProgress?.({ completed, total, label: `正在渲染第 ${index + 1}/${total} 张` });
          const input = buildXhsTypographyPageInput(
            pageContent.text,
            index + 1,
            total,
          );
          const blob = await renderXhsTypographyTemplateBlob(options.style.styleId, input);
          if (options.signal.aborted) throw new DOMException('已停止生成', 'AbortError');
          const sourcePath = path.join(runDir, `page-${index + 1}.png`);
          await writeFile(sourcePath, new Uint8Array(await blob.arrayBuffer()));
          const artifact = await this.options.vaultStore.importGeneratedImage(options.draftId, {
            itemId: createId(`xiaohongshu-template-${index + 1}`),
            sourcePath,
            mimeType: 'image/png',
          });
          results[index] = {
            ...artifact,
            pageNumber: index + 1,
            label: pageContent.label,
          };
          completed += 1;
          options.onProgress?.({ completed, total, label: `已完成 ${completed}/${total} 张` });
        }
      };
      const concurrency = Math.min(3, total);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      return results.filter((page): page is XhsGeneratedPage => Boolean(page));
    } finally {
      safeRemoveDir(runDir);
    }
  }

  private async runText(kind: string, prompt: string, signal: AbortSignal): Promise<string> {
    const settings = this.options.getSettings();
    const agentId = settings.defaultAgentId;
    const runDir = path.join(tmpDir(this.env), 'xiaohongshu-runs', createId(kind));
    ensureDir(runDir);
    let output = '';
    let runtimeError: string | null = null;
    try {
      await this.options.runtimeManager.runTurn({
        conversationId: createId(kind),
        agentId,
        prompt,
        cwd: runDir,
        configSource: settings.configSources[agentId],
        providerProfileId: settings.providerProfileByAgent[agentId] || undefined,
        model: (settings.configSources[agentId] === 'wesightManaged' ? settings.memberAiModel : settings.localModelByAgent[agentId]) || undefined,
        planMode: false,
        textOnly: true,
        accessMode: 'read-only',
        logPolicy: 'metadata-only',
        signal,
      }, event => {
        if (event.type === 'text') output = mergeRuntimeText(output, event.content);
        if (event.type === 'error') runtimeError = [event.message, event.detail].filter(Boolean).join('：');
      });
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
      if (runtimeError) throw new Error(runtimeError);
      if (!output.trim()) throw new Error('当前引擎没有返回内容');
      return output;
    } finally {
      safeRemoveDir(runDir);
    }
  }

  private async generateOneImage(options: {
    draftId: string;
    copy: XhsCopyDraft;
    pageContent: XhsPageContent;
    pageNumber: number;
    pageCount: number;
    style: XhsStyleChoice;
    customStylePrompt: string;
    imageRatio?: XhsImageRatio;
    referenceImages?: Array<{ fileName: string; mimeType: string; body: ArrayBuffer }>;
    sourceMarkdown?: string;
    signal: AbortSignal;
  }): Promise<XhsGeneratedPage> {
    const runDir = path.join(
      tmpDir(this.env),
      'xiaohongshu-image-runs',
      createId(`page-${options.pageNumber}`),
    );
    ensureDir(runDir);
    let sourcePath: string | null = null;
    let itemId = createId('xiaohongshu-image');
    let mimeType: string | undefined;
    let revisedPrompt: string | undefined;
    let runtimeError: string | null = null;
    const settings = this.options.getSettings();
    try {
      const referencePaths: string[] = [];
      for (const [index, reference] of (options.referenceImages ?? []).entries()) {
        const extension = reference.mimeType === 'image/jpeg' ? '.jpg' : reference.mimeType === 'image/webp' ? '.webp' : '.png';
        const referencePath = path.join(runDir, `reference-${index + 1}${extension}`);
        await writeFile(referencePath, new Uint8Array(reference.body));
        referencePaths.push(referencePath);
      }
      await this.options.runtimeManager.runTurn({
        conversationId: createId('xiaohongshu-image'),
        agentId: 'codex',
        prompt: buildXhsImagePrompt({ ...options, referencePaths }),
        cwd: runDir,
        configSource: 'localCli',
        model: settings.localModelByAgent.codex || undefined,
        planMode: false,
        accessMode: 'workspace-write',
        logPolicy: 'metadata-only',
        signal: options.signal,
      }, event => {
        if (event.type === 'artifact' && event.artifact.kind === 'image') {
          sourcePath = event.artifact.sourcePath;
          itemId = event.artifact.itemId || itemId;
          mimeType = event.artifact.mimeType;
          revisedPrompt = event.artifact.revisedPrompt;
        }
        if (event.type === 'error') runtimeError = [event.message, event.detail].filter(Boolean).join('：');
      });
      if (options.signal.aborted) throw new DOMException('已停止生成', 'AbortError');
      if (runtimeError) throw new Error(runtimeError);
      if (!sourcePath) throw new Error(`第 ${options.pageNumber} 张图片没有生成结果`);
      const normalized = await normalizeXhsImage(sourcePath, runDir, mimeType, options.signal, options.imageRatio);
      const artifact = await this.options.vaultStore.importGeneratedImage(options.draftId, {
        itemId,
        sourcePath: normalized.sourcePath,
        mimeType: normalized.mimeType,
        revisedPrompt,
      });
      return {
        ...artifact,
        pageNumber: options.pageNumber,
        label: options.pageContent.label,
      };
    } finally {
      safeRemoveDir(runDir);
    }
  }
}

async function normalizeXhsImage(
  sourcePath: string,
  runDir: string,
  mimeType: string | undefined,
  signal: AbortSignal,
  ratio: XhsImageRatio = '3:4',
): Promise<{ sourcePath: string; mimeType: string | undefined }> {
  if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
  const bytes = new Uint8Array(await readFile(sourcePath));
  const bitmap = await createImageBitmap(new Blob([bytes], {
    type: mimeType || 'application/octet-stream',
  }));
  try {
    const crop = computeXhsImageCrop(bitmap.width, bitmap.height, ratio);
    if (crop.targetWidth === bitmap.width && crop.targetHeight === bitmap.height) {
      return { sourcePath, mimeType };
    }
    const canvas = document.body.createEl('canvas');
    canvas.hidden = true;
    canvas.width = crop.targetWidth;
    canvas.height = crop.targetHeight;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建图片处理画布');
      context.drawImage(
        bitmap,
        crop.sourceX,
        crop.sourceY,
        crop.sourceWidth,
        crop.sourceHeight,
        0,
        0,
        crop.targetWidth,
        crop.targetHeight,
      );
      const output = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error(`无法导出 ${ratio} 图片`));
        }, 'image/png');
      });
      if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
      const normalizedPath = path.join(runDir, 'normalized-3x4.png');
      await writeFile(normalizedPath, new Uint8Array(await output.arrayBuffer()));
      return { sourcePath: normalizedPath, mimeType: 'image/png' };
    } finally {
      canvas.remove();
    }
  } finally {
    bitmap.close();
  }
}

export function buildXhsImagePrompt(options: {
  copy: XhsCopyDraft;
  pageContent: XhsPageContent;
  pageNumber: number;
  pageCount: number;
  style: XhsStyleChoice;
  customStylePrompt: string;
  imageRatio?: XhsImageRatio;
  sourceMarkdown?: string;
  referencePaths?: string[];
}): string {
  const category = getXhsCategory(options.style.categoryId);
  const style = getXhsStyle(options.style.categoryId, options.style.styleId);
  return [
    `请生成一张小红书图文轮播图片，这是第 ${options.pageNumber}/${options.pageCount} 张。`,
    `画布比例为 ${options.imageRatio ?? '3:4'}，适合小红书图片浏览。`,
    `视觉大类：${category.label}（${category.description}）`,
    `二级样式：${style.label}（${style.description}）`,
    options.customStylePrompt.trim() ? `用户自定义风格：${options.customStylePrompt.trim()}` : '',
    `整组标题：${options.copy.title}`,
    `本页主题：${options.pageContent.label}`,
    `本页内容参考：${options.pageContent.text}`,
    `文章内容参考：${(options.sourceMarkdown || options.copy.body).slice(0, 16000)}`,
    options.referencePaths?.length ? `请读取并使用这些参考图片：${options.referencePaths.map(value => JSON.stringify(value)).join('、')}` : '',
    '要求：',
    '- 根据视觉大类、二级样式和文章内容构思画面，保持整组图片的画风连贯。',
    '- 摄影类以真实场景、人物或物品表达主题；插画类以场景叙事表达内容；拼贴类按所选风格组织素材。',
    '- 信息图解与截图增强仅按需要加入准确、清晰的说明文字。摄影和插画默认不叠加大段文字。',
    '- 配色、构图与材质遵循用户选择的风格和参考图。',
    '- 只使用本页内容，不添加原文没有的事实、数据或品牌。',
    '- 不包含二维码、联系方式、水印或平台按钮。',
    '- 请直接生成图片，不要输出解释或代码。',
  ].filter(Boolean).join('\n');
}
