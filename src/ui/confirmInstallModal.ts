import { App, Modal, Setting } from 'obsidian';

import type { AgentStatus } from '../types';

export class ConfirmInstallModal extends Modal {
  constructor(
    app: App,
    private readonly status: AgentStatus,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Install ${this.status.descriptor.displayName}` });
    contentEl.createEl('p', {
      text: `WeSight will install ${this.status.descriptor.packageName} into ${this.status.managedDir}. Existing local CLI configuration remains untouched.`,
    });
    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText('Install')
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          });
      })
      .addButton(button => {
        button
          .setButtonText('Cancel')
          .onClick(() => this.close());
      });
  }
}
