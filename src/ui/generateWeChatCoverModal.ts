import { App, Modal, Setting, setIcon } from 'obsidian';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import type { RuntimeManager } from '../runtime/runtimeManager';
import type { WeSightObsidianSettings } from '../types';
import type { WeChatPreviewSnapshot, WeChatAssetDraft } from '../wechat/types';
import { createId } from '../utils/id';
import { ensureDir, safeRemoveDir } from '../utils/fs';
import { tmpDir } from '../paths';
import { coverGeneratorConfigError } from './wechatCoverGeneratorConfig';

export interface WeChatCoverGeneratorOptions {
  runtimeManager: RuntimeManager;
  getSettings: () => WeSightObsidianSettings;
  snapshot: WeChatPreviewSnapshot;
}

export function promptForWeChatCover(
  app: App,
  options: WeChatCoverGeneratorOptions,
): Promise<WeChatAssetDraft | null> {
  return new Promise(resolve => {
    new GenerateWeChatCoverModal(app, options, resolve).open();
  });
}

class GenerateWeChatCoverModal extends Modal {
  private requirement = '';
  private generating = false;
  private checking = true;
  private error: string | null = null;
  private controller: AbortController | null = null;
  private selectedAsset: WeChatAssetDraft | null = null;

  constructor(
    app: App,
    private readonly options: WeChatCoverGeneratorOptions,
    private readonly resolve: (value: WeChatAssetDraft | null) => void,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.checking = true;
    this.render();
    await this.refreshCodexStatus();
  }

  override onClose(): void {
    this.abortGeneration();
    this.contentEl.empty();
    this.resolve(this.selectedAsset);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-cover-generator-modal');
    contentEl.createEl('h2', { text: 'AI 生成公众号封面' });

    if (this.checking) {
      contentEl.createDiv({
        cls: 'wesight-cover-generator-status',
        text: '正在检查 Codex 图片生成能力…',
      });
      return;
    }

    const settings = this.options.getSettings();
    const status = this.options.runtimeManager.getCodexStatus();

    const configError = coverGeneratorConfigError(settings, status);
    if (configError) {
      contentEl.createEl('p', {
        cls: 'wesight-cover-generator-error',
        text: configError,
      });
      const actions = this.renderCloseAction();
      if (status.imageGeneration !== true) {
        actions.addButton(button => button
          .setButtonText('刷新状态')
          .onClick(() => void this.refreshCodexStatus()));
      }
      return;
    }

    contentEl.createEl('p', {
      cls: 'wesight-cover-generator-intro',
      text: '将使用本地 Codex 为当前文章生成一张 2.35:1 的封面图。',
    });

    new Setting(contentEl)
      .setName('封面风格描述（可选）')
      .setDesc('例如：科技感、极简、暖色调、真人实景等。留空则按文章内容自动推断。')
      .addTextArea(text => {
        text.setPlaceholder('科技感、极简、暖色调');
        text.setValue(this.requirement);
        text.onChange(value => {
          this.requirement = value;
        });
        text.inputEl.rows = 3;
      });

    const actions = new Setting(contentEl);
    actions.settingEl.addClass('wesight-cover-generator-actions');
    actions
      .addButton(button => {
        button.setButtonText(this.generating ? '生成中…' : '生成封面');
        button.setCta();
        button.setDisabled(this.generating);
        if (this.generating) {
          const icon = button.buttonEl.createSpan();
          setIcon(icon, 'loader-circle');
          button.buttonEl.prepend(icon);
        }
        button.onClick(() => void this.generate());
      })
      .addButton(button => button
        .setButtonText('关闭')
        .onClick(() => this.close()));

    if (this.error) {
      contentEl.createDiv({
        cls: 'wesight-cover-generator-error',
        text: this.error,
      });
    }
  }

  private renderCloseAction(): Setting {
    const actions = new Setting(this.contentEl);
    actions.settingEl.addClass('wesight-cover-generator-actions');
    actions.addButton(button => button
      .setButtonText('关闭')
      .onClick(() => this.close()));
    return actions;
  }

