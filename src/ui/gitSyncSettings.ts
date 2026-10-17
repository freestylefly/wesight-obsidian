import { App, Menu, MenuItem, Modal, Notice, Setting, type TextAreaComponent } from 'obsidian';

import type { GitSyncService } from '../gitSync/service';
import { gitSyncSummary, isAutomaticOfflineHistory, type GitSyncResult } from '../gitSync/types';

export async function runGitSyncAction(action: () => Promise<GitSyncResult>): Promise<void> {
  const progress = new Notice('正在执行仓库同步…', 0);
  try {
    const result = await action();
    new Notice(result.message, result.ok ? 5_000 : 10_000);
  } finally {
    progress.hide();
  }
}

export async function runGitSyncPush(app: App, service: GitSyncService): Promise<void> {
  await service.refresh();
  if (service.previewCommitPaths().length) {
    new GitSyncCommitModal(app, service).open();
  } else {
    await runGitSyncAction(() => service.push());
  }
}

export function addGitSyncMenuItems(menu: Menu, service: GitSyncService, openSettings: () => void,
  openHistory: () => void, app: App): () => void {
  const repoLabel = createFragment();
  const repoRow = repoLabel.createDiv({ cls: 'wesight-git-menu-repo' });
  repoRow.createSpan({ cls: 'wesight-git-menu-heading', text: '当前仓库' });
  const repoName = repoRow.createSpan();
  menu.addItem(item => item.setTitle(repoLabel).setIsLabel(true));
  const summary = createFragment();
  const summaryEl = summary.createDiv({ cls: 'wesight-git-menu-summary', attr: { 'aria-live': 'polite' } });
  const automationEl = summary.createDiv({ cls: 'wesight-git-menu-automation' });
  menu.addItem(item => item.setTitle(summary).setIsLabel(true));
  const items: { pull?: MenuItem; push?: MenuItem } = {};
  menu.addItem(item => {
    items.pull = item;
    item.setTitle('立即拉取').setIcon('download').onClick(() => void runGitSyncAction(() => service.pull()));
  });
  menu.addItem(item => {
    items.push = item;
    item.setTitle('推送提交').setIcon('upload').onClick(() => void runGitSyncPush(app, service));
  });
  menu.addItem(item => item.setTitle('仓库同步设置').setIcon('settings-2').onClick(openSettings));
  menu.addItem(item => item.setTitle('同步记录').setIcon('history').onClick(openHistory));
  const update = (): void => {
    const state = service.getState();
    const name = state.root?.split(/[\\/]/).pop();
    repoName.setText(state.branch ? `${name ?? ''} · ${state.branch}` : '未连接');
    summaryEl.setText(gitSyncSummary(state));
    summaryEl.toggleClass('is-error', !!(state.error || state.pausedReason));
    const settings = service.getSettings();
    const automatic = [settings.autoPull ? '自动拉取' : '', settings.autoPush ? '自动推送' : ''].filter(Boolean);
    automationEl.setText(automatic.length ? `${automatic.join(' · ')}已开启` : '手动同步');
    items.pull?.setTitle(state.behind ? `立即拉取 · ${state.behind} 个提交` : '立即拉取')
      .setDisabled(!!state.operation || !state.available);
    const files = service.previewCommitPaths();
    items.push?.setTitle(files.length ? `提交并推送 · ${files.length} 个文件`
      : state.ahead ? `推送提交 · ${state.ahead} 个提交` : '推送提交')
      .setDisabled(!!state.operation || !state.available);
  };
  update();
  return service.onChange(update);
}

