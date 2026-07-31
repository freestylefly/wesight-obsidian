import { App, Modal, Setting } from 'obsidian';

import type { AgentStatus } from '../types';

export class RuntimeSetupModal extends Modal {
  constructor(
    app: App,
    private readonly status: AgentStatus,
    private readonly openSettings: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Set up ${this.status.descriptor.displayName}` });
    contentEl.createEl('p', {
      text: 'Install the CLI independently from its official website, then restart Obsidian or configure the executable path in WeSight settings. WeSight does not install or update CLI tools.',
    });
    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText('Open official guide')
          .setCta()
          .onClick(() => {
            window.open(this.status.descriptor.docsUrl, '_blank', 'noopener,noreferrer');
          });
      })
      .addButton(button => {
        button
          .setButtonText('Configure path')
          .onClick(() => {
            this.close();
            this.openSettings();
          });
      })
      .addButton(button => {
        button
          .setButtonText('Close')
          .onClick(() => this.close());
      });
  }
}