  private abortGeneration(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  private async refreshCodexStatus(): Promise<void> {
    this.checking = true;
    if (this.contentEl.isConnected) this.render();
    try {
      await this.options.runtimeManager.refreshCodexStatus();
    } catch {
      // render() will reflect the latest status/error
    }
    this.checking = false;
    if (this.contentEl.isConnected) this.render();
  }

  private async generate(): Promise<void> {
    if (this.generating) return;
    const settings = this.options.getSettings();
    let status = this.options.runtimeManager.getCodexStatus();

    if (coverGeneratorConfigError(settings, status)) {
      await this.refreshCodexStatus();
      status = this.options.runtimeManager.getCodexStatus();
      const configError = coverGeneratorConfigError(settings, status);
      if (configError) {
        this.error = configError;
        this.generating = false;
        if (this.contentEl.isConnected) this.render();
        return;
      }
    }

    this.abortGeneration();
    this.controller = new AbortController();
    this.generating = true;
    this.error = null;
    this.render();

    const runDir = path.join(tmpDir(process.env), 'wechat-cover-runs', createId('run'));
    ensureDir(runDir);
    try {
      let sourcePath: string | null = null;
      let runtimeError: string | null = null;
      const controller = this.controller;

      await this.options.runtimeManager.runTurn({
        conversationId: createId('wechat-cover'),
        agentId: 'codex',
        prompt: buildCoverGenerationPrompt(this.options.snapshot, this.requirement),
        cwd: runDir,
        configSource: 'localCli',
        planMode: false,
        signal: controller.signal,
      }, event => {
        if (event.type === 'artifact' && event.artifact.kind === 'image') {
          sourcePath = event.artifact.sourcePath;
        } else if (event.type === 'error') {
          runtimeError = [event.message, event.detail].filter(Boolean).join('：');
        }
      });

      if (controller.signal.aborted) return;
      if (runtimeError) {
        throw new Error(runtimeError);
      }
      if (!sourcePath) {
        throw new Error('Codex 没有返回生成的图片。');
      }

      const bytes = fs.readFileSync(sourcePath);
      const detected = detectImageFormat(bytes);
      if (!detected) {
        throw new Error('生成的图片格式不支持，请确认 Codex 输出的是 PNG/JPEG/GIF/WebP。');
      }
      const previewUrl = URL.createObjectURL(new Blob([bytes], { type: detected.mimeType }));
      this.selectedAsset = {
        token: '',
        source: path.basename(sourcePath),
        fileName: `cover-${Date.now()}${detected.extension}`,
        mimeType: detected.mimeType,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        body: Uint8Array.from(bytes).buffer,
        previewUrl,
      };
      this.close();
    } catch (error) {
      if (this.controller?.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '封面生成失败';
      this.generating = false;
      if (this.contentEl.isConnected) this.render();
    } finally {
      safeRemoveDir(runDir);
      if (!this.selectedAsset) {
        this.generating = false;
      }
    }
  }
}

function buildCoverGenerationPrompt(snapshot: WeChatPreviewSnapshot, requirement: string): string {
  const title = snapshot.title.trim();
  let article = snapshot.markdown.trim();
  if (article.length > 1200) {
    article = article.slice(0, 1200);
  }
  const sections: string[] = [
    '请为下面这篇文章生成一张微信公众号封面图。',
    '要求：',
    '- 比例必须是 2.35:1 的横版封面。',
    '- 画面简洁、主题突出，适合作为公众号文章首图。',
    '- 不要包含二维码、联系方式、敏感信息。',
  ];
  if (requirement.trim()) {
    sections.push(`风格要求：${requirement.trim()}`);
  }
  if (title) {
    sections.push(`文章标题：${title}`);
  }
  sections.push('===== 文章内容 START =====');
  sections.push(article);
  if (article.length >= 1200) {
    sections.push('（后文已省略）');
  }
  sections.push('===== 文章内容 END =====');
  sections.push('请直接生成图片，不要输出解释或代码。');
  return sections.join('\n');
}

function detectImageFormat(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
    bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
  ) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 &&
    (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return null;
}
