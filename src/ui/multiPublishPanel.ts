import { App, Notice, setIcon, TFile } from 'obsidian';

import { MultiPublishBridge } from '../multiPublish/bridge';
import { requireBrowserConnection } from '../multiPublish/connection';
import { resolveMultiPublishAccess } from '../multiPublish/access';
import { buildMultiPublishSnapshot } from '../multiPublish/snapshot';
import {
  MULTI_PLATFORM_IDS,
  type MultiPublishSelectablePlatformId,
  type MultiPlatformTaskState,
  type MultiPublishSnapshot,
  type MultiPublishTaskState,
} from '../multiPublish/types';
import type { CloudAuthService } from '../share/cloudAuth';
import type { WeSightObsidianSettings } from '../types';
import { requireMemberFeature } from './memberFeatureGate';

const PLATFORM_LABEL: Record<MultiPublishSelectablePlatformId, string> = {
  zhihu: '知乎',
  csdn: 'CSDN',
  juejin: '掘金',
  'bilibili-article': 'B站专栏',
  toutiao: '今日头条',
  'weibo-article': '微博头条文章',
  'x-article': 'X 文章',
};

const HANDOFF_STEPS = ['文章带入浏览器发布中心', '勾选平台，检查标题、封面与正文', '在各平台编辑页确认发布'] as const;

const STATUS_COPY: Record<MultiPlatformTaskState['status'], string> = {
  queued: '等待中',
  opening: '打开中',
  login_required: '需要登录',
  filling: '填充中',
  ready: '等待发布',
  failed: '失败',
  cancelled: '已取消',
};

interface MultiPublishPanelOptions {
  app: App;
  auth: CloudAuthService;
  bridge: MultiPublishBridge;
  file: TFile;
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  requestRender: () => void;
  requestPosition: () => void;
  openBrowserConnector: () => void;
}

