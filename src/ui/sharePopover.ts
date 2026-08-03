import { App, Notice, setIcon, TFile } from 'obsidian';

import { CloudApiError, ShareCloudApi } from '../share/cloudApi';
import { CloudAuthRequiredError, CloudAuthService } from '../share/cloudAuth';
import {
  buildShareSnapshot,
  SHARE_ID_FRONTMATTER_KEY,
  stripShareFrontmatter,
} from '../share/snapshot';
import type { ShareSnapshot, ShareState } from '../share/types';
import type { LarkCliService } from '../feishu/larkCli';
import type { WeSightObsidianSettings } from '../types';
import { recordValue } from '../utils/records';
import type { WeChatCloudApi } from '../wechat/cloudApi';
import { FeishuSharePanel } from './feishuSharePanel';
import { confirmShareAction } from './shareConfirm';
import { WeChatSharePanel } from './wechatSharePanel';

export type SharePopoverTab = 'internet' | 'feishu' | 'wechat';

function formatPublishedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export class SharePopoverController {
  private current: SharePopover | null = null;

  constructor(
    private readonly app: App,
    private readonly auth: CloudAuthService,
    private readonly api: ShareCloudApi,
    private readonly wechatApi: WeChatCloudApi,
    private readonly larkCli: LarkCliService,
    private readonly getSettings: () => WeSightObsidianSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly openWeChatSettings: () => void,
    private readonly openWeChatPreview: (file: TFile) => Promise<void>,
    private readonly openWeChatArticleStats: (file: TFile) => Promise<void>,
  ) {}

  open(
    file: TFile,
    anchor?: HTMLElement | null,
    initialTab: SharePopoverTab = 'internet',
  ): void {
    this.current?.close();
    this.current = new SharePopover(
      this.app,
      this.auth,
      this.api,
      this.wechatApi,
      this.larkCli,
      this.getSettings,
      this.saveSettings,
      this.openWeChatSettings,
      this.openWeChatPreview,
      this.openWeChatArticleStats,
      file,
      anchor ?? null,
      initialTab,
      () => {
        this.current = null;
      },
    );
    this.current.open();
  }

  close(): void {
    this.current?.close();
  }
}

