/* eslint obsidianmd/no-global-this: off, obsidianmd/prefer-create-el: off -- Test-only Obsidian DOM helpers. */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { Menu, type App } from 'obsidian';
import type { GitSyncService } from '../src/gitSync/service';
import { DEFAULT_GIT_SYNC_SETTINGS, type GitSyncState, type GitSyncSettings } from '../src/gitSync/types';
import { addGitSyncMenuItems, GitSyncSettingsPanel, GitSyncCommitModal, GitSyncHistoryModal } from '../src/ui/gitSyncSettings';

const fake = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    textContent = '';
    className = '';
    hidden = false;
    disabled = false;
    onclick?: () => void | Promise<void>;
    tag = 'div';
    createEl(tag: string, options?: { text?: string; cls?: string }): Element {
      const el = new Element(); el.tag = tag; el.textContent = options?.text ?? ''; el.className = options?.cls ?? '';
      this.children.push(el); return el;
    }
    createDiv(options?: { text?: string; cls?: string }): Element { return this.createEl('div', options); }
    createSpan(options?: { text?: string; cls?: string }): Element { return this.createEl('span', options); }
    setText(text: string): void { this.textContent = text; }
    addClass(value: string): void { this.className += ` ${value}`; }
    empty(): void { this.children = []; }
    toggle(value: boolean): void { this.hidden = !value; }
    toggleClass(_name: string, _value: boolean): void { /* Styling is verified by the browser preview. */ }
    find(text: string): Element | undefined {
      if (this.textContent === text) return this;
      for (const child of this.children) { const found = child.find(text); if (found) return found; }
      return undefined;
    }
  }
  class Control {
    value: unknown;
    inputEl = { rows: 0, addClass: (_value: string): void => undefined };
    callback: (value: any) => void = () => undefined;
    setValue(value: unknown): this { this.value = value; return this; }
    addOptions(_options: unknown): this { return this; }
    onChange(callback: (value: any) => void): this { this.callback = callback; return this; }
    setDisabled(_value: boolean): this { return this; }
  }
  const controls = new Map<string, Control>();
  class Setting {
    name = '';
    constructor(_el: Element) {}
    setName(name: string): this { this.name = name; return this; }
    setDesc(_desc: string): this { return this; }
    setHeading(): this { return this; }
    addToggle(callback: (control: Control) => void): this { return this.control(callback); }
    addDropdown(callback: (control: Control) => void): this { return this.control(callback); }
    addText(callback: (control: Control) => void): this { return this.control(callback); }
    addTextArea(callback: (control: Control) => void): this { return this.control(callback); }
    control(callback: (control: Control) => void): this {
      const control = new Control(); controls.set(this.name, control); callback(control); return this;
    }
  }
  class MenuItem {
    title: string | Element = '';
    disabled = false;
    callback: () => void = () => undefined;
    setTitle(value: string | Element): this { this.title = value; return this; }
    setIcon(_value: string): this { return this; }
    setIsLabel(_value: boolean): this { return this; }
    setDisabled(value: boolean): this { this.disabled = value; return this; }
    onClick(callback: () => void): this { this.callback = callback; return this; }
  }
  class Menu {
    items: MenuItem[] = [];
    addItem(callback: (item: MenuItem) => void): this { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
  }
  const notices: string[] = [];
  class Notice { constructor(text: string) { notices.push(text); } hide(): void {} }
  class Modal {
    contentEl = new Element();
    setTitle(_value: string): void {}
    open(): void {}
    close(): void {}
  }
  return { Element, Setting, Menu, MenuItem, Notice, Modal, controls, notices };
});

vi.mock('obsidian', () => ({ Menu: fake.Menu, MenuItem: fake.MenuItem, Setting: fake.Setting, Notice: fake.Notice, Modal: fake.Modal }));

