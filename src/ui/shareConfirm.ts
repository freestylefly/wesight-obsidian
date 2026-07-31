import { App, Modal } from 'obsidian';

export interface ShareConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  dangerous?: boolean;
}

class ShareConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: ShareConfirmOptions,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl('p', { text: this.options.message });
    const actions = this.contentEl.createDiv({ cls: 'wesight-share-confirm-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.finish(false);
    const confirm = actions.createEl('button', {
      text: this.options.confirmText,
      cls: this.options.dangerous ? 'mod-warning' : 'mod-cta',
    });
    confirm.onclick = () => this.finish(true);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  private finish(confirmed: boolean): void {
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

export function confirmShareAction(
  app: App,
  options: ShareConfirmOptions,
): Promise<boolean> {
  return new Promise((resolve) => new ShareConfirmModal(app, options, resolve).open());
}
