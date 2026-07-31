import { App, Editor, MarkdownView, Modal, Notice, Plugin, Setting } from 'obsidian';

import type { AgentId, RuntimeTurnEvent, WeSightObsidianSettings } from '../types';
import { RuntimeManager } from '../runtime/runtimeManager';
import { getVaultBasePath } from '../utils/vault';
import { createId } from '../utils/id';
import { promptForText } from './textPromptModal';

export async function runInlineEdit(
  plugin: Plugin,
  runtimeManager: RuntimeManager,
  getSettings: () => WeSightObsidianSettings,
): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice('Open a markdown note before using inline edit.');
    return;
  }
  const editor = view.editor;
  const selection = editor.getSelection();
  const cursor = editor.getCursor();
  const original = selection || editor.getLine(cursor.line);
  if (!original.trim()) {
    new Notice('Select text or place the cursor on a line with text.');
    return;
  }

  const instruction = await promptForText(plugin.app, {
    title: 'Inline edit with WeSight',
    placeholder: 'How should WeSight edit this text?',
    initialValue: 'Improve clarity while preserving meaning.',
    submitLabel: 'Edit',
  });
  if (!instruction?.trim()) return;

  const settings = getSettings();
  const agentId: AgentId = settings.defaultAgentId;
  const vaultBasePath = getVaultBasePath(plugin.app);
  if (!vaultBasePath) {
    new Notice('WeSight needs a local desktop vault path.');
    return;
  }

  const prompt = [
    'Return only the replacement text for the passage below.',
    `Instruction: ${instruction.trim()}`,
    '',
    'Passage:',
    original,
  ].join('\n');
  let proposed = '';
  await runtimeManager.runTurn({
    conversationId: createId('inline'),
    agentId,
    prompt,
    cwd: vaultBasePath,
    configSource: settings.configSources[agentId],
    providerProfileId: settings.providerProfileByAgent[agentId],
    model: settings.localModelByAgent[agentId],
    systemPrompt: settings.systemPrompt,
    planMode: false,
    attachments: [],
  }, (event: RuntimeTurnEvent) => {
    if (event.type === 'text') proposed += event.content;
    if (event.type === 'error') new Notice(event.message);
  });

  const cleaned = cleanReplacement(proposed);
  if (!cleaned.trim()) {
    new Notice('WeSight did not return replacement text.');
    return;
  }

  new InlineEditModal(plugin.app, editor, original, cleaned).open();
}

function cleanReplacement(value: string): string {
  return value
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim();
}

class InlineEditModal extends Modal {
  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly original: string,
    private readonly proposed: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Review WeSight edit' });
    const diff = contentEl.createDiv({ cls: 'wesight-modal-diff' });
    const left = diff.createDiv();
    left.createEl('strong', { text: 'Original' });
    left.createEl('pre', { text: this.original });
    const right = diff.createDiv();
    right.createEl('strong', { text: 'Proposed' });
    right.createEl('pre', { text: this.proposed });

    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText('Accept')
          .setCta()
          .onClick(() => {
            if (this.editor.somethingSelected()) {
              this.editor.replaceSelection(this.proposed);
            } else {
              const cursor = this.editor.getCursor();
              this.editor.setLine(cursor.line, this.proposed);
            }
            this.close();
          });
      })
      .addButton(button => {
        button
          .setButtonText('Reject')
          .onClick(() => this.close());
      });
  }
}
