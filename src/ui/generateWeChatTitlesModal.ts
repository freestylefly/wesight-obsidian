import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import path from 'path';

import type { RuntimeManager } from '../runtime/runtimeManager';
import type { WeSightObsidianSettings } from '../types';
import type { WeChatPreviewSnapshot } from '../wechat/types';
import { createId } from '../utils/id';
import { ensureDir, safeRemoveDir } from '../utils/fs';
import { tmpDir } from '../paths';
import { mergeRuntimeText } from '../wechat/themeService';

export interface WeChatTitleGeneratorOptions {
  runtimeManager: RuntimeManager;
  getSettings: () => WeSightObsidianSettings;
  snapshot: WeChatPreviewSnapshot;
}

export function promptForWeChatTitles(
  app: App,
  options: WeChatTitleGeneratorOptions,
): Promise<string | null> {
  return new Promise(resolve => {
    new GenerateWeChatTitlesModal(app, options, resolve).open();
  });
}

const MAX_CONTEXT_CHARS = 6000;

class GenerateWeChatTitlesModal extends Modal {
  private requirement = '';
  private generating = false;
  private error: string | null = null;
  private suggestions: string[] = [];
  private controller: AbortController | null = null;
  private selected: string | null = null;

  constructor(
    app: App,
    private readonly options: WeChatTitleGeneratorOptions,
    private readonly resolve: (value: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.abortGeneration();
    this.contentEl.empty();
    this.resolve(this.selected);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-title-generator-modal');
    contentEl.createEl('h2', { text: 'AI 生成爆款标题' });
    contentEl.createEl('p', {
      cls: 'wesight-title-generator-intro',
      text: '将基于当前文章内容和当前配置的模型生成 5 个标题，可重复生成。',
    });

    new Setting(contentEl)
      .setName('补充要求（可选）')
      .setDesc('例如：更口语化、突出痛点、带数字、偏科技感等。留空则按默认爆款风格生成。')
      .addTextArea(text => {
        text.setPlaceholder('更口语化 / 突出痛点 / 带数字');
        text.setValue(this.requirement);
        text.onChange(value => {
          this.requirement = value;
        });
        text.inputEl.rows = 3;
      });

    const actions = new Setting(contentEl);
    actions.settingEl.addClass('wesight-title-generator-actions');
   actions
     .addButton(button => {
        button.setButtonText(
          this.generating
            ? '生成中…'
            : this.suggestions.length > 0
              ? '重新生成'
              : '生成标题',
        );
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
        cls: 'wesight-title-generator-error',
        text: this.error,
      });
    }

    if (this.suggestions.length > 0) {
      const list = contentEl.createDiv({ cls: 'wesight-title-generator-suggestions' });
      list.createEl('p', {
        cls: 'wesight-title-generator-suggestions-heading',
        text: '点击标题直接回填',
      });
      for (const suggestion of this.suggestions) {
        const row = list.createEl('button', {
          cls: 'wesight-title-generator-suggestion-row',
          attr: { type: 'button' },
        });
        row.createSpan({
          cls: 'wesight-title-generator-suggestion-text',
          text: suggestion,
        });
        row.createSpan({
          cls: 'wesight-title-generator-suggestion-select',
          text: '选用',
        });
        row.onclick = () => {
          this.selected = suggestion;
          this.close();
        };
      }
    }
  }

  private abortGeneration(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  private async generate(): Promise<void> {
    if (this.generating) return;
    this.abortGeneration();
    this.controller = new AbortController();
    this.generating = true;
    this.error = null;
    this.suggestions = [];
    this.render();

    const runDir = path.join(tmpDir(process.env), 'wechat-title-runs', createId('run'));
    ensureDir(runDir);
    try {
      const settings = this.options.getSettings();
      const agentId = settings.defaultAgentId;
      let outputText = '';
      let runtimeError: string | null = null;
      const controller = this.controller;

      await this.options.runtimeManager.runTurn({
        conversationId: createId('wechat-title'),
        agentId,
        prompt: buildTitleGenerationPrompt(this.options.snapshot, this.requirement),
        cwd: runDir,
        configSource: settings.configSources[agentId],
        providerProfileId: settings.providerProfileByAgent[agentId] || undefined,
        model: settings.localModelByAgent[agentId] || undefined,
        planMode: false,
        textOnly: true,
        signal: controller.signal,
      }, event => {
        if (event.type === 'text') {
          outputText = mergeRuntimeText(outputText, event.content);
        } else if (event.type === 'error') {
          runtimeError = [event.message, event.detail].filter(Boolean).join('：');
        }
      });

      if (controller.signal.aborted) return;
      if (runtimeError) {
        throw new Error(runtimeError);
      }

      const suggestions = parseTitleSuggestions(outputText);
      if (!suggestions || suggestions.length === 0) {
        throw new Error('模型没有返回可用的标题，请重试或调整补充要求。');
      }
      if (suggestions.length < 5) {
        new Notice(`本次仅生成 ${suggestions.length} 个可用标题，可重新生成。`);
      }
      this.suggestions = suggestions.slice(0, 5);
      this.error = null;
    } catch (error) {
      if (this.controller?.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '标题生成失败';
      this.suggestions = [];
    } finally {
      this.generating = false;
      safeRemoveDir(runDir);
      if (this.contentEl.isConnected) this.render();
    }
  }
}

function buildTitleGenerationPrompt(snapshot: WeChatPreviewSnapshot, requirement: string): string {
  const currentTitle = snapshot.title.trim();
  const currentDigest = snapshot.digest.trim();
  let article = snapshot.markdown.trim();
  let truncated = false;
  if (article.length > MAX_CONTEXT_CHARS) {
    article = article.slice(0, MAX_CONTEXT_CHARS);
    truncated = true;
  }

  const sections: string[] = [
    '你是微信公众号爆款标题专家。请根据下面提供的文章内容，生成 5 个适合公众号传播的爆款标题。',
    '要求：',
    '- 只输出一个 JSON 数组，不要解释、不要代码围栏。',
    '- 数组长度必须恰好 5 个字符串。',
    '- 每个标题长度控制在 30 字以内，口语化、有传播力，避免夸张虚假宣传。',
  ];
  if (currentTitle) {
    sections.push(`当前标题（可作为参考）：${currentTitle}`);
  }
  if (currentDigest) {
    sections.push(`当前摘要（可作为参考）：${currentDigest}`);
  }
  if (requirement.trim()) {
    sections.push(`额外要求：${requirement.trim()}`);
  }
  sections.push('===== 文章内容 START =====');
  sections.push(article);
  if (truncated) {
    sections.push('（后文已省略）');
  }
  sections.push('===== 文章内容 END =====');
  sections.push('请输出 JSON 数组，例如：["标题1", "标题2", "标题3", "标题4", "标题5"]');
  return sections.join('\n');
}

function parseTitleSuggestions(output: string): string[] | null {
  const cleaned = output.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          const suggestions = parsed
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(item => item.trim());
        if (suggestions.length > 0) return suggestions;
      }
    } catch { /* fallback */ }
  }

  const fallback = cleaned
    .split(/\n/)
    .map(line => line.replace(/^\s*(?:\d+[.)、]|[-*•])\s*["']?|["']\s*$/g, '').trim())
    .filter(line => line.length > 0 && !/^[[\]{}]$/.test(line));
  return fallback.length > 0 ? fallback : null;
}