class SharePopover {
  private backdropEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private snapshot: ShareSnapshot | null = null;
  private shareState: ShareState | null = null;
  private shareId: string | null = null;
  private loading = true;
  private loginPending = false;
  private operationLabel: string | null = null;
  private error: string | null = null;
  private staleShareId = false;
  private duplicatePath: string | null = null;
  private loadVersion = 0;
  private authUnsubscribe: (() => void) | null = null;
  private readonly feishuPanel: FeishuSharePanel;
  private readonly wechatPanel: WeChatSharePanel;
  private readonly onResize = () => this.position();
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.close();
  };

  constructor(
    private readonly app: App,
    private readonly auth: CloudAuthService,
    private readonly api: ShareCloudApi,
    wechatApi: WeChatCloudApi,
    larkCli: LarkCliService,
    getSettings: () => WeSightObsidianSettings,
    saveSettings: () => Promise<void>,
    openWeChatSettings: () => void,
    openWeChatPreview: (file: TFile) => Promise<void>,
    openWeChatArticleStats: (file: TFile) => Promise<void>,
    private readonly file: TFile,
    private readonly anchor: HTMLElement | null,
    private activeTab: SharePopoverTab,
    private readonly onClosed: () => void,
  ) {
    this.feishuPanel = new FeishuSharePanel({
      app,
      cli: larkCli,
      file,
      getSettings,
      saveSettings,
      requestRender: () => this.render(),
      requestPosition: () => this.position(),
    });
    this.wechatPanel = new WeChatSharePanel({
      app,
      auth,
      api: wechatApi,
      file,
      requestRender: () => this.render(),
      requestPosition: () => this.position(),
      openSettings: openWeChatSettings,
      openPreview: async (target) => {
        this.close();
        await openWeChatPreview(target);
      },
      openArticleStats: async (target) => {
        this.close();
        await openWeChatArticleStats(target);
      },
    });
  }

  open(): void {
    this.backdropEl = document.body.createDiv({ cls: 'wesight-share-backdrop' });
    this.backdropEl.onclick = (event) => {
      if (event.target === this.backdropEl) this.close();
    };
    this.panelEl = this.backdropEl.createDiv({
      cls: 'wesight-share-popover',
      attr: {
        role: 'dialog',
        'aria-label': '分享当前笔记',
      },
    });
    this.panelEl.onclick = (event) => event.stopPropagation();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown);
    this.authUnsubscribe = this.auth.onChange(() => {
      this.loginPending = false;
      if (this.activeTab === 'wechat') {
        this.wechatPanel.activate(true);
      } else {
        void this.load();
      }
    });
    this.render();
    this.position();
    if (this.activeTab === 'feishu') {
      this.feishuPanel.activate();
    } else if (this.activeTab === 'wechat') {
      this.wechatPanel.activate();
    } else {
      void this.load();
    }
  }

  close(): void {
    this.loadVersion += 1;
    this.feishuPanel.dispose();
    this.wechatPanel.dispose();
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKeyDown);
    this.backdropEl?.remove();
    this.backdropEl = null;
    this.panelEl = null;
    this.onClosed();
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.loading = true;
    this.error = null;
    this.staleShareId = false;
    this.duplicatePath = null;
    this.render();
    try {
      const user = await this.auth.restoreSession();
      if (version !== this.loadVersion) return;
      if (!user) {
        this.loading = false;
        this.render();
        return;
      }

      const raw = await this.app.vault.read(this.file);
      this.shareId = stripShareFrontmatter(raw).shareId;
      if (this.shareId) {
        this.duplicatePath = this.findDuplicatePath(this.shareId);
      }
      this.snapshot = await buildShareSnapshot(this.app, this.file);
      this.shareState = null;
      if (this.shareId && !this.duplicatePath) {
        try {
          this.shareState = await this.api.getShare(this.shareId);
        } catch (error) {
          if (error instanceof CloudApiError && error.status === 404) {
            this.staleShareId = true;
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : '加载分享状态失败';
    } finally {
      if (version === this.loadVersion) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    if (!this.panelEl) return;
    this.panelEl.empty();
    const header = this.panelEl.createDiv({ cls: 'wesight-share-header' });
    header.createEl('h3', { text: '分享' });
    const close = header.createEl('button', {
      cls: 'clickable-icon wesight-share-icon-button',
      attr: { type: 'button', 'aria-label': '关闭分享面板' },
    });
    setIcon(close, 'x');
    close.onclick = () => this.close();

    this.renderTabs();
    const body = this.panelEl.createDiv({
      cls: `wesight-share-body${this.activeTab === 'feishu' ? ' is-feishu' : ''}${this.activeTab === 'wechat' ? ' is-wechat' : ''}`,
    });
    if (this.activeTab === 'feishu') {
      this.feishuPanel.render(body);
    } else if (this.activeTab === 'wechat') {
      this.wechatPanel.render(body);
    } else if (this.loading) {
      this.renderLoading(body);
    } else if (!this.auth.getCurrentUser()) {
      this.renderLogin(body);
    } else if (this.operationLabel) {
      this.renderOperation(body);
    } else if (this.error) {
      this.renderError(body);
    } else if (this.duplicatePath) {
      this.renderDuplicate(body);
    } else if (this.shareState && this.snapshot) {
      this.renderPublished(body, this.shareState, this.snapshot);
    } else if (this.snapshot) {
      this.renderUnpublished(body, this.snapshot);
    } else {
      this.renderError(body, '无法读取当前笔记。');
    }
    window.requestAnimationFrame(() => this.position());
  }

  private renderTabs(): void {
    if (!this.panelEl) return;
    const tabs = this.panelEl.createDiv({
      cls: 'wesight-share-tabs',
      attr: { role: 'tablist', 'aria-label': '分享方式' },
    });
    const options: Array<{ id: SharePopoverTab; label: string; ariaLabel: string }> = [
      { id: 'internet', label: '互联网', ariaLabel: '互联网分享' },
      { id: 'feishu', label: '飞书', ariaLabel: '飞书文档' },
      { id: 'wechat', label: '公众号', ariaLabel: '公众号草稿' },
    ];
    for (const option of options) {
      const selected = this.activeTab === option.id;
      const tab = tabs.createEl('button', {
        cls: `wesight-share-tab${selected ? ' is-active' : ''}`,
        text: option.label,
        attr: {
          type: 'button',
          role: 'tab',
          'aria-label': option.ariaLabel,
          'aria-selected': String(selected),
        },
      });
      tab.onclick = () => {
        if (this.activeTab === option.id) return;
        this.activeTab = option.id;
        this.render();
        if (option.id === 'feishu') {
          this.feishuPanel.activate();
        } else if (option.id === 'wechat') {
          this.wechatPanel.activate();
        } else if (!this.snapshot && !this.loading) {
          void this.load();
        }
      };
    }
  }

  private renderLoading(parent: HTMLElement): void {
    const loading = parent.createDiv({ cls: 'wesight-share-loading' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在检查分享状态…' });
  }

  private renderLogin(parent: HTMLElement): void {
    this.renderStatusRow(
      parent,
      '互联网分享',
      this.loginPending ? '完成浏览器登录后会自动返回此处。' : '登录 WeSight 后即可发布和管理当前文章。',
      false,
      false,
    );
    const notice = parent.createDiv({ cls: 'wesight-share-privacy-note' });
    const icon = notice.createSpan();
    setIcon(icon, 'shield-check');
    notice.createSpan({ text: '登录凭据由 Obsidian 安全存储保存。' });
    const login = parent.createEl('button', {
      cls: 'wesight-share-primary-button',
      text: this.loginPending ? '等待登录完成' : '登录 WeSight',
      attr: { type: 'button' },
    });
    login.disabled = this.loginPending;
    login.onclick = () => {
      this.loginPending = true;
      this.auth.startLogin();
      this.render();
    };
  }

  private renderOperation(parent: HTMLElement): void {
    const operation = parent.createDiv({ cls: 'wesight-share-operation' });
    const icon = operation.createSpan();
    setIcon(icon, 'loader-circle');
    operation.createEl('strong', { text: this.operationLabel ?? '处理中…' });
    operation.createSpan({ text: '请保持 Obsidian 打开。' });
  }

  private renderError(parent: HTMLElement, override?: string): void {
    const error = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    const copy = error.createDiv();
    copy.createEl('strong', { text: '暂时无法完成分享' });
    copy.createSpan({ text: override || this.error || '请稍后重试。' });
    const retry = parent.createEl('button', {
      cls: 'wesight-share-primary-button',
      text: '重试',
      attr: { type: 'button' },
    });
    retry.onclick = () => void this.load();
  }

  private renderDuplicate(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = error.createSpan();
    setIcon(icon, 'copy-x');
    const copy = error.createDiv();
    copy.createEl('strong', { text: '检测到重复的分享标识' });
    copy.createSpan({
      text: `另一篇笔记“${this.duplicatePath}”使用了同一个分享链接。`,
    });
    const publish = parent.createEl('button', {
      cls: 'wesight-share-primary-button',
      text: '将当前笔记作为新文章发布',
      attr: { type: 'button' },
    });
    publish.onclick = () => void this.publishAsNew();
  }

  private renderUnpublished(parent: HTMLElement, snapshot: ShareSnapshot): void {
    this.renderStatusRow(
      parent,
      this.staleShareId ? '原分享链接已失效' : '互联网分享未开启',
      '发布后，知道链接的人可以访问，搜索引擎不会收录。',
      false,
      false,
    );
    const privacy = parent.createDiv({ cls: 'wesight-share-privacy-note' });
    const icon = privacy.createSpan();
    setIcon(icon, 'lock-keyhole');
    privacy.createSpan({ text: '发布会把当前文章和引用的本地图片上传到 WeSight Cloud。' });
    this.renderWarnings(parent, snapshot);
    const publish = parent.createEl('button', {
      cls: 'wesight-share-primary-button',
      text: this.staleShareId ? '创建新的分享链接' : '发布到互联网',
      attr: { type: 'button' },
    });
    const publishIcon = publish.createSpan();
    setIcon(publishIcon, 'globe');
    publish.prepend(publishIcon);
    publish.onclick = () => void this.publishAsNew();
  }

  private renderPublished(
    parent: HTMLElement,
    state: ShareState,
    snapshot: ShareSnapshot,
  ): void {
    this.renderStatusRow(
      parent,
      state.enabled ? '互联网分享已开启' : '互联网分享已关闭',
      state.enabled
        ? '知道链接的人可以访问，搜索引擎不会收录。'
        : '公开链接当前不可访问。',
      state.enabled,
      true,
      () => void this.toggleShare(state, snapshot),
    );
    this.renderCommentControls(parent, state);

    const linkRow = parent.createDiv({ cls: 'wesight-share-link-row' });
    const link = linkRow.createEl('input', {
      attr: {
        type: 'text',
        readonly: 'true',
        'aria-label': '公开分享链接',
      },
    });
    link.value = state.url;
    link.disabled = !state.enabled;
    const copyIcon = linkRow.createEl('button', {
      cls: 'clickable-icon wesight-share-icon-button',
      attr: { type: 'button', 'aria-label': '复制分享链接' },
    });
    setIcon(copyIcon, 'copy');
    copyIcon.disabled = !state.enabled;
    copyIcon.onclick = () => void this.copyLink(state.url);

    const actions = parent.createDiv({ cls: 'wesight-share-link-actions' });
    const view = actions.createEl('button', {
      cls: 'wesight-share-secondary-button',
      text: '在线查看',
      attr: { type: 'button' },
    });
    const viewIcon = view.createSpan();
    setIcon(viewIcon, 'external-link');
    view.prepend(viewIcon);
    view.disabled = !state.enabled;
    view.onclick = () => window.open(state.url, '_blank', 'noopener,noreferrer');

    const copy = actions.createEl('button', {
      cls: 'wesight-share-copy-button',
      text: '复制链接',
      attr: { type: 'button' },
    });
    const actionCopyIcon = copy.createSpan();
    setIcon(actionCopyIcon, 'copy');
    copy.prepend(actionCopyIcon);
    copy.disabled = !state.enabled;
    copy.onclick = () => void this.copyLink(state.url);

    const changed = snapshot.contentHash !== state.contentHash;
    const updateNotice = parent.createDiv({
      cls: `wesight-share-update-note${changed ? ' is-changed' : ''}`,
    });
    const updateIcon = updateNotice.createSpan();
    setIcon(updateIcon, changed ? 'circle-alert' : 'circle-check');
    updateNotice.createSpan({
      text: changed ? '内容已更新，可发布最新版本' : '线上版本已经是最新内容',
    });
    if (changed && state.commentCount > 0) {
      const commentNotice = parent.createDiv({
        cls: 'wesight-share-comment-update-note',
      });
      const commentIcon = commentNotice.createSpan();
      setIcon(commentIcon, 'message-circle');
      commentNotice.createSpan({
        text: `当前有 ${state.commentCount} 条评论。更新后，无法重新定位的划线评论会暂时隐藏。`,
      });
    }
    this.renderWarnings(parent, snapshot);

    const update = parent.createEl('button', {
      cls: 'wesight-share-primary-button',
      text: state.enabled ? '更新分享' : '重新开启分享',
      attr: { type: 'button' },
    });
    const refreshIcon = update.createSpan();
    setIcon(refreshIcon, 'refresh-cw');
    update.prepend(refreshIcon);
    update.disabled = state.enabled && !changed;
    update.onclick = () => void this.update(state, snapshot);

    parent.createDiv({
      cls: 'wesight-share-published-at',
      text: `最后发布于 ${formatPublishedAt(state.publishedAt)}`,
    });
  }

  private renderCommentControls(parent: HTMLElement, state: ShareState): void {
    const row = parent.createDiv({ cls: 'wesight-share-comments-setting' });
    const iconWrap = row.createDiv({ cls: 'wesight-share-comments-icon' });
    setIcon(iconWrap, 'message-circle');
    const copy = row.createDiv({ cls: 'wesight-share-comments-copy' });
    copy.createEl('strong', { text: '允许访客划线评论' });
    copy.createSpan({
      text: state.commentsEnabled
        ? `${state.commentCount} 条评论 · 访客无需登录`
        : state.commentCount > 0
          ? `${state.commentCount} 条评论已隐藏`
          : '评论入口和已有评论会保持隐藏',
    });
    const toggle = row.createEl('button', {
      cls: `wesight-share-toggle${state.commentsEnabled ? ' is-enabled' : ''}`,
      attr: {
        type: 'button',
        role: 'switch',
        'aria-checked': String(state.commentsEnabled),
        'aria-label': state.commentsEnabled ? '关闭访客评论' : '开启访客评论',
      },
    });
    toggle.createSpan();
    toggle.onclick = () => void this.toggleComments(state);
  }

  private renderStatusRow(
    parent: HTMLElement,
    title: string,
    description: string,
    enabled: boolean,
    interactive: boolean,
    onToggle?: () => void,
  ): void {
    const row = parent.createDiv({ cls: 'wesight-share-status-row' });
    const iconWrap = row.createDiv({ cls: 'wesight-share-globe' });
    setIcon(iconWrap, 'globe');
    const copy = row.createDiv({ cls: 'wesight-share-status-copy' });
    copy.createEl('strong', { text: title });
    copy.createSpan({ text: description });
    const toggle = row.createEl('button', {
      cls: `wesight-share-toggle${enabled ? ' is-enabled' : ''}`,
      attr: {
        type: 'button',
        role: 'switch',
        'aria-checked': String(enabled),
        'aria-label': enabled ? '关闭互联网分享' : '开启互联网分享',
      },
    });
    toggle.createSpan();
    toggle.disabled = !interactive;
    toggle.onclick = onToggle ?? null;
  }

  private renderWarnings(parent: HTMLElement, snapshot: ShareSnapshot): void {
    if (!snapshot.warnings.length) return;
    const warnings = parent.createDiv({ cls: 'wesight-share-warning-note' });
    const icon = warnings.createSpan();
    setIcon(icon, 'triangle-alert');
    warnings.createSpan({
      text: snapshot.warnings.length === 1
        ? snapshot.warnings[0]
        : `${snapshot.warnings[0]}，另有 ${snapshot.warnings.length - 1} 项提示`,
    });
  }

  private async publishAsNew(): Promise<void> {
    if (!this.snapshot) return;
    const confirmed = await confirmShareAction(this.app, {
      title: '发布到互联网？',
      message: '当前文章和引用的本地图片会上传到 WeSight Cloud，并生成可公开访问的链接。',
      confirmText: '确认发布',
    });
    if (!confirmed) return;
    await this.runOperation('正在发布文章…', async () => {
      if (this.shareId) {
        await this.setShareId(null);
        this.shareId = null;
      }
      const state = await this.api.createShare(this.snapshot!);
      try {
        await this.setShareId(state.id);
      } catch (error) {
        await this.api.revokeShare(state.id).catch(() => undefined);
        throw error;
      }
      this.shareId = state.id;
      this.shareState = state;
      new Notice('文章已发布到互联网。');
    });
  }

  private async update(state: ShareState, snapshot: ShareSnapshot): Promise<void> {
    if (!state.enabled) {
      const confirmed = await confirmShareAction(this.app, {
        title: '重新开启互联网分享？',
        message: '原链接会恢复访问，并发布当前笔记的最新内容。',
        confirmText: '重新开启',
      });
      if (!confirmed) return;
    }
    await this.runOperation(
      state.enabled ? '正在更新分享…' : '正在重新开启分享…',
      async () => {
        this.shareState = await this.api.updateShare(state.id, snapshot, state.assets);
        new Notice(state.enabled ? '分享内容已更新。' : '互联网分享已重新开启。');
      },
    );
  }

  private async toggleShare(state: ShareState, snapshot: ShareSnapshot): Promise<void> {
    if (!state.enabled) {
      await this.update(state, snapshot);
      return;
    }
    const confirmed = await confirmShareAction(this.app, {
      title: '关闭互联网分享？',
      message: '公开链接会立即失效，当前笔记中的分享标识会保留，之后可以恢复原链接。',
      confirmText: '关闭分享',
      dangerous: true,
    });
    if (!confirmed) return;
    await this.runOperation('正在关闭分享…', async () => {
      await this.api.revokeShare(state.id);
      this.shareState = { ...state, enabled: false, updatedAt: new Date().toISOString() };
      new Notice('互联网分享已关闭。');
    });
  }

  private async toggleComments(state: ShareState): Promise<void> {
    const enabled = !state.commentsEnabled;
    await this.runOperation(
      enabled ? '正在开启访客评论…' : '正在关闭访客评论…',
      async () => {
        this.shareState = await this.api.setCommentsEnabled(state.id, enabled);
        new Notice(enabled ? '访客评论已开启。' : '访客评论已关闭，已有评论已隐藏。');
      },
    );
  }

  private async copyLink(url: string): Promise<void> {
    await navigator.clipboard.writeText(url);
    new Notice('分享链接已复制。');
  }

  private async runOperation(label: string, operation: () => Promise<void>): Promise<void> {
    this.operationLabel = label;
    this.error = null;
    this.render();
    try {
      await operation();
    } catch (error) {
      if (error instanceof CloudAuthRequiredError) {
        this.auth.clearSession();
      }
      this.error = error instanceof Error ? error.message : '操作失败';
    } finally {
      this.operationLabel = null;
      this.render();
    }
  }

  private async setShareId(value: string | null): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file, (frontmatter: Record<string, unknown>) => {
      if (value) {
        frontmatter[SHARE_ID_FRONTMATTER_KEY] = value;
      } else {
        delete frontmatter[SHARE_ID_FRONTMATTER_KEY];
      }
    });
  }

  private findDuplicatePath(shareId: string): string | null {
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === this.file.path) continue;
      const value = recordValue(
        this.app.metadataCache.getFileCache(candidate)?.frontmatter,
        SHARE_ID_FRONTMATTER_KEY,
      );
      if (value === shareId) return candidate.path;
    }
    return null;
  }

  private position(): void {
    if (!this.panelEl) return;
    const width = Math.min(420, window.innerWidth - 24);
    this.panelEl.style.width = `${width}px`;
    const anchorRect = this.anchor?.getBoundingClientRect();
    const left = anchorRect
      ? Math.min(window.innerWidth - width - 12, Math.max(12, anchorRect.right - width))
      : window.innerWidth - width - 20;
    const preferredTop = anchorRect ? anchorRect.bottom + 8 : 76;
    const panelHeight = this.panelEl.offsetHeight || 420;
    const top = Math.min(preferredTop, Math.max(12, window.innerHeight - panelHeight - 12));
    this.panelEl.style.left = `${left}px`;
    this.panelEl.style.top = `${top}px`;
  }
}
