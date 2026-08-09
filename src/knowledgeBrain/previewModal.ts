import { App, Modal, Notice } from 'obsidian';
import type { KnowledgeActionPreview, KnowledgeApplyResult } from './types';

export class KnowledgePreviewModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly preview: KnowledgeActionPreview,
    private readonly onConfirm: () => Promise<KnowledgeApplyResult>,
    private readonly onCancel?: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '知识大脑：确认应用' });
    contentEl.createDiv({ text: `将新增 ${this.preview.newPages.length} 个页面，更新 ${this.preview.updatedPages.length} 个页面。` });
    if (this.preview.riskWarnings.length > 0) {
      const warnings = contentEl.createDiv({ cls: 'wesight-kb-preview-warnings' });
      warnings.createEl('strong', { text: '风险提示：' });
      for (const warning of this.preview.riskWarnings) {
        warnings.createDiv({ text: warning });
      }
    }
    if (this.preview.newPages.length > 0) {
      contentEl.createEl('h4', { text: '新增页面' });
      const list = contentEl.createEl('ul');
      for (const page of this.preview.newPages) {
        list.createEl('li', { text: `${page.title} (${page.path})` });
      }
    }
    if (this.preview.updatedPages.length > 0) {
      contentEl.createEl('h4', { text: '更新页面' });
      const list = contentEl.createEl('ul');
      for (const page of this.preview.updatedPages) {
        list.createEl('li', { text: `${page.title} (${page.path})` });
      }
    }
    if (this.preview.archivedSources.length > 0) {
      contentEl.createEl('h4', { text: '原始资料归档' });
      const list = contentEl.createEl('ul');
      for (const source of this.preview.archivedSources) list.createEl('li', { text: source.path });
    }
    contentEl.createDiv({
      cls: 'wesight-kb-preview-summary',
      text: `账本：来源 ${this.preview.ledgerChanges.source}、观点 ${this.preview.ledgerChanges.claim}；索引 ${this.preview.indexChanges.index}、Hot Cache ${this.preview.indexChanges.hotCache}、日志 ${this.preview.indexChanges.log}。`,
    });
    const actions = contentEl.createDiv({ cls: 'wesight-kb-preview-actions' });
    const confirm = actions.createEl('button', { text: '确认应用', cls: 'mod-cta' });
    const cancel = actions.createEl('button', { text: '取消' });
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setText('应用中…');
      const result = await this.onConfirm();
      if (result.ok) {
        this.settled = true;
        new Notice(`已应用，涉及 ${result.changedPaths.length} 个文件。`);
        const firstPage = result.changedPaths.find(file => file.startsWith('wiki/') && file.endsWith('.md'));
        if (firstPage) void this.app.workspace.openLinkText(firstPage, '', false);
      } else {
        new Notice(result.error ?? '应用失败。');
      }
      this.close();
    };
    cancel.onclick = () => {
      this.settled = true;
      void this.onCancel?.();
      this.close();
    };
  }

  override onClose(): void {
    if (!this.settled) void this.onCancel?.();
    this.contentEl.empty();
  }
}
