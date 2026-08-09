import { App, Modal, Notice, TFile } from 'obsidian';
import type { KnowledgeHealthFinding, KnowledgeHealthReport } from './types';

const SEVERITY_LABEL: Record<KnowledgeHealthFinding['severity'], string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
};

export class KnowledgeHealthModal extends Modal {
  constructor(app: App, private readonly report: KnowledgeHealthReport) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '知识大脑健康检查' });
    contentEl.createDiv({
      cls: 'wesight-kb-health-summary',
      text: `扫描 ${this.report.pages} 页、${this.report.links} 条链接，发现 ${this.report.findings.length} 个问题。`,
    });
    if (this.report.error) contentEl.createDiv({ cls: 'wesight-kb-error', text: this.report.error });
    if (this.report.recoveryPending) contentEl.createDiv({ cls: 'wesight-kb-error', text: '检测到中断事务，新的知识写入已暂停。' });
    if (this.report.findings.length === 0 && !this.report.error) {
      contentEl.createDiv({ text: '检查通过，未发现知识库结构或证据问题。' });
      return;
    }
    const ordered = [...this.report.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    for (const finding of ordered) {
      const details = contentEl.createEl('details', { cls: `wesight-kb-health-finding is-${finding.severity}` });
      details.open = finding.severity === 'critical' || finding.severity === 'high';
      details.createEl('summary', { text: `[${SEVERITY_LABEL[finding.severity]}] ${finding.message}` });
      details.createDiv({ text: `分类：${finding.rule}` });
      if (finding.path) {
        const location = finding.line ? `${finding.path}:${finding.line}` : finding.path;
        const open = details.createEl('button', { text: location });
        open.onclick = () => {
          const file = this.app.vault.getAbstractFileByPath(finding.path);
          if (file instanceof TFile) {
            void this.app.workspace.getLeaf(false).openFile(file, finding.line
              ? { eState: { line: Math.max(0, finding.line - 1) } }
              : undefined);
          }
          this.close();
        };
      }
      if (finding.target) details.createDiv({ text: `目标：${finding.target}` });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class KnowledgeRecoveryModal extends Modal {
  constructor(app: App, private readonly onRecover: () => Promise<KnowledgeHealthReport>) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: '恢复知识大脑事务' });
    this.contentEl.createDiv({ text: '恢复会回滚或完成上一次中断的原子事务。恢复期间请保持当前 Vault 打开。' });
    const actions = this.contentEl.createDiv({ cls: 'wesight-kb-preview-actions' });
    const confirm = actions.createEl('button', { cls: 'mod-cta', text: '确认恢复' });
    const cancel = actions.createEl('button', { text: '取消' });
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setText('恢复中…');
      const report = await this.onRecover();
      new Notice(report.recoveryPending ? (report.error ?? '恢复未完成。') : '知识大脑事务已恢复。');
      this.close();
    };
    cancel.onclick = () => this.close();
  }
}

function severityRank(value: KnowledgeHealthFinding['severity']): number {
  return ({ critical: 0, high: 1, medium: 2, low: 3 })[value];
}
