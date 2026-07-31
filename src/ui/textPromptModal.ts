import { App, Modal, Setting } from 'obsidian';

export interface TextPromptOptions {
  title: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
}

/**
 * Electron does not implement window.prompt, so plugin code must collect text
 * input through an Obsidian modal. Resolves with null when the user cancels.
 */
export function promptForText(app: App, options: TextPromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    new TextPromptModal(app, options, resolve).open();
  });
}

class TextPromptModal extends Modal {
  private value: string;
  private submitted = false;

  constructor(
    app: App,
    private readonly options: TextPromptOptions,
    private readonly onResolve: (value: string | null) => void,
  ) {
    super(app);
    this.value = options.initialValue ?? '';
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.options.title });

    let inputEl: HTMLInputElement | HTMLTextAreaElement;
    if (this.options.multiline) {
      inputEl = contentEl.createEl('textarea', {
        cls: 'wesight-prompt-input wesight-prompt-textarea',
        attr: { rows: '8', placeholder: this.options.placeholder ?? '' },
      });
    } else {
      inputEl = contentEl.createEl('input', {
        cls: 'wesight-prompt-input',
        attr: { type: 'text', placeholder: this.options.placeholder ?? '' },
      });
      inputEl.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });
    }
    inputEl.value = this.value;
    inputEl.addEventListener('input', () => {
      this.value = inputEl.value;
    });
    window.setTimeout(() => {
      inputEl.focus();
      if (inputEl instanceof HTMLInputElement) inputEl.select();
    }, 0);

    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText(this.options.submitLabel ?? 'OK')
          .setCta()
          .onClick(() => this.submit());
      })
      .addButton(button => {
        button
          .setButtonText(this.options.cancelLabel ?? 'Cancel')
          .onClick(() => this.close());
      });
  }

  private submit(): void {
    this.submitted = true;
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onResolve(this.submitted ? this.value : null);
  }
}