export class GitSyncSettingsPanel {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly service: GitSyncService, private readonly app: App) {}

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  render(container: HTMLElement): void {
    this.dispose();
    const draft = this.service.getSettings();
    const root = container.createDiv({ cls: 'wesight-git-settings' });
    new Setting(root).setName('GitHub 团队协作').setDesc('配置仅保存在此设备，作用于当前知识库。').setHeading();
    const card = root.createDiv({ cls: 'wesight-git-status' });
    const repo = card.createDiv({ cls: 'wesight-git-repository' });
    const remote = card.createDiv({ cls: 'wesight-git-detail' });
    const status = card.createDiv({ cls: 'wesight-git-detail', attr: { 'aria-live': 'polite' } });
    const counts = card.createDiv({ cls: 'wesight-git-counts' });
    const checked = card.createDiv({ cls: 'wesight-git-detail' });
    const actions = card.createDiv({ cls: 'wesight-git-actions' });
    const check = actions.createEl('button', { text: '检测连接' });
    check.onclick = () => void runGitSyncAction(() => this.service.getState().available ? this.service.check() : this.service.refresh());
    const pull = actions.createEl('button', { text: '立即拉取' });
    pull.onclick = () => void runGitSyncAction(() => this.service.pull());
    const push = actions.createEl('button', { text: '推送提交' });
    push.onclick = () => void runGitSyncPush(this.app, this.service);

    new Setting(root).setName('自动拉取团队更新').setDesc('定时检查当前分支；有未提交的本地修改时暂停拉取。')
      .addToggle(toggle => toggle.setValue(draft.autoPull).onChange(value => { draft.autoPull = value; }));
    new Setting(root).setName('检查频率').setDesc('Obsidian 打开期间生效。')
      .addDropdown(dropdown => dropdown.addOptions({ '1': '每 1 分钟', '5': '每 5 分钟', '15': '每 15 分钟', '30': '每 30 分钟' })
        .setValue(String(draft.intervalMinutes)).onChange(value => { draft.intervalMinutes = Number(value); }));
    new Setting(root).setName('打开知识库时拉取').setDesc('开启后，在本机打开此知识库时拉取一次团队更新。')
      .addToggle(toggle => toggle.setValue(draft.pullOnOpen).onChange(value => { draft.pullOnOpen = value; }));
    new Setting(root).setName('自动推送已提交的修改').setDesc('推送到当前跟踪分支；远程有新提交时先拉取，遇到冲突暂停。')
      .addToggle(toggle => toggle.setValue(draft.autoPush).onChange(value => { draft.autoPush = value; }));
    new Setting(root).setName('自动提交文件修改').setDesc('停止编辑后提交纳入同步范围的文件。上传到 GitHub 需同时开启自动推送。')
      .addToggle(toggle => toggle.setValue(draft.autoCommit).onChange(value => { draft.autoCommit = value; renderPreview(); }));
    new Setting(root).setName('停止编辑多久后提交')
      .addDropdown(dropdown => dropdown.addOptions({ '1': '1 分钟', '5': '5 分钟', '10': '10 分钟', '15': '15 分钟' })
        .setValue(String(draft.idleMinutes)).onChange(value => { draft.idleMinutes = Number(value); }));

    const advanced = root.createEl('details', { cls: 'wesight-git-advanced' });
    advanced.createEl('summary', { text: '同步范围与提交信息' });
    new Setting(advanced).setName('自动提交排除路径')
      .setDesc('每行一个知识库相对路径。目录以 / 结尾，支持 *。遵循 .gitignore；Obsidian 配置目录始终排除。')
      .addTextArea(text => text.setValue(draft.excludedPaths.join('\n')).onChange(value => {
        draft.excludedPaths = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        renderPreview();
      }));
    new Setting(advanced).setName('自动提交信息').setDesc('可使用 {device}（设备名称）和 {time}（时间）。')
      .addText(text => text.setValue(draft.commitMessage).onChange(value => { draft.commitMessage = value; }));
    advanced.createEl('p', { cls: 'wesight-git-detail', text: '排除路径仅控制自动提交。已经提交的内容会随提交记录一同推送；请通过 .gitignore 管理团队的长期同步范围。' });
    const preview = root.createDiv({ cls: 'wesight-git-preview' });
    const renderPreview = (): void => {
      preview.empty();
      preview.toggle(draft.autoCommit);
      if (!draft.autoCommit) return;
      const files = this.service.previewCommitPaths(draft);
      preview.createDiv({ text: `当前自动提交范围：${files.length} 个修改文件`, cls: 'wesight-git-preview-heading' });
      if (!files.length) preview.createDiv({ text: '当前没有可自动提交的修改。后续修改将按上述范围纳入。', cls: 'wesight-git-detail' });
      for (const file of files.slice(0, 30)) preview.createDiv({ text: file, cls: 'wesight-git-path' });
      if (files.length > 30) preview.createDiv({ text: `还有 ${files.length - 30} 个文件。`, cls: 'wesight-git-detail' });
    };
    const footer = root.createDiv({ cls: 'wesight-git-actions' });
    const save = footer.createEl('button', { text: '保存设置', cls: 'mod-cta' });
    save.onclick = async () => {
      save.disabled = true;
      try {
        const result = await this.service.saveSettings(draft);
        new Notice(result.message, result.ok ? 5_000 : 10_000);
      } finally { save.disabled = false; }
    };
    footer.createSpan({ cls: 'wesight-git-detail', text: '首次使用默认关闭自动化；保存后生效。' });
    const details = root.createEl('details', { cls: 'wesight-git-history' });
    details.createEl('summary', { text: '最近同步记录' });
    const history = details.createDiv();
    const update = (): void => {
      const state = this.service.getState();
      repo.setText(state.root ? `${state.root} · ${state.branch ?? '游离 HEAD'}` : '当前知识库');
      remote.setText(state.remoteUrl ? `${state.remoteUrl} · ${state.remote}/${state.remoteBranch}` : '复用本机 Git 凭据。请先连接远程仓库并设置当前分支的 upstream。');
      status.setText(gitSyncSummary(state));
      status.toggleClass('is-error', !!(state.error || state.pausedReason));
      counts.setText(`待拉取 ${state.behind} · 待推送 ${state.ahead} · 本地修改 ${state.changes.length}`);
      push.setText(this.service.previewCommitPaths().length ? '提交并推送' : '推送提交');
      checked.setText(state.remoteCheckedAt ? `上次检查远程：${new Date(state.remoteCheckedAt).toLocaleString()}` : '尚未检查远程。点击「检测连接」获取团队最新提交数量。');
      check.disabled = !!state.operation;
      pull.disabled = push.disabled = !!state.operation || !state.available;
      save.disabled = !!state.operation;
      renderPreview();
      renderGitHistory(history, this.service);
    };
    update();
    this.unsubscribe = this.service.onChange(update);
    void this.service.refresh();
  }
}