export class MultiPublishPanel {
  private snapshot: MultiPublishSnapshot | null = null;
  private task: MultiPublishTaskState | null = null;
  private loading = false;
  private busy = false;
  private authLoading = false;
  private loginPending = false;
  private error = '';
  private loadVersion = 0;
  private lifecycleVersion = 0;
  private autoLaunched = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: MultiPublishPanelOptions) {}

  async activate(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.authLoading = true;
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    let available = false;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
      available = true;
      this.loginPending = false;
      if (!this.unsubscribe) {
        this.unsubscribe = this.options.bridge.onChange(() => {
          if (this.task) this.task = this.options.bridge.getTask(this.task.taskId) ?? this.task;
          this.options.requestRender();
        });
      }
      if (!this.task) {
        // Reopening the panel for a note that is already in the publish center must
        // not re-import it, or edits made in the browser would be replaced.
        this.task = this.options.bridge.getLatestComposeTask(this.options.file.path);
        if (this.task) this.autoLaunched = true;
      }
      if (force || !this.snapshot) void this.load();
    } finally {
      this.busy = false;
      this.authLoading = false;
      this.options.requestRender();
      this.options.requestPosition();
      if (available && lifecycleVersion === this.lifecycleVersion) this.maybeAutoLaunch();
    }
  }

  dispose(): void {
    this.lifecycleVersion += 1;
    this.loadVersion += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  render(parent: HTMLElement): void {
    if (this.authLoading && !this.snapshot) {
      this.renderAuthLoading(parent);
      return;
    }
    if (this.loading) {
      const loading = parent.createDiv({ cls: 'wesight-multi-loading' });
      const icon = loading.createSpan();
      setIcon(icon, 'loader-circle');
      loading.createSpan({ text: '正在准备文章内容…' });
      return;
    }
    if (this.error && !this.snapshot) {
      this.renderError(parent);
      return;
    }
    if (!this.snapshot) {
      parent.createDiv({ cls: 'wesight-share-error', text: '无法读取当前文章。' });
      return;
    }

    this.renderArticle(parent, this.snapshot);
    if (this.authLoading) {
      this.renderAuthLoading(parent);
      return;
    }
    if (!this.options.auth.getCurrentUser()) {
      this.renderLogin(parent);
      return;
    }
    const connection = this.options.bridge.getConnectionState();
    if (!connection.connected) {
      this.renderInstallGuide(parent);
      if (this.error) this.renderError(parent);
      return;
    }
    this.renderConnection(parent);
    this.renderHandoff(parent);
    if (this.task) this.renderProgress(parent, this.task);
    this.renderPreflight(parent, this.snapshot);
    if (this.error) this.renderError(parent);
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.loading = true;
    this.error = '';
    this.options.requestRender();
    try {
      const snapshot = await buildMultiPublishSnapshot(this.options.app, this.options.file);
      if (version !== this.loadVersion) return;
      this.snapshot = snapshot;
    } catch (error) {
      if (version === this.loadVersion) this.error = error instanceof Error ? error.message : '文章内容准备失败';
    } finally {
      if (version === this.loadVersion) {
        this.loading = false;
        this.options.requestRender();
        this.options.requestPosition();
        this.maybeAutoLaunch();
      }
    }
  }

  private renderArticle(parent: HTMLElement, snapshot: MultiPublishSnapshot): void {
    const article = parent.createDiv({ cls: 'wesight-multi-article' });
    const icon = article.createDiv({ cls: 'wesight-multi-article-icon' });
    setIcon(icon, 'file-text');
    const copy = article.createDiv();
    copy.createSpan({ text: '当前文章' });
    copy.createEl('strong', { text: snapshot.title });
  }

  private renderAuthLoading(parent: HTMLElement): void {
    const loading = parent.createDiv({ cls: 'wesight-multi-loading is-auth' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在检查 WeSight 登录与会员状态…' });
  }

  private renderLogin(parent: HTMLElement): void {
    const gate = parent.createDiv({ cls: 'wesight-multi-login-gate' });
    const heading = gate.createDiv({ cls: 'wesight-multi-login-heading' });
    const headingIcon = heading.createSpan();
    setIcon(headingIcon, 'log-in');
    const copy = heading.createDiv();
    copy.createEl('strong', { text: '登录后使用平台同步' });
    copy.createSpan({ text: '平台同步为 WeSight 会员功能，请登录并开通会员后使用。' });
    const login = gate.createEl('button', {
      cls: 'wesight-share-primary-button is-multi',
      text: this.loginPending ? '等待登录完成' : '请先登录 WeSight',
      attr: { type: 'button' },
    });
    login.disabled = this.loginPending;
    login.onclick = () => {
      this.loginPending = true;
      this.options.auth.startLogin();
      this.options.requestRender();
    };
    const privacy = gate.createDiv({ cls: 'wesight-share-privacy-note' });
    const privacyIcon = privacy.createSpan();
    setIcon(privacyIcon, 'shield-check');
    privacy.createSpan({ text: '登录仅用于确认账号与会员状态，文章仍通过本机临时通道传输。' });
  }

  /** Opening the multi-platform tab goes straight to the browser once nothing needs the user here. */
  private maybeAutoLaunch(): void {
    if (this.autoLaunched || this.busy || this.loading || this.authLoading || !this.snapshot) return;
    if (!this.options.auth.getCurrentUser()) return;
    this.autoLaunched = true;
    void this.start(false);
  }

  private renderInstallGuide(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'wesight-multi-install-guide' });
    card.createEl('strong', { text: '连接浏览器发布助手' });
    card.createEl('p', { text: '请在设置 → 连接器中完成安装与连接，当前内容会保留。' });
    const button = card.createEl('button', { text: '前往连接设置', cls: 'wesight-xhs-primary-button', attr: { type: 'button' } });
    button.onclick = this.options.openBrowserConnector;
  }

  private renderConnection(parent: HTMLElement): void {
    const state = this.options.bridge.getConnectionState();
    const row = parent.createDiv({ cls: `wesight-multi-connection${state.connected ? ' is-connected' : ''}` });
    const icon = row.createSpan();
    setIcon(icon, state.connected ? 'link' : state.paired ? 'radio' : 'plug-zap');
    const copy = row.createDiv();
    copy.createEl('strong', {
      text: state.connected ? '浏览器扩展已连接' : state.paired ? '扩展已配对，等待连接' : '首次打开发布中心将完成扩展配对',
    });
    copy.createSpan({ text: '正文与图片只通过 127.0.0.1 临时通道传输' });
    if (state.paired) {
      const repair = row.createEl('button', {
        cls: 'wesight-multi-link-button',
        text: '连接设置',
        attr: { type: 'button' },
      });
      repair.disabled = this.busy;
      repair.onclick = () => void this.start(true);
    }
  }

  private renderHandoff(parent: HTMLElement): void {
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    const card = parent.createDiv({ cls: `wesight-multi-handoff${this.task ? ' is-sent' : ''}` });
    const heading = card.createDiv({ cls: 'wesight-multi-handoff-heading' });
    const icon = heading.createSpan();
    setIcon(icon, this.busy ? 'loader-circle' : this.task ? 'circle-check' : 'send');
    const copy = heading.createDiv();
    copy.createEl('strong', {
      text: this.busy ? '正在打开 WeSight 发布中心…' : this.task ? '已在浏览器打开发布中心' : '在浏览器中选择发布平台',
    });
    copy.createSpan({
      text: access.state === 'multi-platform' ? 'WeSight 会员 · 不限平台数' : '平台同步需开通 WeSight 会员',
    });

    const steps = card.createEl('ol', { cls: 'wesight-multi-handoff-steps' });
    for (const step of HANDOFF_STEPS) steps.createEl('li', { text: step });

    const actions = card.createDiv({ cls: 'wesight-multi-handoff-actions' });
    if (this.task) {
      const reopen = actions.createEl('button', {
        cls: 'wesight-share-primary-button is-multi',
        text: '回到发布中心',
        attr: { type: 'button' },
      });
      const reopenIcon = reopen.createSpan();
      setIcon(reopenIcon, 'external-link');
      reopen.prepend(reopenIcon);
      reopen.disabled = this.busy;
      reopen.onclick = () => void this.reopen();
      const reimport = actions.createEl('button', {
        cls: 'wesight-share-secondary-button',
        text: '重新导入当前文章',
        attr: { type: 'button' },
      });
      reimport.disabled = this.busy;
      reimport.onclick = () => void this.reimport();
      return;
    }
    const start = actions.createEl('button', {
      cls: 'wesight-share-primary-button is-multi',
      text: this.busy ? '正在打开…' : '多平台发布',
      attr: { type: 'button' },
    });
    const startIcon = start.createSpan();
    setIcon(startIcon, 'send');
    start.prepend(startIcon);
    start.disabled = this.busy;
    start.onclick = () => void this.start(false);
  }

  private renderProgress(parent: HTMLElement, task: MultiPublishTaskState): void {
    const started = MULTI_PLATFORM_IDS.filter(platformId => !['queued', 'cancelled'].includes(task.platforms[platformId].status));
    if (!started.length) return;
    const heading = parent.createDiv({ cls: 'wesight-multi-section-heading' });
    heading.createEl('strong', { text: '同步进度' });
    const ready = started.filter(platformId => task.platforms[platformId].status === 'ready').length;
    heading.createSpan({ text: `${ready}/${started.length}` });
    const list = parent.createDiv({ cls: 'wesight-multi-task-list' });
    for (const platformId of started) {
      const state = task.platforms[platformId];
      const row = list.createDiv({ cls: `wesight-multi-task-row is-${state.status}` });
      const icon = row.createSpan({ cls: 'wesight-multi-task-icon' });
      setIcon(icon, state.status === 'ready' ? 'circle-check' : state.status === 'failed' || state.status === 'login_required' ? 'circle-alert' : 'loader-circle');
      const copy = row.createDiv({ cls: 'wesight-multi-task-copy' });
      copy.createEl('strong', { text: PLATFORM_LABEL[platformId] });
      copy.createSpan({ text: state.message || STATUS_COPY[state.status] });
    }
  }

  private renderPreflight(parent: HTMLElement, snapshot: MultiPublishSnapshot): void {
    if (!snapshot.warnings.length) return;
    const note = parent.createDiv({ cls: 'wesight-multi-preflight' });
    const icon = note.createSpan();
    setIcon(icon, 'triangle-alert');
    const copy = note.createDiv();
    copy.createEl('strong', { text: `导入提示 · ${snapshot.warnings.length} 项` });
    for (const warning of snapshot.warnings.slice(0, 3)) copy.createSpan({ text: warning });
    if (snapshot.warnings.length > 3) copy.createSpan({ text: `另有 ${snapshot.warnings.length - 3} 项提示` });
  }

  private renderError(parent: HTMLElement): void {
    const note = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = note.createSpan();
    setIcon(icon, 'circle-alert');
    note.createSpan({ text: this.error || '操作失败，请稍后重试。' });
  }

  private async start(forcePair: boolean, reload = false): Promise<void> {
    if (!this.snapshot || this.busy) return;
    this.busy = true;
    this.error = '';
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector, forcePair)) return;
      if (reload) {
        this.task = null;
        await this.load();
        if (lifecycleVersion !== this.lifecycleVersion) return;
      }
      const user = this.options.auth.getCurrentUser();
      if (!user || !this.snapshot) return;
      const access = resolveMultiPublishAccess(user, this.options.auth.getBillingSummary());
      const result = this.options.bridge.createComposeTask(this.snapshot, access, forcePair);
      this.task = result.task;
      window.open(result.handoffUrl, '_blank', 'noopener,noreferrer');
      new Notice('已打开 WeSight 发布中心，请在浏览器中选择平台。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '打开发布中心失败';
    } finally {
      this.busy = false;
      this.options.requestRender();
      this.options.requestPosition();
    }
  }

  private async reopen(): Promise<void> {
    if (!this.task || this.busy) return;
    this.busy = true;
    this.options.requestRender();
    const lifecycleVersion = this.lifecycleVersion;
    let expired = false;
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手')) return;
      if (lifecycleVersion !== this.lifecycleVersion) return;
      if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
      window.open(this.options.bridge.createOpenTaskUrl(this.task.taskId), '_blank', 'noopener,noreferrer');
    } catch {
      // The handoff expired; a fresh import brings the article back.
      expired = true;
    } finally {
      this.busy = false;
      this.options.requestRender();
    }
    if (expired && lifecycleVersion === this.lifecycleVersion) await this.reimport();
  }

  private async reimport(): Promise<void> {
    await this.start(false, true);
  }
}