function serviceStub() {
  const state: GitSyncState = {
    available: true, root: '/team/knowledge', branch: 'main', remote: 'origin', remoteBranch: 'main',
    remoteUrl: 'https://github.com/team/knowledge.git', upstream: 'refs/remotes/origin/main',
    ahead: 1, behind: 2, changes: [], operation: null, pausedReason: null, error: null,
    checkedAt: 100, remoteCheckedAt: 100, history: [],
  };
  const settings = structuredClone(DEFAULT_GIT_SYNC_SETTINGS);
  const listeners = new Set<(state: GitSyncState) => void>();
  const methods = {
    getState: () => structuredClone(state), getSettings: () => structuredClone(settings),
    onChange: (listener: (state: GitSyncState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pull: vi.fn(async () => ({ ok: true, message: '拉取成功' })),
    push: vi.fn(async () => ({ ok: true, message: '推送成功' })),
    check: vi.fn(async () => ({ ok: true, message: '检查完成' })),
    refresh: vi.fn(async () => ({ ok: true, message: '检测完成' })),
    saveSettings: vi.fn(async (_settings: GitSyncSettings) => ({ ok: true, message: '已保存' })),
    commitAndPush: vi.fn(async (_files: string[], _message: string) => ({ ok: true, message: '提交并推送成功' })),
    summarizeCommit: vi.fn(async (_files: string[], _withAi: boolean, _signal: AbortSignal) => ({ ok: true, message: '更新所选正文内容' })),
    previewCommitPaths: vi.fn(() => [] as string[]),
  };
  return { state, methods, listeners, emit: () => { for (const listener of listeners) listener(structuredClone(state)); },
    service: methods as unknown as GitSyncService };
}

beforeEach(() => {
  fake.controls.clear(); fake.notices.length = 0;
  vi.stubGlobal('createFragment', () => new fake.Element());
});
afterEach(() => vi.unstubAllGlobals());

describe('avatar Git menu and repository settings', () => {
  test('omits stored automatic offline failures from both history views and shows the empty state', () => {
    const s = serviceStub();
    const offlineMessage = '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。';
    s.state.history = [offlineMessage, '无法连接远程仓库，请检查网络', '当前离线，已跳过自动同步。']
      .map((message, index) => ({ at: 100 - index, action: '自动同步', ok: false, message }));
    const modal = new GitSyncHistoryModal({} as App, s.service); modal.onOpen();
    const content = modal.contentEl as unknown as InstanceType<typeof fake.Element>;
    const el = new fake.Element(); const panel = new GitSyncSettingsPanel(s.service, {} as App);
    panel.render(el as unknown as HTMLElement);
    expect(content.find(offlineMessage)).toBeUndefined();
    expect(content.find('尚无同步记录。')).toBeDefined();
    expect(el.find(offlineMessage)).toBeUndefined();
    expect(el.find('尚无同步记录。')).toBeDefined();
    // Rendering does not mutate service state or discard its diagnostics.
    expect(s.state.history).toHaveLength(3);
    panel.dispose(); modal.onClose(); expect(s.listeners.size).toBe(0);
  });

  test('keeps manual network failures, real Git errors and successful history visible when live updates arrive', () => {
    const s = serviceStub();
    const modal = new GitSyncHistoryModal({} as App, s.service); modal.onOpen();
    const content = modal.contentEl as unknown as InstanceType<typeof fake.Element>;
    const offlineMessage = '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。';
    const visible = [
      { at: 90, action: '拉取团队更新', ok: false, message: offlineMessage },
      { at: 80, action: '自动同步', ok: false, message: 'GitHub 认证失败或无仓库权限，请检查本机 Git 登录凭据。' },
      { at: 70, action: '自动同步', ok: false, message: '存在合并冲突，自动同步已暂停。请处理冲突并完成提交后重试。' },
      { at: 60, action: '自动同步', ok: false, message: 'Git 操作失败。请检查本机 Git 凭据、仓库权限和 Git 日志后重试。' },
      { at: 50, action: '自动同步', ok: true, message: '自动同步完成。' },
    ];
    s.state.history = [{ at: 100, action: '自动同步', ok: false, message: offlineMessage }, ...visible];
    s.emit();
    for (const entry of visible) expect(content.find(entry.message)).toBeDefined();
    expect(content.children[0].children).toHaveLength(visible.length);
    expect(content.find('尚无同步记录。')).toBeUndefined();
    modal.onClose(); expect(s.listeners.size).toBe(0);
  });

  test('shows the current branch and counts, invokes pull/push and releases menu listeners', async () => {
    const s = serviceStub(); const menu = new Menu(); const settings = vi.fn(); const history = vi.fn();
    const unsubscribe = addGitSyncMenuItems(menu, s.service, settings, history, {} as App);
    const items = (menu as unknown as InstanceType<typeof fake.Menu>).items;
    const pull = items.find(item => item.title === '立即拉取 · 2 个提交')!;
    const push = items.find(item => item.title === '推送提交 · 1 个提交')!;
    expect(pull.disabled).toBe(false); expect(push.disabled).toBe(false);
    pull.callback(); push.callback();
    await vi.waitFor(() => expect(fake.notices).toContain('推送成功'));
    expect(s.methods.pull).toHaveBeenCalledOnce(); expect(s.methods.push).toHaveBeenCalledOnce();
    items.find(item => item.title === '仓库同步设置')!.callback(); expect(settings).toHaveBeenCalledOnce();
    items.find(item => item.title === '同步记录')!.callback(); expect(history).toHaveBeenCalledOnce();
    s.state.operation = '自动同步'; s.emit(); expect(pull.disabled).toBe(true);
    s.state.operation = null; s.state.behind = 0; s.emit(); expect(pull.title).toBe('立即拉取');
    unsubscribe(); expect(s.listeners.size).toBe(0);
  });

  test('keeps settings accessible when the repository has no remote tracking branch', () => {
    const s = serviceStub(); s.state.available = false; s.state.pausedReason = '尚未设置 upstream';
    const menu = new Menu(); addGitSyncMenuItems(menu, s.service, vi.fn(), vi.fn(), {} as App);
    const items = (menu as unknown as InstanceType<typeof fake.Menu>).items;
    expect(items.find(item => typeof item.title === 'string' && item.title.startsWith('立即拉取'))!.disabled).toBe(true);
    expect(items.find(item => item.title === '仓库同步设置')!.disabled).toBe(false);
  });

  test('saves independent automation switches, interval, commit scope and message from the actual controls', async () => {
    const s = serviceStub(); const el = new fake.Element(); const panel = new GitSyncSettingsPanel(s.service, {} as App);
    s.methods.previewCommitPaths.mockReturnValue(['文章/初稿.md']);
    panel.render(el as unknown as HTMLElement);
    fake.controls.get('自动拉取团队更新')!.callback(true);
    fake.controls.get('自动推送已提交的修改')!.callback(true);
    fake.controls.get('自动提交文件修改')!.callback(true);
    fake.controls.get('检查频率')!.callback('15');
    fake.controls.get('停止编辑多久后提交')!.callback('10');
    fake.controls.get('自动提交排除路径')!.callback('.wesight/\nprivate/');
    fake.controls.get('自动提交信息')!.callback('Team update {device}');
    expect(el.find('文章/初稿.md')).toBeDefined();
    const save = el.find('保存设置')!; await save.onclick!();
    expect(s.methods.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      autoPull: true, autoPush: true, autoCommit: true, intervalMinutes: 15, idleMinutes: 10,
      excludedPaths: ['.wesight/', 'private/'], commitMessage: 'Team update {device}',
    }));
    panel.dispose(); expect(s.listeners.size).toBe(0);
  });

  test('updates diagnostics and button states without discarding unsaved settings', async () => {
    const s = serviceStub(); const el = new fake.Element(); const panel = new GitSyncSettingsPanel(s.service, {} as App);
    panel.render(el as unknown as HTMLElement);
    fake.controls.get('自动拉取团队更新')!.callback(true);
    s.state.error = '存在冲突'; s.state.available = false; s.emit();
    expect(el.find('存在冲突')).toBeDefined(); expect(el.find('立即拉取')!.disabled).toBe(true);
    await el.find('保存设置')!.onclick!();
    expect(s.methods.saveSettings.mock.calls[0][0].autoPull).toBe(true);
    panel.render(el as unknown as HTMLElement); expect(s.listeners.size).toBe(1);
    panel.dispose(); expect(s.listeners.size).toBe(0);
  });

  test('shows commit-and-push when there are working-tree edits and opens review before sending', async () => {
    const s = serviceStub(); s.methods.previewCommitPaths.mockReturnValue(['文章/初稿.md']);
    const open = vi.spyOn(fake.Modal.prototype, 'open');
    const menu = new Menu(); const dispose = addGitSyncMenuItems(menu, s.service, vi.fn(), vi.fn(), {} as App);
    const items = (menu as unknown as InstanceType<typeof fake.Menu>).items;
    items.find(item => item.title === '提交并推送 · 1 个文件')!.callback();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(s.methods.push).not.toHaveBeenCalled(); expect(s.methods.commitAndPush).not.toHaveBeenCalled();
    open.mockRestore(); dispose();
  });

  test('commits only the modal selected files with the entered commit message', async () => {
    const s = serviceStub(); s.methods.previewCommitPaths.mockReturnValue(['one.md', 'two.md']);
    const modal = new GitSyncCommitModal({} as App, s.service);
    modal.onOpen();
    await vi.waitFor(() => expect(fake.controls.get('提交说明')!.value).toBe('更新所选正文内容'));
    fake.controls.get('two.md')!.callback(false);
    fake.controls.get('提交说明')!.callback('完善初稿');
    const content = modal.contentEl as unknown as InstanceType<typeof fake.Element>;
    await content.find('提交并推送')!.onclick!();
    expect(s.methods.commitAndPush).toHaveBeenCalledWith(['one.md'], '完善初稿');
    expect(fake.notices).toContain('提交并推送成功');
  });

  test('prefills a local diff summary and only runs AI after its button is clicked', async () => {
    const s = serviceStub(); s.methods.previewCommitPaths.mockReturnValue(['one.md']);
    const modal = new GitSyncCommitModal({} as App, s.service); modal.onOpen();
    await vi.waitFor(() => expect(fake.controls.get('提交说明')!.value).toBe('更新所选正文内容'));
    expect(s.methods.summarizeCommit.mock.calls[0][1]).toBe(false);
    s.methods.summarizeCommit.mockResolvedValueOnce({ ok: true, message: '润色文章开头' });
    const content = modal.contentEl as unknown as InstanceType<typeof fake.Element>;
    await content.find('AI 总结')!.onclick!();
    await vi.waitFor(() => expect(fake.controls.get('提交说明')!.value).toBe('润色文章开头'));
    expect(s.methods.summarizeCommit.mock.calls[1][1]).toBe(true);
    expect(s.methods.commitAndPush).not.toHaveBeenCalled();
  });

  test('keeps user edits when a pending summary returns', async () => {
    const s = serviceStub(); s.methods.previewCommitPaths.mockReturnValue(['one.md']);
    let resolve!: (result: { ok: boolean; message: string }) => void;
    s.methods.summarizeCommit.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const modal = new GitSyncCommitModal({} as App, s.service); modal.onOpen();
    fake.controls.get('提交说明')!.setValue('我自己的说明').callback('我自己的说明');
    resolve({ ok: true, message: '自动返回的说明' });
    await vi.waitFor(() => expect((modal.contentEl as unknown as InstanceType<typeof fake.Element>)
      .find('保留了你填写的提交说明。需要生成新说明时，可再次点击总结。')).toBeDefined());
    expect(fake.controls.get('提交说明')!.value).toBe('我自己的说明');
  });

  test('ignores a pending summary for an obsolete file selection and regenerates for selected files', async () => {
    const s = serviceStub(); s.methods.previewCommitPaths.mockReturnValue(['one.md', 'two.md']);
    let resolve!: (result: { ok: boolean; message: string }) => void;
    s.methods.summarizeCommit.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const modal = new GitSyncCommitModal({} as App, s.service); modal.onOpen();
    fake.controls.get('two.md')!.callback(false);
    resolve({ ok: true, message: '旧范围的说明' });
    const content = modal.contentEl as unknown as InstanceType<typeof fake.Element>;
    await vi.waitFor(() => expect(content.find('所选文件已变化，请点击「重新总结修改」。')).toBeDefined());
    await content.find('重新总结修改')!.onclick!();
    await vi.waitFor(() => expect(s.methods.summarizeCommit).toHaveBeenCalledTimes(2));
    expect(s.methods.summarizeCommit.mock.calls[1][0]).toEqual(['one.md']);
  });
});