export class GitSyncCommitModal extends Modal {
  private readonly controller = new AbortController();
  private closed = false;
  constructor(app: App, private readonly service: GitSyncService) { super(app); }

  override onOpen(): void {
    this.setTitle('提交并推送到远程仓库');
    this.contentEl.addClass('wesight-git-commit-content');
    const state = this.service.getState();
    const files = this.service.previewCommitPaths();
    const selected = new Set(files);
    this.contentEl.createEl('p', { cls: 'wesight-git-detail',
      text: `${state.remoteUrl ?? state.remote ?? ''} · ${state.branch} → ${state.remoteBranch}` });
    this.contentEl.createEl('p', { text: '确认本次提交的文件。提交后会先拉取团队更新，再推送；遇到冲突会保留本地提交并暂停。' });
    const list = this.contentEl.createDiv({ cls: 'wesight-git-commit-files' });
    let message = '';
    let revision = 0;
    let selectionRevision = 0;
    let generating = false;
    let sending = false;
    let messageInput!: TextAreaComponent;
    new Setting(this.contentEl).setName('提交说明')
      .setDesc('根据所选文件的实际修改生成，可继续编辑。')
      .addTextArea(text => {
        messageInput = text;
        text.setValue(message).onChange(value => { message = value; revision++; });
        text.inputEl.rows = 4;
        text.inputEl.addClass('wesight-git-commit-message');
      });
    const generationActions = this.contentEl.createDiv({ cls: 'wesight-git-actions' });
    const regenerate = generationActions.createEl('button', { text: '重新总结修改' });
    const ai = generationActions.createEl('button', { text: 'AI 总结' });
    this.contentEl.createDiv({ cls: 'wesight-git-detail', text: '自动摘要在本机生成。点击「AI 总结」会使用当前默认模型分析所选文件差异。' });
    const feedback = this.contentEl.createDiv({ cls: 'wesight-git-detail', attr: { 'aria-live': 'polite' } });
    const actions = this.contentEl.createDiv({ cls: 'wesight-git-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const submit = actions.createEl('button', { text: '提交并推送', cls: 'mod-cta' });
    const updateButtons = (): void => {
      submit.disabled = generating || sending || !selected.size;
      regenerate.disabled = ai.disabled = generating || sending || !selected.size;
    };
    const generate = async (withAi: boolean): Promise<void> => {
      if (generating || sending || !selected.size) return;
      const initialRevision = revision;
      const initialSelection = selectionRevision;
      generating = true;
      updateButtons();
      feedback.setText(withAi ? '正在使用 AI 总结修改…' : '正在读取所选文件差异…');
      const result = await this.service.summarizeCommit([...selected], withAi, this.controller.signal);
      if (this.closed) return;
      generating = false;
      updateButtons();
      if (selectionRevision !== initialSelection) {
        feedback.setText('所选文件已变化，请点击「重新总结修改」。');
        return;
      }
      if (revision !== initialRevision) {
        feedback.setText('保留了你填写的提交说明。需要生成新说明时，可再次点击总结。');
        return;
      }
      if (result.ok) {
        message = result.message;
        messageInput.setValue(message);
        feedback.setText(`已总结 ${selected.size} 个文件的修改，可编辑后提交。`);
      } else feedback.setText(`生成失败：${result.message} 你可以手动填写后提交。`);
    };
    regenerate.onclick = () => void generate(false);
    ai.onclick = () => void generate(true);
    for (const file of files) {
      new Setting(list).setName(file).addToggle(toggle => toggle.setValue(true).onChange(value => {
        if (value) selected.add(file); else selected.delete(file);
        selectionRevision++;
        updateButtons();
        feedback.setText(`已选择 ${selected.size} 个文件。请重新总结修改或手动更新说明。`);
      }));
    }
    feedback.setText(`已选择 ${files.length} 个文件。遵循仓库同步设置中的排除范围。`);
    updateButtons();
    submit.onclick = async () => {
      if (!message.trim()) { feedback.setText('请填写提交说明。'); return; }
      sending = true;
      updateButtons();
      cancel.disabled = true;
      messageInput.setDisabled(true);
      feedback.setText('正在提交并推送…');
      const result = await this.service.commitAndPush([...selected], message);
      sending = false;
      updateButtons();
      cancel.disabled = false;
      messageInput.setDisabled(false);
      feedback.setText(result.message);
      new Notice(result.message, result.ok ? 5_000 : 10_000);
      if (result.ok) this.close();
      else { submit.disabled = true; cancel.setText('关闭'); }
    };
    void generate(false);
  }

  override onClose(): void { this.closed = true; this.controller.abort(); this.contentEl.empty(); }
}

function renderGitHistory(container: HTMLElement, service: GitSyncService): void {
  container.empty();
  const history = service.getState().history.filter(entry => !isAutomaticOfflineHistory(entry));
  if (!history.length) container.createDiv({ cls: 'wesight-git-detail', text: '尚无同步记录。' });
  for (const entry of history) {
    const row = container.createDiv({ cls: 'wesight-git-history-entry' });
    row.createDiv({ cls: 'wesight-git-detail', text: `${new Date(entry.at).toLocaleString()} · ${entry.action}` });
    row.createDiv({ text: entry.message, cls: entry.ok ? '' : 'is-error' });
  }
}

export class GitSyncHistoryModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  constructor(app: App, private readonly service: GitSyncService) { super(app); }
  override onOpen(): void {
    this.setTitle('仓库同步记录');
    const history = this.contentEl.createDiv({ cls: 'wesight-git-history' });
    renderGitHistory(history, this.service);
    this.unsubscribe = this.service.onChange(() => renderGitHistory(history, this.service));
  }
  override onClose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.contentEl.empty(); }
}
