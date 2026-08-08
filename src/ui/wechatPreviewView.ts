import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  setIcon,
  TFile,
  type ViewStateResult,
  WorkspaceLeaf,
} from 'obsidian';

import wesightLogo from '../../assets/wesight-logo.png';

import { CloudAuthService } from '../share/cloudAuth';
import { CloudApiError } from '../share/cloudApi';
import type { CloudUser } from '../share/types';
import { WeChatCloudApi } from '../wechat/cloudApi';
import { openBillingModal } from './billingModal';
import path from 'path';
import type { RuntimeManager } from '../runtime/runtimeManager';
import {
  ThemeGenerationCancelledError,
  WeChatThemeService,
} from '../wechat/themeService';
import { mergeRuntimeText } from '../wechat/themeService';
import {
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  parseWeChatPublishState,
  writeWeChatDraftFrontmatter,
} from '../wechat/frontmatter';
import {
  renderWeChatArticle,
  renderStreamingWeChatThemePreview,
  replaceFormulaSvgs,
  serializeWeChatArticle,
} from '../wechat/renderer';
import {
  buildWeChatSnapshot,
  withWeChatSnapshotMetadata,
} from '../wechat/snapshot';
import type {
  WeChatAssetDraft,
  WeChatConnectionState,
  WeChatDraftPayload,
  WeChatDraftState,
  WeChatPreviewSnapshot,
} from '../wechat/types';
import type { WeSightObsidianSettings } from '../types';
import {
  createTemplateThemeDocument,
  getWeChatTheme,
  listWeChatThemes,
  type WeChatCustomThemePreferences,
  type WeChatThemeDocument,
  type WeChatThemeId,
  type WeChatThemeKind,
} from '../wechat/themes';
import { TemplateThemeService } from '../wechat/templateThemeService';
import type { LoadedTemplateTheme } from '../wechat/templateThemeTypes';
import { recordValue } from '../utils/records';
import { confirmShareAction } from './shareConfirm';
import { promptForCustomWeChatTheme } from './wechatCustomThemeModal';
import { promptForWeChatTitles } from './generateWeChatTitlesModal';
import { promptForWeChatCover } from './generateWeChatCoverModal';
import { createId } from '../utils/id';
import { ensureDir, safeRemoveDir } from '../utils/fs';
import { tmpDir } from '../paths';
import { StreamingPreviewAutoFollow } from './streamingPreviewAutoFollow';

export const WESIGHT_WECHAT_PREVIEW_VIEW_TYPE = 'wesight-wechat-preview';

type WeChatPreviewTab = 'preview' | 'settings';

interface WeChatPreviewViewOptions {
  auth: CloudAuthService;
  api: WeChatCloudApi;
  themeService: WeChatThemeService;
  templateThemeService: TemplateThemeService;
  runtimeManager: RuntimeManager;
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  openSettings: () => void;
}

export class WeChatPreviewView extends ItemView {
  private file: TFile | null = null;
  private connection: WeChatConnectionState | null = null;
  private snapshot: WeChatPreviewSnapshot | null = null;
  private draft: WeChatDraftState | null = null;
  private loading = false;
  private operation: string | null = null;
  private error: string | null = null;
  private errorTitle = '预览生成失败';
  private duplicatePath: string | null = null;
  private staleDraft = false;
  private acknowledgedWarnings = false;
  private titleValue = '';
  private authorValue = '';
  private digestValue = '';
  private temporaryCover: WeChatAssetDraft | null = null;
  private refreshTimer: number | null = null;
  private metadataSaveTimer: number | null = null;
  private activeTab: WeChatPreviewTab = 'preview';
  private themeDocument: WeChatThemeDocument | null = null;
  private themeMenuEl: HTMLElement | null = null;
  private themeSubmenuEl: HTMLElement | null = null;
  private themeMenuHideTimer: number | null = null;
  private themeGenerationController: AbortController | null = null;
  private themeGenerationStopping = false;
  private themeGenerationId = 0;
  private pendingThemeId: WeChatThemeId | null = null;
  private pendingCustomTheme: WeChatCustomThemePreferences | null = null;
  private streamingThemeHtml: string | null = null;
  private accountMenu: Menu | null = null;
  private streamingPreviewIframe: HTMLIFrameElement | null = null;
  private streamingPreviewTimer: number | null = null;
  private lastStreamingPreviewAt = 0;
  private readonly streamingPreviewAutoFollow = new StreamingPreviewAutoFollow();
  private streamingPreviewScrollEl: HTMLElement | null = null;
  private streamingPreviewScrollFrame: number | null = null;
  private lastStreamingPreviewScrollTop = 0;
  private streamingPreviewTouchY: number | null = null;
  private streamingPreviewScrollbarDragging = false;
  private pendingPreviewScrollRestore: { top: number; followBottom: boolean } | null = null;
  private themeGenerationError: string | null = null;
  private publishAttempt: { signature: string; idempotencyKey: string } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly options: WeChatPreviewViewOptions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return WESIGHT_WECHAT_PREVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '公众号预览';
  }

  getIcon(): string {
    return 'message-circle';
  }

  override async onOpen(): Promise<void> {
    this.registerDomEvent(document, 'click', event => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        !target?.closest('.wesight-wechat-theme-trigger')
        && !this.themeMenuEl?.contains(target)
        && !this.themeSubmenuEl?.contains(target)
      ) this.closeThemeMenus();
    });
    this.register(this.options.auth.onChange(() => {
      void this.reload();
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file?.extension === 'md') void this.setFile(file);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || file.path !== this.file?.path) return;
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.refreshContent();
      }, 450);
    }));
    if (!this.file) {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active) this.file = active;
    }
    await this.reload();
    this.warmUpCodexRuntime();
  }

  override async onClose(): Promise<void> {
    this.invalidateThemeGeneration();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.flushSaveMetadata();
    this.closeThemeMenus();
    this.clearTemporaryCover();
  }

  override getState(): Record<string, unknown> {
    return {
      filePath: this.file?.path ?? null,
      activeTab: this.activeTab,
    };
  }

  override async setState(
    state: Record<string, unknown>,
    result: ViewStateResult,
  ): Promise<void> {
    this.invalidateThemeGeneration();
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    if (file instanceof TFile) this.file = file;
    this.activeTab = state.activeTab === 'settings' ? 'settings' : 'preview';
    await super.setState(state, result);
    if (this.contentEl.isConnected) await this.reload();
  }

  async setFile(file: TFile): Promise<void> {
    if (this.file?.path === file.path && this.snapshot) return;
    this.invalidateThemeGeneration();
    this.file = file;
    this.clearTemporaryCover();
    this.acknowledgedWarnings = false;
    await this.leaf.setViewState({
      type: WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
      active: true,
      state: { filePath: file.path },
    });
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.invalidateThemeGeneration();
    this.loading = true;
    this.error = null;
    this.themeGenerationError = null;
    this.errorTitle = '预览生成失败';
    this.staleDraft = false;
    this.render();
    try {
      const user = await this.options.auth.restoreSession();
      if (!user || !this.file) {
        this.connection = null;
        this.snapshot = null;
        this.draft = null;
        return;
      }
      this.connection = await this.options.api.getConnection();
      if (!this.connection) {
        this.snapshot = null;
        this.draft = null;
        return;
      }
      const previousSnapshot = this.snapshot;
      this.snapshot = await buildWeChatSnapshot(this.app, this.file);
      this.applySnapshotMetadata(this.snapshot, previousSnapshot);
      this.loadCachedThemeDocument(this.snapshot);
      const publishState = parseWeChatPublishState(
        this.app.metadataCache.getFileCache(this.file)?.frontmatter,
      );
      this.duplicatePath = publishState
        ? this.findDuplicatePath(publishState.draftId)
        : null;
      this.draft = null;
      if (publishState && !this.duplicatePath) {
        try {
          this.draft = await this.options.api.getDraft(publishState.draftId);
        } catch (error) {
          if (error instanceof CloudApiError && error.status === 404) {
            this.staleDraft = true;
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : '公众号预览加载失败';
    } finally {
      this.loading = false;
      this.render();
    }
  }


  private async refreshContent(): Promise<void> {
    if (
      !this.file
      || !this.snapshot
      || !this.connection
      || this.themeGenerationController
    ) {
      return this.reload();
    }
    try {
      const previousSnapshot = this.snapshot;
      const newSnapshot = await buildWeChatSnapshot(this.app, this.file);
      this.snapshot = newSnapshot;
      this.applySnapshotMetadata(newSnapshot, previousSnapshot);
      if (!this.validThemeDocument(newSnapshot)) {
        this.loadCachedThemeDocument(newSnapshot);
      }
      if (this.activeTab !== 'preview') {
        // On the settings tab just keep snapshot/theme state fresh without UI disruption.
        return;
      }
      if (this.themeNeedsGeneration(newSnapshot)) {
        return this.reload();
      }
      if (!this.contentEl.querySelector('.wesight-wechat-preview-canvas-wrap')) {
        return this.reload();
      }
      const canvasWrap = this.contentEl.querySelector<HTMLElement>(
        '.wesight-wechat-preview-canvas-wrap',
      );
      const scrollTop = canvasWrap?.scrollTop ?? 0;
      await this.updatePreviewArticle(newSnapshot, scrollTop);
      this.updateToolbarAndSummary(newSnapshot);
    } catch {
      return this.reload();
    }
  }

  private async updatePreviewArticle(
    snapshot: WeChatPreviewSnapshot,
    preserveScrollTop: number,
  ): Promise<void> {
    const canvasWrap = this.contentEl.querySelector<HTMLElement>(
      '.wesight-wechat-preview-canvas-wrap',
    );
    const canvas = canvasWrap?.querySelector<HTMLElement>('.wesight-wechat-preview-canvas');
    if (!canvasWrap || !canvas) return;
    if (this.themeGenerationController && this.streamingThemeHtml !== null) return;

    // The visible article may have had its className overwritten by the template
    // renderer, so identify it by direct reference before appending the new one.
    const oldArticle = Array.from(canvas.children).find(
      child => child !== this.streamingPreviewIframe
        && !child.classList.contains('wesight-wechat-streaming-preview'),
    ) as HTMLElement | undefined;

    const prepared = this.preparedSnapshot();
    const newArticle = createDiv({ cls: 'wesight-wechat-preview-article' });
    newArticle.addClass('wesight-wechat-preview-article-pending');
    newArticle.setCssProps({
      position: 'absolute',
      visibility: 'hidden',
      left: '-9999px',
      width: '100%',
    });
    canvas.appendChild(newArticle);
    try {
      await renderWeChatArticle(this.app, this, prepared, newArticle, {
        themeDocument: this.validThemeDocument(prepared),
        templateTheme: this.currentTemplateTheme(),
      });
      if (oldArticle?.isConnected) {
        oldArticle.replaceWith(newArticle);
      }
      newArticle.removeClass('wesight-wechat-preview-article-pending');
      newArticle.setCssProps({
        position: '',
        visibility: '',
        left: '',
        width: '',
      });
      canvasWrap.scrollTop = Math.min(
        preserveScrollTop,
        Math.max(0, canvasWrap.scrollHeight - canvasWrap.clientHeight),
      );
    } catch (error) {
      newArticle.remove();
      throw error;
    }
  }

  private updateToolbarAndSummary(snapshot: WeChatPreviewSnapshot): void {
    const toolbar = this.contentEl.querySelector('.wesight-wechat-publish-toolbar');
    if (toolbar) {
      const newToolbar = createDiv({ cls: 'wesight-wechat-publish-toolbar' });
      this.renderPublishingToolbar(newToolbar, snapshot);
      toolbar.replaceWith(newToolbar);
    }
    const summary = this.contentEl.querySelector('.wesight-wechat-preview-summary');
    if (summary) {
      const newSummary = createDiv({ cls: 'wesight-wechat-preview-summary' });
      this.renderPreviewSummary(newSummary, snapshot);
      summary.replaceWith(newSummary);
    }
    this.updateBanners(snapshot);
  }

  private updateBanners(_snapshot: WeChatPreviewSnapshot): void {
    const contentEl = this.contentEl;
    const existingBanners = Array.from(
      contentEl.querySelectorAll('.wesight-wechat-preview-banner'),
    );
    existingBanners.forEach(banner => banner.remove());
    const toolbar = contentEl.querySelector('.wesight-wechat-publish-toolbar');
    if (!toolbar) return;
    const prepared = this.preparedSnapshot();
    const banners: { icon: string; text: string }[] = [];
    if (this.duplicatePath) {
      banners.push({
        icon: 'circle-alert',
        text: `另一篇笔记“${this.duplicatePath}”关联了同一篇公众号草稿，本次只能另存为新草稿。`,
      });
    } else if (this.staleDraft) {
      banners.push({
        icon: 'circle-alert',
        text: '原公众号草稿已删除、已发布或失效，本次将创建新草稿。',
      });
    }
    if (this.themeGenerationError) {
      banners.push({ icon: 'circle-alert', text: `主题生成失败：${this.themeGenerationError}` });
    }
    if (this.themeNeedsGeneration(prepared) && !this.themeGenerationController) {
      banners.push({
        icon: 'sparkles',
        text: `${this.currentThemeLabel()} 主题待重新生成，当前暂时显示 Canghe Style 预览。`,
      });
    }
    const summary = contentEl.querySelector('.wesight-wechat-preview-summary');
    banners.forEach(({ icon, text }) => {
      const banner = contentEl.createDiv({ cls: 'wesight-wechat-preview-banner' });
      const bannerIcon = banner.createSpan();
      setIcon(bannerIcon, icon);
      banner.createSpan({ text });
      if (summary) {
        summary.before(banner);
      } else {
        toolbar.after(banner);
      }
    });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-wechat-preview-view');
    this.renderHeader(contentEl);
    if (this.loading) {
      this.renderStatus(contentEl, 'loader-circle', '正在生成公众号预览…');
      return;
    }
    if (!this.file) {
      this.renderEmpty(contentEl, '打开一篇 Markdown 笔记后即可预览公众号排版。');
      return;
    }
    if (!this.options.auth.getCurrentUser()) {
      this.renderLogin(contentEl);
      return;
    }
    if (this.error) {
      this.renderError(contentEl);
      return;
    }
    if (!this.connection) {
      this.renderConfigure(contentEl);
      return;
    }
    if (!this.snapshot) {
      this.renderEmpty(contentEl, '无法读取当前笔记。');
      return;
    }
    this.renderEditor(contentEl, this.snapshot);
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'wesight-wechat-preview-header' });
    const brand = header.createDiv({ cls: 'wesight-wechat-preview-brand' });
    brand.createEl('img', {
      cls: 'wesight-wechat-preview-logo',
      attr: {
        src: wesightLogo,
        alt: '',
        'aria-hidden': 'true',
      },
    });
    brand.createEl('h4', { text: 'WeSight', cls: 'wesight-wechat-preview-brand-text' });

    const actions = header.createDiv({ cls: 'wesight-wechat-preview-header-actions' });
    const refresh = actions.createEl('button', {
      cls: 'clickable-icon wesight-header-btn',
      attr: {
        type: 'button',
        'aria-label': this.themeGenerationController ? '停止公众号主题生成' : '刷新公众号排版',
      },
    });
    setIcon(refresh, this.themeGenerationController ? 'square' : 'refresh-cw');
    refresh.toggleClass('is-stop', Boolean(this.themeGenerationController));
    refresh.disabled = this.loading
      || this.themeGenerationStopping
      || (Boolean(this.operation) && !this.themeGenerationController);
    refresh.onclick = () => {
      if (this.themeGenerationController) this.stopThemeGeneration();
      else void this.refreshPreview();
    };

    this.renderAccountControl(actions);
  }

  private renderAccountControl(parent: HTMLElement): void {
    parent.empty();
    const user = this.options.auth.getCurrentUser();

    if (!user) {
      const login = parent.createEl('button', {
        cls: 'wesight-login-button',
        text: '登录',
        attr: {
          type: 'button',
          'aria-label': '登录 WeSight',
        },
      });
      login.onclick = () => this.options.auth.startLogin();
      return;
    }

    const account = parent.createEl('button', {
      cls: 'clickable-icon wesight-account-button',
      attr: {
        type: 'button',
        'aria-label': `${user.nickname}，打开账户菜单`,
        title: user.nickname,
        'aria-haspopup': 'menu',
      },
    });
    const avatar = account.createSpan({ cls: 'wesight-account-avatar' });
    this.renderUserAvatar(avatar, user);
    account.onclick = (event) => {
      event.stopPropagation();
      this.openAccountMenu(account, user);
    };
    parent.appendChild(account);
  }

  private renderUserAvatar(parent: HTMLElement, user: CloudUser): void {
    parent.empty();
    const renderFallback = () => {
      parent.empty();
      const icon = parent.createSpan({ cls: 'wesight-account-avatar-fallback' });
      setIcon(icon, 'user-round');
    };
    if (!user.avatarUrl) {
      renderFallback();
      return;
    }
    const image = parent.createEl('img', {
      cls: 'wesight-account-avatar-image',
      attr: {
        src: user.avatarUrl,
        alt: '',
      },
    });
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onerror = renderFallback;
  }

  private openAccountMenu(anchor: HTMLElement, user: CloudUser): void {
    this.accountMenu?.hide();
    const menu = new Menu();
    const profile = createFragment();
    const profileRow = createDiv();
    profileRow.className = 'wesight-account-menu-profile';
    const avatar = createSpan();
    avatar.className = 'wesight-account-avatar wesight-account-menu-avatar';
    this.renderUserAvatar(avatar, user);
    const nickname = createSpan();
    nickname.className = 'wesight-account-menu-nickname';
    nickname.textContent = user.nickname;
    profileRow.append(avatar, nickname);
    profile.append(profileRow);
    menu.addItem(item => item
      .setTitle(profile)
      .setIsLabel(true));
    const billing = this.options.auth.getBillingSummary();
    menu.addItem(item => item
      .setTitle(billing
        ? `${billing.membership.active ? '创作者会员' : '免费用户'} · ${billing.totalCreditsRemaining} 积分`
        : '正在加载积分…')
      .setIcon('gem')
      .setIsLabel(true));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('账户详情')
      .setIcon('circle-user-round')
      .onClick(() => this.options.auth.openAccount()));
    if (user.isAdmin) {
      menu.addItem(item => item
        .setTitle('管理后台')
        .setIcon('layout-dashboard')
        .onClick(() => this.options.auth.openAdmin()));
    }
    menu.addItem(item => item
      .setTitle('会员与积分')
      .setIcon('wallet-cards')
      .onClick(() => this.options.auth.openBilling()));
    menu.addItem(item => item
      .setTitle('退出登录')
      .setIcon('log-out')
      .onClick(() => {
        this.options.auth.clearSession();
        new Notice('已退出 WeSight。');
      }));
    menu.onHide(() => {
      if (this.accountMenu === menu) this.accountMenu = null;
    });
    const bounds = anchor.getBoundingClientRect();
    const accountMenuWidth = 190;
    menu.showAtPosition({
      x: Math.max(8, bounds.right - accountMenuWidth),
      y: bounds.bottom + 4,
      width: accountMenuWidth,
    });
    this.accountMenu = menu;
  }

  private renderLogin(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'wesight-wechat-preview-empty' });
    empty.createEl('h3', { text: '登录 WeSight' });
    empty.createEl('p', { text: '登录后即可连接公众号并同步后台草稿箱。' });
    const button = empty.createEl('button', {
      cls: 'mod-cta',
      text: '请先登录WeSight',
    });
    button.onclick = () => this.options.auth.startLogin();
  }

  private renderConfigure(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'wesight-wechat-preview-empty' });
    empty.createEl('h3', { text: '连接微信公众号' });
    empty.createEl('p', {
      text: '请先在 WeSight 设置的“发布平台”中填写 AppID 与 AppSecret。',
    });
    const button = empty.createEl('button', {
      cls: 'mod-cta',
      text: '前往发布平台设置',
    });
    button.onclick = this.options.openSettings;
  }

  private renderError(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-wechat-preview-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    error.createEl('strong', { text: this.errorTitle });
    error.createEl('p', { text: this.error ?? '请稍后重试。' });
    const retry = error.createEl('button', { text: '重新生成' });
    retry.onclick = () => void this.reload();
  }

  private renderEditor(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    this.renderTabs(parent, snapshot);
    this.renderPublishingToolbar(parent, snapshot);

    if (this.duplicatePath) {
      this.renderBanner(
        parent,
        'circle-alert',
        `另一篇笔记“${this.duplicatePath}”关联了同一篇公众号草稿，本次只能另存为新草稿。`,
      );
    } else if (this.staleDraft) {
      this.renderBanner(
        parent,
        'circle-alert',
        '原公众号草稿已删除、已发布或失效，本次将创建新草稿。',
      );
    }

    if (this.themeGenerationError) {
      this.renderBanner(parent, 'circle-alert', `主题生成失败：${this.themeGenerationError}`);
    }

    const prepared = this.preparedSnapshot();
    if (this.themeNeedsGeneration(prepared) && !this.themeGenerationController) {
      this.renderBanner(
        parent,
        'sparkles',
        `${this.currentThemeLabel()} 主题待重新生成，当前暂时显示 Canghe Style 预览。`,
      );
    }

    if (this.activeTab === 'settings') {
      this.renderPublishingSettings(parent, snapshot);
      return;
    }

    this.renderPreviewSummary(parent, snapshot);

    const canvasWrap = parent.createDiv({ cls: 'wesight-wechat-preview-canvas-wrap' });
    const canvas = canvasWrap.createDiv({ cls: 'wesight-wechat-preview-canvas' });
    if (this.streamingThemeHtml !== null && this.themeGenerationController) {
      this.bindStreamingPreviewAutoFollow(canvasWrap);
      const iframe = canvas.createEl('iframe', {
        cls: 'wesight-wechat-streaming-preview',
        attr: {
          title: `${this.currentThemeLabel()} 流式排版预览`,
          sandbox: 'allow-same-origin',
          referrerpolicy: 'no-referrer',
        },
      });
      this.streamingPreviewIframe = iframe;
      renderStreamingWeChatThemePreview(prepared, iframe, this.streamingThemeHtml, {
        onResize: () => this.scheduleStreamingPreviewAutoScroll(canvasWrap),
        onUserScrollUp: () => this.pauseStreamingPreviewAutoFollow(),
        onUserWheel: deltaY => this.forwardStreamingPreviewWheel(canvasWrap, deltaY),
      });
      this.updateStreamingPreviewFollowButton();
      return;
    }
    this.streamingPreviewIframe = null;
    const article = canvas.createDiv({ cls: 'wesight-wechat-preview-article' });
    void renderWeChatArticle(this.app, this, prepared, article, {
      themeDocument: this.validThemeDocument(prepared),
      templateTheme: this.currentTemplateTheme(),
    })
      .then(() => this.restorePreviewScroll(canvasWrap))
      .catch((error) => {
        this.error = error instanceof Error ? error.message : '排版渲染失败';
        this.render();
      });
  }

  private renderTabs(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const tabs = parent.createDiv({
      cls: 'wesight-wechat-preview-tabs',
      attr: { role: 'tablist', 'aria-label': '公众号预览页面' },
    });
    const preview = tabs.createEl('button', {
      cls: this.activeTab === 'preview' ? 'is-active' : '',
      text: `公众号预览（${this.connection?.displayName || '公众号'}）`,
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(this.activeTab === 'preview'),
      },
    });
    preview.onclick = () => {
      this.flushSaveMetadata();
      this.activeTab = 'preview';
      this.render();
    };
    const settings = tabs.createEl('button', {
      cls: this.activeTab === 'settings' ? 'is-active' : '',
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(this.activeTab === 'settings'),
      },
    });
    settings.createSpan({ text: '发布设置' });
    if (snapshot.warnings.length) {
      settings.createSpan({
        cls: 'wesight-wechat-preview-tab-badge',
        text: String(snapshot.warnings.length),
      });
    }
    settings.onclick = () => {
      this.activeTab = 'settings';
      this.render();
    };
  }

  private renderPublishingToolbar(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const toolbar = parent.createDiv({ cls: 'wesight-wechat-publish-toolbar' });
    const prepared = this.preparedSnapshot();
    const themeDocument = this.validThemeDocument(prepared);
    const themeNeedsGeneration = this.themeNeedsGeneration(prepared);
    const publicationHash = themeDocument?.contentHash ?? prepared.contentHash;
    const unchanged = Boolean(this.draft && publicationHash === this.draft.contentHash);
    const updateExisting = Boolean(this.draft && !this.duplicatePath && !this.staleDraft);
    const hasBlockingWarnings = snapshot.warnings.some((warning) => warning.blocking);
    const actions = toolbar.createDiv({ cls: 'wesight-wechat-publish-actions' });
    const primary = actions.createEl('button', {
      cls: 'mod-cta wesight-wechat-publish-button',
      text: updateExisting ? '更新文章' : '发文章',
      attr: { type: 'button' },
    });
    primary.disabled = Boolean(this.operation)
      || unchanged
      || themeNeedsGeneration
      || (hasBlockingWarnings && !this.acknowledgedWarnings);
    primary.onclick = () => void this.publish(false);

    const copy = actions.createEl('button', {
      cls: 'wesight-wechat-copy-button',
      text: '复制',
      attr: { type: 'button', 'aria-label': '复制公众号文章格式到剪贴板' },
    });
    copy.disabled = Boolean(this.operation) || themeNeedsGeneration;
    copy.onclick = () => void this.copyToClipboard();

    const themeTrigger = toolbar.createEl('button', {
      cls: 'wesight-wechat-theme-trigger',
      attr: {
        type: 'button',
        'aria-label': `选择公众号主题，当前为 ${this.currentThemeLabel()}`,
        'aria-haspopup': 'menu',
        'aria-expanded': String(Boolean(this.themeMenuEl)),
      },
    });
    themeTrigger.createSpan({
      cls: 'wesight-wechat-theme-trigger-label',
      text: `主题 · ${this.currentThemeLabel()}`,
    });
    const themeChevron = themeTrigger.createSpan();
    setIcon(themeChevron, this.operation?.includes('主题') ? 'loader-circle' : 'chevron-down');
    themeTrigger.disabled = Boolean(this.operation);
    themeTrigger.onclick = event => this.showThemeMenu(event, themeTrigger);

    const state = toolbar.createDiv({ cls: 'wesight-wechat-publish-state' });
    const stateIcon = state.createSpan();
    if (this.operation) {
      state.addClass('is-loading');
      setIcon(stateIcon, 'loader-circle');
      state.createSpan({ text: this.operation });
    } else if (themeNeedsGeneration) {
      setIcon(stateIcon, 'sparkles');
      state.createSpan({ text: '主题待重新生成' });
    } else if (unchanged) {
      state.addClass('is-success');
      setIcon(stateIcon, 'circle-check');
      state.createSpan({ text: '草稿已是最新' });
    } else if (updateExisting) {
      setIcon(stateIcon, 'clock-3');
      state.createSpan({ text: '草稿有更新待同步' });
    } else {
      setIcon(stateIcon, 'cloud-upload');
      state.createSpan({ text: '准备发布' });
    }

    const more = toolbar.createEl('button', {
      cls: 'clickable-icon wesight-wechat-publish-more',
      attr: { type: 'button', 'aria-label': '更多公众号草稿操作' },
    });
    setIcon(more, 'more-vertical');
    more.disabled = Boolean(this.operation);
    more.onclick = (event) => this.showPublishingMenu(event);
  }

  private showThemeMenu(event: MouseEvent, trigger: HTMLButtonElement): void {
    event.stopPropagation();
    if (this.themeMenuEl) {
      this.closeThemeMenus();
      trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    const menu = createDiv({ cls: 'wesight-wechat-theme-menu' });
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '公众号主题');
    this.renderThemeCategory(menu, 'template', '模板');
    this.renderThemeCategory(menu, 'skill', '主题 Skill');

    const ai = menu.createDiv({
      cls: 'wesight-wechat-theme-menu-item is-ai',
      attr: { role: 'menuitem', tabindex: '0' },
    });
    const aiIcon = ai.createSpan({ cls: 'wesight-wechat-theme-menu-icon' });
    setIcon(aiIcon, 'sparkles');
    ai.createSpan({ text: 'AI自定义主题' });
    if (getWeChatTheme(this.currentThemeId()).kind === 'custom') {
      const check = ai.createSpan({ cls: 'wesight-wechat-theme-option-check' });
      setIcon(check, 'check');
    }
    const openCustomTheme = (aiEvent: Event): void => {
      aiEvent.stopPropagation();
      this.closeThemeMenus();
      void this.configureCustomTheme();
    };
    ai.onclick = openCustomTheme;
    ai.onkeydown = aiEvent => {
      if (aiEvent.key === 'Enter' || aiEvent.key === ' ') openCustomTheme(aiEvent);
      if (aiEvent.key === 'Escape') this.closeThemeMenus();
    };

    menu.addEventListener('mouseenter', () => this.cancelThemeMenuHide());
    menu.addEventListener('mouseleave', () => this.scheduleThemeMenuHide());
    document.body.appendChild(menu);
    this.themeMenuEl = menu;
    trigger.setAttribute('aria-expanded', 'true');
    this.positionThemeMenu(menu, trigger.getBoundingClientRect(), 'below');
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }

  private renderThemeCategory(
    menu: HTMLElement,
    kind: WeChatThemeKind,
    label: string,
  ): void {
    const item = menu.createDiv({
      cls: 'wesight-wechat-theme-menu-item has-submenu',
      attr: { role: 'menuitem', tabindex: '0' },
    });
    item.createSpan({ text: label });
    const arrow = item.createSpan({ cls: 'wesight-wechat-theme-menu-arrow' });
    setIcon(arrow, 'chevron-right');
    const open = (event?: Event): void => {
      event?.stopPropagation();
      this.showThemeSubmenu(kind, item);
    };
    item.addEventListener('mouseenter', open);
    item.addEventListener('mouseleave', () => this.scheduleThemeMenuHide());
    item.onclick = open;
    item.onfocus = () => this.showThemeSubmenu(kind, item);
    item.onkeydown = itemEvent => {
      if (itemEvent.key === 'Enter' || itemEvent.key === ' ' || itemEvent.key === 'ArrowRight') {
        itemEvent.preventDefault();
        open(itemEvent);
        this.themeSubmenuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      }
      if (itemEvent.key === 'ArrowDown') {
        itemEvent.preventDefault();
        (item.nextElementSibling as HTMLElement | null)?.focus();
      }
      if (itemEvent.key === 'ArrowUp') {
        itemEvent.preventDefault();
        (item.previousElementSibling as HTMLElement | null)?.focus();
      }
      if (itemEvent.key === 'Escape') this.closeThemeMenus();
    };
  }

  private showThemeSubmenu(kind: WeChatThemeKind, trigger: HTMLElement): void {
    this.cancelThemeMenuHide();
    this.themeSubmenuEl?.remove();
    this.themeSubmenuEl = null;
    for (const item of Array.from(this.themeMenuEl?.querySelectorAll('.is-active') ?? [])) {
      item.removeClass('is-active');
    }
    trigger.addClass('is-active');

    const submenu = createDiv({ cls: 'wesight-wechat-theme-submenu' });
    submenu.setAttribute('role', 'menu');
    submenu.setAttribute('aria-label', kind === 'template' ? '模板' : '主题 Skill');
    const currentThemeId = this.currentThemeId();
    for (const theme of listWeChatThemes(kind)) {
      const item = submenu.createDiv({
        cls: 'wesight-wechat-theme-menu-item wesight-wechat-theme-option',
        attr: { role: 'menuitem', tabindex: '0' },
      });
      item.toggleClass('is-selected', theme.id === currentThemeId);
      const swatch = item.createSpan({ cls: 'wesight-wechat-theme-swatch' });
      swatch.style.backgroundColor = theme.color;
      item.createSpan({ cls: 'wesight-wechat-theme-option-label', text: theme.label });
      if (theme.id === currentThemeId) {
        const check = item.createSpan({ cls: 'wesight-wechat-theme-option-check' });
        setIcon(check, 'check');
      }
      const select = (selectEvent: Event): void => {
        selectEvent.stopPropagation();
        void this.selectTheme(theme.id);
      };
      item.onclick = select;
      item.onkeydown = itemEvent => {
        if (itemEvent.key === 'Enter' || itemEvent.key === ' ') select(itemEvent);
        if (itemEvent.key === 'ArrowDown') {
          itemEvent.preventDefault();
          (item.nextElementSibling as HTMLElement | null)?.focus();
        }
        if (itemEvent.key === 'ArrowUp') {
          itemEvent.preventDefault();
          (item.previousElementSibling as HTMLElement | null)?.focus();
        }
        if (itemEvent.key === 'ArrowLeft') {
          itemEvent.preventDefault();
          trigger.focus();
        }
        if (itemEvent.key === 'Escape') this.closeThemeMenus();
      };
    }
    submenu.addEventListener('mouseenter', () => this.cancelThemeMenuHide());
    submenu.addEventListener('mouseleave', () => this.scheduleThemeMenuHide());
    document.body.appendChild(submenu);
    this.themeSubmenuEl = submenu;
    this.positionThemeMenu(submenu, trigger.getBoundingClientRect(), 'side');
  }

  private positionThemeMenu(
    menu: HTMLElement,
    trigger: DOMRect,
    placement: 'below' | 'side',
  ): void {
    const bounds = menu.getBoundingClientRect();
    let left = placement === 'below' ? trigger.left : trigger.right + 4;
    let top = placement === 'below' ? trigger.bottom + 4 : trigger.top - 4;
    if (left + bounds.width > window.innerWidth - 8) {
      left = placement === 'below'
        ? Math.max(8, window.innerWidth - bounds.width - 8)
        : trigger.left - bounds.width - 4;
    }
    if (top + bounds.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - bounds.height - 8);
    }
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  private scheduleThemeMenuHide(): void {
    this.cancelThemeMenuHide();
    this.themeMenuHideTimer = window.setTimeout(() => this.closeThemeMenus(), 220);
  }

  private cancelThemeMenuHide(): void {
    if (this.themeMenuHideTimer !== null) window.clearTimeout(this.themeMenuHideTimer);
    this.themeMenuHideTimer = null;
  }

  private closeThemeMenus(): void {
    this.cancelThemeMenuHide();
    this.themeSubmenuEl?.remove();
    this.themeMenuEl?.remove();
    this.themeSubmenuEl = null;
    this.themeMenuEl = null;
    this.contentEl.querySelector('.wesight-wechat-theme-trigger')?.setAttribute('aria-expanded', 'false');
  }

  private showPublishingMenu(event: MouseEvent): void {
    const menu = new Menu();
    if (this.draft) {
      const hasUnacknowledgedBlockingWarnings = Boolean(
        this.snapshot?.warnings.some((warning) => warning.blocking)
        && !this.acknowledgedWarnings,
      );
      menu.addItem((item) => item
        .setTitle('另存为新草稿')
        .setIcon('copy-plus')
        .setDisabled(Boolean(this.operation) || hasUnacknowledgedBlockingWarnings)
        .onClick(() => void this.publish(true)));
    }
    menu.addItem((item) => item
      .setTitle('打开公众号后台')
      .setIcon('external-link')
      .onClick(() => window.open('https://mp.weixin.qq.com/', '_blank', 'noopener,noreferrer')));
    menu.showAtMouseEvent(event);
  }

  private renderPreviewSummary(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const summary = parent.createDiv({ cls: 'wesight-wechat-preview-summary' });
    const connection = summary.createDiv();
    connection.createSpan({ cls: 'wesight-wechat-connected-dot' });
    connection.createSpan({ text: `已连接 · ${this.file?.basename ?? snapshot.title}` });
    const check = summary.createEl('button', {
      attr: { type: 'button' },
      text: snapshot.warnings.length ? `检查 ${snapshot.warnings.length} 项` : '发布检查通过',
    });
    const icon = check.createSpan();
    setIcon(icon, snapshot.warnings.length ? 'chevron-right' : 'circle-check');
    check.onclick = () => {
      this.activeTab = 'settings';
      this.render();
    };
  }

  private renderPublishingSettings(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const settings = parent.createDiv({ cls: 'wesight-wechat-publishing-settings' });
    const articleSection = settings.createDiv({ cls: 'wesight-wechat-settings-section' });
    articleSection.createEl('h2', { text: '文章信息' });
    this.renderMetadataFields(articleSection);

    const coverSection = settings.createDiv({ cls: 'wesight-wechat-settings-section' });
    coverSection.createEl('h2', { text: '文章封面' });
    this.renderCover(coverSection, snapshot);

    const checkSection = settings.createDiv({ cls: 'wesight-wechat-settings-section' });
    this.renderWarnings(checkSection, snapshot);
    checkSection.createEl('p', {
      cls: 'wesight-wechat-settings-hint',
      text: '修改后可切回预览查看最终排版',
    });
  }

  private renderMetadataFields(parent: HTMLElement): void {
    const fields = parent.createDiv({ cls: 'wesight-wechat-metadata-fields' });
    const title = fields.createEl('label', { cls: 'is-wide' });
    const titleLabelRow = title.createDiv({ cls: 'wesight-wechat-metadata-label-row' });
    titleLabelRow.createSpan({ text: '标题' });
    const generateTitleBtn = titleLabelRow.createEl('button', {
      cls: 'clickable-icon wesight-wechat-ai-generate-btn',
      attr: { type: 'button', 'aria-label': 'AI 生成爆款标题' },
    });
    setIcon(generateTitleBtn, 'sparkles');
    generateTitleBtn.disabled = Boolean(this.operation) || !this.snapshot;
    generateTitleBtn.onclick = async () => {
      if (!this.snapshot) return;
      const selected = await promptForWeChatTitles(this.app, {
        runtimeManager: this.options.runtimeManager,
        getSettings: this.options.getSettings,
        snapshot: this.preparedSnapshot(),
        auth: this.options.auth,
      });
      if (selected !== null) {
        this.titleValue = selected;
        this.render();
      }
    };
    const titleInput = title.createEl('input', { type: 'text' });
    titleInput.value = this.titleValue;
    titleInput.maxLength = 128;
    titleInput.oninput = () => {
      this.titleValue = titleInput.value;
      this.scheduleSaveMetadata();
    };
    titleInput.onblur = () => {
      this.flushSaveMetadata();
      this.render();
    };
    const author = fields.createEl('label', { cls: 'is-wide' });
    author.createSpan({ text: '作者' });
    const authorInput = author.createEl('input', { type: 'text' });
    authorInput.value = this.authorValue;
    authorInput.maxLength = 64;
    authorInput.oninput = () => {
      this.authorValue = authorInput.value;
      this.scheduleSaveMetadata();
    };
    authorInput.onblur = () => {
      this.flushSaveMetadata();
      this.render();
    };
    const digest = fields.createEl('label', { cls: 'is-wide' });
    const digestLabelRow = digest.createDiv({ cls: 'wesight-wechat-metadata-label-row' });
    digestLabelRow.createSpan({ text: '摘要' });
    const generateDigestBtn = digestLabelRow.createEl('button', {
      cls: 'clickable-icon wesight-wechat-ai-generate-btn',
      attr: { type: 'button', 'aria-label': 'AI 生成摘要' },
    });
    setIcon(generateDigestBtn, 'sparkles');
    generateDigestBtn.disabled = Boolean(this.operation) || !this.snapshot;
    generateDigestBtn.onclick = () => void this.generateDigest();
    const digestInput = digest.createEl('textarea');
    digestInput.value = this.digestValue;
    digestInput.maxLength = 600;
    digestInput.rows = 2;
    digestInput.oninput = () => {
      this.digestValue = digestInput.value;
      this.scheduleSaveMetadata();
    };
    digestInput.onblur = () => {
      this.flushSaveMetadata();
      this.render();
    };
  }

  private async generateDigest(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    const runDir = path.join(tmpDir(process.env), 'wechat-digest-runs', createId('run'));
    ensureDir(runDir);
    this.operation = '正在生成摘要…';
    this.error = null;
    this.render();
    let controller: AbortController | null = null;
    try {
      const settings = this.options.getSettings();
      const agentId = settings.defaultAgentId;
      let outputText = '';
      let runtimeError: string | null = null;
      controller = new AbortController();

      await this.options.runtimeManager.runTurn({
       conversationId: createId('wechat-digest'),
       agentId,
        prompt: this.buildDigestGenerationPrompt(this.preparedSnapshot()),
       cwd: runDir,
        configSource: settings.configSources[agentId],
        providerProfileId: settings.providerProfileByAgent[agentId] || undefined,
        model: settings.localModelByAgent[agentId] || undefined,
        planMode: false,
        textOnly: true,
        signal: controller.signal,
      }, event => {
        if (event.type === 'text') {
          outputText = mergeRuntimeText(outputText, event.content);
        } else if (event.type === 'error') {
          runtimeError = [event.message, event.detail].filter(Boolean).join('：');
        }
      });

      if (controller.signal.aborted) return;
      if (runtimeError) throw new Error(runtimeError);
      const digest = this.extractGeneratedDigest(outputText);
      if (!digest) throw new Error('模型没有返回可用摘要。');
      this.digestValue = digest.slice(0, 600);
      new Notice('摘要已生成。');
    } catch (error) {
      if (controller && controller.signal.aborted) return;
      new Notice(error instanceof Error ? error.message : '摘要生成失败');
    } finally {
     safeRemoveDir(runDir);
     this.operation = null;
     if (this.contentEl.isConnected) this.render();
   }
 }

  private buildDigestGenerationPrompt(snapshot: WeChatPreviewSnapshot): string {
    const title = snapshot.title.trim();
    let article = snapshot.markdown.trim();
    const truncated = article.length > 6000;
    if (truncated) {
      article = article.slice(0, 6000);
    }
    const sections: string[] = [
      '你是微信公众号编辑助手。请根据下面文章内容，撰写一段简洁的公众号摘要，用于文章卡片/转发预览。',
      '要求：',
      '- 控制在 120 字以内，语言自然、有吸引力。',
      '- 不要输出标题、不要解释、不要代码围栏。',
      '- 只输出摘要正文。',
    ];
    if (title) {
      sections.push(`当前标题：${title}`);
    }
    sections.push('===== 文章内容 START =====');
    sections.push(article);
    if (truncated) {
      sections.push('（后文已省略）');
    }
    sections.push('===== 文章内容 END =====');
    return sections.join('\n');
  }

  private extractGeneratedDigest(output: string): string | null {
    const cleaned = output
      .replace(/```(?:\w+)?\s*([\s\S]*?)\s*```/g, '$1')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    return cleaned || null;
  }

  private renderCover(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const row = parent.createDiv({ cls: 'wesight-wechat-cover-row' });
    const preview = row.createDiv({ cls: 'wesight-wechat-cover-preview' });
    const source = this.coverPreviewSource(snapshot);
    if (source) {
      preview.createEl('img', { attr: { src: source, alt: '公众号封面预览' } });
    } else {
      const icon = preview.createSpan();
      setIcon(icon, 'image');
    }
    const copy = row.createDiv();
    copy.createEl('strong', { text: this.coverDescription(snapshot) });
    copy.createSpan({ text: '推荐尺寸 2.35:1' });
    const choose = row.createEl('button', { text: '更换封面' });
    choose.onclick = () => this.chooseTemporaryCover();

    const generateCover = row.createEl('button', {
      cls: 'clickable-icon wesight-wechat-cover-generate-btn',
      attr: { type: 'button', 'aria-label': 'AI 生成封面' },
    });
    setIcon(generateCover, 'sparkles');
    generateCover.disabled = Boolean(this.operation) || !this.snapshot;
    generateCover.onclick = async () => {
      if (!this.snapshot) return;
      const asset = await promptForWeChatCover(this.app, {
        runtimeManager: this.options.runtimeManager,
        getSettings: this.options.getSettings,
        snapshot: this.preparedSnapshot(),
      });
      if (asset) {
        this.clearTemporaryCover();
        this.temporaryCover = asset;
        this.render();
      }
    };
  }

  private renderWarnings(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const box = parent.createDiv({ cls: 'wesight-wechat-preview-warnings' });
    const heading = box.createDiv({ cls: 'wesight-wechat-warnings-heading' });
    heading.createEl('h2', { text: '发布检查' });
    if (snapshot.warnings.length) {
      heading.createSpan({ text: `${snapshot.warnings.length} 项待确认` });
    }
    if (!snapshot.warnings.length) {
      const success = box.createDiv({ cls: 'wesight-wechat-warning-item is-success' });
      const icon = success.createSpan();
      setIcon(icon, 'circle-check');
      success.createSpan({ text: '当前内容已通过发布检查' });
      return;
    }
    const list = box.createDiv({ cls: 'wesight-wechat-warning-list' });
    for (const warning of snapshot.warnings) {
      const item = list.createDiv({ cls: 'wesight-wechat-warning-item' });
      const icon = item.createSpan();
      setIcon(icon, 'triangle-alert');
      item.createSpan({ text: warning.message });
    }
    const acknowledgment = box.createEl('label');
    const checkbox = acknowledgment.createEl('input', { type: 'checkbox' });
    checkbox.checked = this.acknowledgedWarnings;
    checkbox.onchange = () => {
      this.acknowledgedWarnings = checkbox.checked;
      this.render();
    };
    acknowledgment.createSpan({ text: '我已检查预览，继续同步当前可发布内容' });
  }

  private renderBanner(parent: HTMLElement, iconName: string, text: string): void {
    const banner = parent.createDiv({ cls: 'wesight-wechat-preview-banner' });
    const icon = banner.createSpan();
    setIcon(icon, iconName);
    banner.createSpan({ text });
  }

  private renderStatus(parent: HTMLElement, iconName: string, text: string): void {
    const status = parent.createDiv({ cls: 'wesight-wechat-preview-status' });
    const icon = status.createSpan();
    setIcon(icon, iconName);
    status.createSpan({ text });
  }

  private renderEmpty(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: 'wesight-wechat-preview-empty', text });
  }

  private currentThemeId(): WeChatThemeId {
    return this.pendingThemeId ?? this.options.getSettings().wechatThemeId;
  }

  private currentTemplateTheme(): LoadedTemplateTheme | null {
    return this.options.templateThemeService
      .getLoadedTemplateThemes()
      .find(theme => theme.manifest.id === this.currentThemeId()) ?? null;
  }

  private currentThemeLabel(): string {
    const theme = getWeChatTheme(this.currentThemeId());
    if (theme.kind !== 'custom') return theme.label;
    return this.pendingCustomTheme?.name.trim()
      || this.options.getSettings().wechatCustomThemeName.trim()
      || theme.label;
  }

  private loadCachedThemeDocument(snapshot: WeChatPreviewSnapshot): void {
    const themeId = this.currentThemeId();
    this.themeDocument = getWeChatTheme(themeId).kind === 'template'
      ? createTemplateThemeDocument(snapshot, themeId)
      : this.options.themeService.getCached(snapshot, themeId);
  }

  private validThemeDocument(snapshot: WeChatPreviewSnapshot): WeChatThemeDocument | null {
    const themeId = this.currentThemeId();
    if (getWeChatTheme(themeId).kind === 'template') {
      return createTemplateThemeDocument(snapshot, themeId);
    }
    return this.themeDocument?.themeId === themeId
      && this.themeDocument.sourceHash === snapshot.themeSourceHash
      ? this.themeDocument
      : null;
  }

  private themeNeedsGeneration(snapshot: WeChatPreviewSnapshot): boolean {
    return getWeChatTheme(this.currentThemeId()).kind !== 'template'
      && !this.validThemeDocument(snapshot);
  }

  private applySnapshotMetadata(
    snapshot: WeChatPreviewSnapshot,
    previous: WeChatPreviewSnapshot | null,
  ): void {
    if (previous && previous.sourcePath === snapshot.sourcePath) {
      if (snapshot.title !== previous.title) this.titleValue = snapshot.title;
      if (snapshot.author !== previous.author) this.authorValue = snapshot.author;
      if (snapshot.digest !== previous.digest) this.digestValue = snapshot.digest;
    } else {
      this.titleValue = snapshot.title;
      this.authorValue = snapshot.author;
      this.digestValue = snapshot.digest;
    }
  }

  private scheduleSaveMetadata(): void {
    if (this.metadataSaveTimer !== null) window.clearTimeout(this.metadataSaveTimer);
    this.metadataSaveTimer = window.setTimeout(() => {
      this.metadataSaveTimer = null;
      void this.savePublishingMetadata();
    }, 600);
  }

  private flushSaveMetadata(): void {
    if (this.metadataSaveTimer === null) return;
    window.clearTimeout(this.metadataSaveTimer);
    this.metadataSaveTimer = null;
    void this.savePublishingMetadata();
  }

  private async savePublishingMetadata(): Promise<void> {
    if (!this.file || !this.snapshot) return;
    const title = this.titleValue.trim();
    const author = this.authorValue.trim();
    const digest = this.digestValue.trim();
    const frontmatter = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    const currentTitle = typeof frontmatter?.title === 'string' ? frontmatter.title.trim() : '';
    const currentAuthor = typeof frontmatter?.author === 'string' ? frontmatter.author.trim() : '';
    const currentDigest = typeof frontmatter?.digest === 'string' ? frontmatter.digest.trim() : '';
    if (
      title === currentTitle
      && author === currentAuthor
      && digest === currentDigest
    ) return;
    await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
      if (title) fm.title = title;
      else delete fm.title;
      if (author) fm.author = author;
      else delete fm.author;
      if (digest) fm.digest = digest;
      else delete fm.digest;
    });
  }

  private warmUpCodexRuntime(): void {
    const settings = this.options.getSettings();
    if (settings.defaultAgentId !== 'codex') return;
    if (settings.configSources.codex !== 'localCli') return;
    void this.options.runtimeManager.refreshCodexStatus().catch(() => undefined);
  }

  private async refreshPreview(): Promise<void> {
    await this.reload();
    if (!this.snapshot) return;
    const themeId = this.currentThemeId();
    const theme = getWeChatTheme(themeId);
    if (theme.kind !== 'template') {
      if (theme.kind === 'custom' && !this.customThemePreferences().description) {
        await this.configureCustomTheme();
      } else {
        await this.generateTheme(themeId, true);
      }
    }
  }

  private async selectTheme(themeId: WeChatThemeId): Promise<void> {
    this.closeThemeMenus();
    if (!this.snapshot) return;
    if (getWeChatTheme(themeId).kind === 'skill') {
      await this.generateTheme(themeId, false);
      return;
    }
    const settings = this.options.getSettings();
    this.pendingThemeId = null;
    this.pendingCustomTheme = null;
    settings.wechatThemeId = themeId;
    this.themeDocument = createTemplateThemeDocument(this.preparedSnapshot(), themeId);
    await this.options.saveSettings();
    this.render();
  }

  private customThemePreferences(): WeChatCustomThemePreferences {
    const settings = this.options.getSettings();
    return {
      name: settings.wechatCustomThemeName.trim(),
      description: settings.wechatCustomThemeDescription.trim(),
    };
  }

  private async configureCustomTheme(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    const preferences = await promptForCustomWeChatTheme(this.app, this.customThemePreferences());
    if (!preferences) return;
    await this.generateTheme('ai-custom', true, preferences);
  }

  private async generateTheme(
    themeId: WeChatThemeId,
    force: boolean,
    customTheme?: WeChatCustomThemePreferences,
  ): Promise<void> {
    if (!this.snapshot || this.operation) return;
    const theme = getWeChatTheme(themeId);
    const themeLabel = customTheme?.name || theme.label;
    const snapshot = this.preparedSnapshot();
    const previousDocument = this.themeDocument;
    const settings = this.options.getSettings();
    const previousThemeId = settings.wechatThemeId;
    const previousCustomTheme = this.customThemePreferences();
    const generationId = ++this.themeGenerationId;
    const controller = new AbortController();
    let generated = false;
    const previousPreviewScrollTop = this.currentPreviewScrollTop();
    this.themeGenerationController = controller;
    this.themeGenerationStopping = false;
    this.pendingThemeId = themeId;
    this.pendingCustomTheme = customTheme ?? null;
    this.streamingThemeHtml = '';
    this.streamingPreviewAutoFollow.start();
    this.themeGenerationError = null;
    this.activeTab = 'preview';
    this.operation = `正在读取 ${themeLabel} 主题组件…`;
    this.render();
    try {
      const document = await this.options.themeService.generate(snapshot, themeId, {
        force,
        customTheme,
        signal: controller.signal,
        onProgress: progress => {
          if (generationId !== this.themeGenerationId) return;
          this.operation = progress.label;
          this.updateThemeGenerationStatus(progress.label);
        },
        onPreview: html => {
          if (generationId === this.themeGenerationId) this.queueStreamingThemePreview(html);
        },
      });
      if (generationId !== this.themeGenerationId || controller.signal.aborted) return;
      settings.wechatThemeId = themeId;
      if (customTheme) {
        settings.wechatCustomThemeName = customTheme.name;
        settings.wechatCustomThemeDescription = customTheme.description;
      }
      this.themeDocument = document;
      await this.options.saveSettings();
      generated = true;
      new Notice(`${themeLabel} 主题已生成。`);
    } catch (error) {
      if (generationId !== this.themeGenerationId) return;
      settings.wechatThemeId = previousThemeId;
      settings.wechatCustomThemeName = previousCustomTheme.name;
      settings.wechatCustomThemeDescription = previousCustomTheme.description;
      this.themeDocument = previousDocument;
      const cancelled = controller.signal.aborted || error instanceof ThemeGenerationCancelledError;
      if (cancelled) {
        new Notice('已停止主题生成，已恢复上一次预览。');
      } else {
        const message = error instanceof Error ? error.message : `${themeLabel} 主题生成失败`;
        this.themeGenerationError = message;
        new Notice(message);
      }
    } finally {
      if (generationId === this.themeGenerationId) {
        this.pendingPreviewScrollRestore = generated
          ? this.captureStreamingPreviewScroll()
          : { top: previousPreviewScrollTop, followBottom: false };
        this.clearStreamingPreviewTimer();
        this.resetStreamingPreviewAutoFollow();
        this.themeGenerationController = null;
        this.themeGenerationStopping = false;
        this.pendingThemeId = null;
        this.pendingCustomTheme = null;
        this.streamingThemeHtml = null;
        this.streamingPreviewIframe = null;
        this.operation = null;
        this.render();
      }
    }
  }

  private stopThemeGeneration(): void {
    if (!this.themeGenerationController || this.themeGenerationStopping) return;
    this.themeGenerationStopping = true;
    this.operation = '正在停止主题生成…';
    this.themeGenerationController.abort();
    this.render();
  }

  private invalidateThemeGeneration(): void {
    const controller = this.themeGenerationController;
    this.pendingPreviewScrollRestore = null;
    if (!controller && this.streamingPreviewTimer === null) {
      this.resetStreamingPreviewAutoFollow();
      return;
    }
    this.themeGenerationId += 1;
    controller?.abort();
    this.clearStreamingPreviewTimer();
    this.resetStreamingPreviewAutoFollow();
    this.themeGenerationController = null;
    this.themeGenerationStopping = false;
    this.pendingThemeId = null;
    this.pendingCustomTheme = null;
    this.streamingThemeHtml = null;
    this.streamingPreviewIframe = null;
    this.operation = null;
  }

  private queueStreamingThemePreview(html: string): void {
    this.streamingThemeHtml = html;
    if (this.streamingPreviewTimer !== null) return;
    const elapsed = Date.now() - this.lastStreamingPreviewAt;
    this.streamingPreviewTimer = window.setTimeout(() => {
      this.streamingPreviewTimer = null;
      this.lastStreamingPreviewAt = Date.now();
      if (this.snapshot && this.streamingPreviewIframe && this.streamingThemeHtml !== null) {
        renderStreamingWeChatThemePreview(
          this.preparedSnapshot(),
          this.streamingPreviewIframe,
          this.streamingThemeHtml,
          {
            onResize: () => {
              if (this.streamingPreviewScrollEl) {
                this.scheduleStreamingPreviewAutoScroll(this.streamingPreviewScrollEl);
              }
            },
            onUserScrollUp: () => this.pauseStreamingPreviewAutoFollow(),
            onUserWheel: deltaY => {
              if (this.streamingPreviewScrollEl) {
                this.forwardStreamingPreviewWheel(this.streamingPreviewScrollEl, deltaY);
              }
            },
          },
        );
      }
    }, Math.max(0, 100 - elapsed));
  }

  private clearStreamingPreviewTimer(): void {
    if (this.streamingPreviewTimer !== null) window.clearTimeout(this.streamingPreviewTimer);
    this.streamingPreviewTimer = null;
  }

  private bindStreamingPreviewAutoFollow(viewport: HTMLElement): void {
    this.streamingPreviewScrollEl = viewport;
    this.lastStreamingPreviewScrollTop = viewport.scrollTop;
    viewport.addEventListener('wheel', (event) => {
      if (
        event.deltaY < 0
        && viewport.scrollTop > 0
        && this.streamingPreviewAutoFollow.pause()
      ) {
        this.updateStreamingPreviewFollowButton();
      }
    }, { passive: true });
    viewport.addEventListener('touchstart', (event) => {
      this.streamingPreviewTouchY = event.touches[0]?.clientY ?? null;
    }, { passive: true });
    viewport.addEventListener('touchmove', (event) => {
      const currentY = event.touches[0]?.clientY;
      if (currentY === undefined || this.streamingPreviewTouchY === null) return;
      if (currentY - this.streamingPreviewTouchY > 6 && this.streamingPreviewAutoFollow.pause()) {
        this.updateStreamingPreviewFollowButton();
      }
      this.streamingPreviewTouchY = currentY;
    }, { passive: true });
    viewport.addEventListener('mousedown', (event) => {
      const bounds = viewport.getBoundingClientRect();
      this.streamingPreviewScrollbarDragging = event.clientX >= bounds.right - 18;
      if (!this.streamingPreviewScrollbarDragging) return;
      document.addEventListener('mouseup', () => {
        this.streamingPreviewScrollbarDragging = false;
      }, { once: true });
    });
    viewport.addEventListener('scroll', () => {
      const movedUp = viewport.scrollTop < this.lastStreamingPreviewScrollTop - 1;
      this.lastStreamingPreviewScrollTop = viewport.scrollTop;
      const userInitiated = this.streamingPreviewScrollbarDragging || movedUp;
      if (this.streamingPreviewAutoFollow.observeScroll(viewport, userInitiated)) {
        this.updateStreamingPreviewFollowButton();
      }
    }, { passive: true });
  }

  private pauseStreamingPreviewAutoFollow(): void {
    if (this.streamingPreviewAutoFollow.pause()) {
      this.updateStreamingPreviewFollowButton();
    }
  }

  private scheduleStreamingPreviewAutoScroll(viewport: HTMLElement): void {
    if (
      viewport !== this.streamingPreviewScrollEl
      || !viewport.isConnected
      || !this.streamingPreviewAutoFollow.isFollowing
    ) return;
    if (this.streamingPreviewScrollFrame !== null) return;
    this.streamingPreviewScrollFrame = window.requestAnimationFrame(() => {
      this.streamingPreviewScrollFrame = null;
      if (
        viewport !== this.streamingPreviewScrollEl
        || !viewport.isConnected
        || !this.streamingPreviewAutoFollow.isFollowing
      ) return;
      viewport.scrollTop = viewport.scrollHeight;
      this.lastStreamingPreviewScrollTop = viewport.scrollTop;
    });
  }

  private forwardStreamingPreviewWheel(viewport: HTMLElement, deltaY: number): void {
    if (viewport !== this.streamingPreviewScrollEl || !viewport.isConnected) return;
    viewport.scrollTop += deltaY;
    this.lastStreamingPreviewScrollTop = viewport.scrollTop;
  }

  private updateStreamingPreviewFollowButton(): void {
    this.contentEl.querySelector('.wesight-wechat-preview-follow')?.remove();
    if (!this.themeGenerationController || !this.streamingPreviewAutoFollow.isPaused) return;
    const button = this.contentEl.createEl('button', {
      cls: 'wesight-wechat-preview-follow',
      attr: { type: 'button', 'aria-label': '继续跟随最新生成内容' },
    });
    const icon = button.createSpan();
    setIcon(icon, 'arrow-down');
    button.createSpan({ text: '继续跟随' });
    button.onclick = () => {
      this.streamingPreviewAutoFollow.resume();
      this.updateStreamingPreviewFollowButton();
      if (this.streamingPreviewScrollEl) {
        this.scheduleStreamingPreviewAutoScroll(this.streamingPreviewScrollEl);
      }
    };
  }

  private resetStreamingPreviewAutoFollow(): void {
    this.streamingPreviewAutoFollow.stop();
    if (this.streamingPreviewScrollFrame !== null) {
      window.cancelAnimationFrame(this.streamingPreviewScrollFrame);
    }
    this.streamingPreviewScrollFrame = null;
    this.streamingPreviewScrollEl = null;
    this.streamingPreviewTouchY = null;
    this.streamingPreviewScrollbarDragging = false;
    this.lastStreamingPreviewScrollTop = 0;
    this.contentEl.querySelector('.wesight-wechat-preview-follow')?.remove();
  }

  private updateThemeGenerationStatus(label: string): void {
    const status = this.contentEl.querySelector('.wesight-wechat-publish-state > span:last-child');
    if (status) status.textContent = label;
  }

  private currentPreviewScrollTop(): number {
    return this.contentEl.querySelector<HTMLElement>('.wesight-wechat-preview-canvas-wrap')?.scrollTop ?? 0;
  }

  private captureStreamingPreviewScroll(): { top: number; followBottom: boolean } {
    return {
      top: this.streamingPreviewScrollEl?.scrollTop ?? 0,
      followBottom: this.streamingPreviewAutoFollow.isFollowing,
    };
  }

  private restorePreviewScroll(viewport: HTMLElement): void {
    const pending = this.pendingPreviewScrollRestore;
    if (!pending) return;
    window.requestAnimationFrame(() => {
      if (!viewport.isConnected || this.streamingThemeHtml !== null) return;
      viewport.scrollTop = pending.followBottom
        ? viewport.scrollHeight
        : Math.min(pending.top, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
      if (this.pendingPreviewScrollRestore === pending) this.pendingPreviewScrollRestore = null;
    });
  }

  private preparedSnapshot(): WeChatPreviewSnapshot {
    if (!this.snapshot) throw new Error('公众号预览尚未生成');
    return withWeChatSnapshotMetadata(this.snapshot, {
      title: this.titleValue,
      author: this.authorValue,
      digest: this.digestValue,
    });
  }

  private async publish(asNew: boolean): Promise<void> {
    if (!this.file || !this.snapshot || !this.connection) return;
    const snapshot = this.preparedSnapshot();
    const themeDocument = this.validThemeDocument(snapshot);
    const theme = getWeChatTheme(this.currentThemeId());
    if (theme.kind !== 'template' && !themeDocument) {
      new Notice(`请先重新生成 ${this.currentThemeLabel()} 主题预览。`);
      return;
    }
    if (!snapshot.title.trim()) {
      new Notice('请填写文章标题。');
      return;
    }
    const existing = !asNew && !this.duplicatePath && !this.staleDraft ? this.draft : null;
    let billing;
    try {
      billing = await this.options.auth.refreshBillingSummary(false);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : '无法加载积分余额，请稍后重试');
      return;
    }
    if (billing.totalCreditsRemaining < billing.publishCost) {
      openBillingModal(this.app, this.options.auth, billing);
      return;
    }
    const confirmed = await confirmShareAction(this.app, {
      title: existing ? '更新公众号草稿？' : '发文章到公众号草稿箱？',
      message: existing
        ? '当前排版、正文图片和封面将覆盖已关联的公众号草稿。'
        : '当前笔记、正文图片和封面将作为公众号草稿发布。',
      confirmText: existing ? '确认更新' : '确认发文章',
    });
    if (!confirmed) return;
    const publishSignature = [
      existing?.id || 'new',
      snapshot.contentHash,
      themeDocument?.contentHash || '',
      snapshot.title,
    ].join(':');
    if (this.publishAttempt?.signature !== publishSignature) {
      this.publishAttempt = {
        signature: publishSignature,
        idempotencyKey: crypto.randomUUID(),
      };
    }
    const publishIdempotencyKey = this.publishAttempt.idempotencyKey;

    this.operation = '正在上传正文图片…';
    this.error = null;
    this.errorTitle = '同步草稿失败';
    this.render();
    const hidden = document.body.createDiv({ cls: 'wesight-wechat-publish-render-host' });
    try {
      const uploadedUrls = await this.uploadContentImages(snapshot);

      this.operation = `正在生成 ${this.currentThemeLabel()} 正文…`;
      this.render();
      const article = hidden.createDiv();
      await renderWeChatArticle(this.app, this, snapshot, article, {
        uploadedUrls,
        themeDocument,
        templateTheme: this.currentTemplateTheme(),
      });
      await replaceFormulaSvgs(article, async (asset) => {
        this.operation = '正在上传公式图片…';
        this.render();
        const result = await this.options.api.uploadAsset('content', asset);
        if (!result.url) throw new Error('公式图片上传失败');
        return result.url;
      }, theme.kind === 'template');
      const content = serializeWeChatArticle(article);
      const thumbMediaId = await this.resolveCoverMediaId(snapshot);
      const payload: WeChatDraftPayload = {
        title: snapshot.title,
        ...(snapshot.author ? { author: snapshot.author } : {}),
        ...(snapshot.digest ? { digest: snapshot.digest } : {}),
        content,
        contentHash: themeDocument?.contentHash ?? snapshot.contentHash,
        thumbMediaId,
        ...(snapshot.contentSourceUrl ? { contentSourceUrl: snapshot.contentSourceUrl } : {}),
        ...(snapshot.needOpenComment === undefined
          ? {}
          : { needOpenComment: snapshot.needOpenComment }),
        ...(snapshot.onlyFansCanComment === undefined
          ? {}
          : { onlyFansCanComment: snapshot.onlyFansCanComment }),
      };

      this.operation = existing ? '正在更新公众号草稿…' : '正在创建公众号草稿…';
      this.render();
      const draft = existing
        ? await this.options.api.updateDraft(existing.id, payload, publishIdempotencyKey)
        : await this.options.api.createDraft(payload, publishIdempotencyKey);
      await this.writePublishState(draft);
      this.draft = draft;
      this.staleDraft = false;
      this.duplicatePath = null;
      this.publishAttempt = null;
      void this.options.auth.refreshBillingSummary().catch(() => undefined);
      new Notice(existing ? '公众号草稿已更新。' : '笔记已同步到公众号草稿箱。');
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 402) {
        const latest = await this.options.auth.refreshBillingSummary(false).catch(() => null);
        if (latest) openBillingModal(this.app, this.options.auth, latest);
      }
      this.error = error instanceof Error ? error.message : '公众号草稿同步失败';
      new Notice(this.error);
    } finally {
      hidden.remove();
      this.operation = null;
      this.render();
    }
  }

  private async resolveCoverMediaId(snapshot: WeChatPreviewSnapshot): Promise<string> {
    if (this.temporaryCover) {
      const result = await this.options.api.uploadAsset('cover', this.temporaryCover);
      if (result.mediaId) return result.mediaId;
    }
    if (snapshot.thumbMediaId) return snapshot.thumbMediaId;
    const selected = snapshot.coverAssetToken
      ? snapshot.assets.find((asset) => asset.token === snapshot.coverAssetToken)
      : snapshot.assets[0];
    if (selected) {
      this.operation = '正在上传文章封面…';
      this.render();
      const result = await this.options.api.uploadAsset('cover', selected);
      if (result.mediaId) return result.mediaId;
    }
    if (this.connection?.defaultCoverMediaId) return this.connection.defaultCoverMediaId;
    throw new Error('文章没有可用封面，请选择封面或在发布平台设置默认封面');
  }

  private async writePublishState(draft: WeChatDraftState): Promise<void> {
    if (!this.file) return;
    await this.app.fileManager.processFrontMatter(this.file, (frontmatter: Record<string, unknown>) => {
      writeWeChatDraftFrontmatter(frontmatter, {
        draftId: draft.id,
        contentHash: draft.contentHash,
        updatedAt: draft.updatedAt,
      });
    });
  }


  private async uploadContentImages(
    snapshot: WeChatPreviewSnapshot,
  ): Promise<Map<string, string>> {
    const uploadedUrls = new Map<string, string>();
    const contentAssets = snapshot.assets.filter((asset) => snapshot.markdown.includes(asset.token));
    for (let index = 0; index < contentAssets.length; index += 1) {
      const asset = contentAssets[index];
      this.operation = `正在上传正文图片 ${index + 1}/${contentAssets.length}…`;
      this.render();
      try {
        const result = await this.options.api.uploadAsset('content', asset);
        if (!result.url) throw new Error('上传后没有返回地址');
        uploadedUrls.set(asset.token, result.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        throw new Error(
          `正文图片 ${index + 1}/${contentAssets.length}“${asset.fileName}”上传失败：${message}`,
        );
      }
    }
    return uploadedUrls;
  }

  private async copyToClipboard(): Promise<void> {
    if (!this.file || !this.snapshot || !this.connection) return;
    if (Platform.isMobile) {
      new Notice('移动端暂不支持复制公众号文章格式。');
      return;
    }
    const snapshot = this.preparedSnapshot();
    const themeDocument = this.validThemeDocument(snapshot);
    const theme = getWeChatTheme(this.currentThemeId());
    if (theme.kind !== 'template' && !themeDocument) {
      new Notice(`请先重新生成 ${this.currentThemeLabel()} 主题预览。`);
      return;
    }
    if (!snapshot.title.trim()) {
      new Notice('请填写文章标题。');
      return;
    }

    this.operation = '正在准备复制…';
    this.error = null;
    this.errorTitle = '复制失败';
    this.render();
    const hidden = document.body.createDiv({ cls: 'wesight-wechat-publish-render-host' });
    try {
      const uploadedUrls = await this.uploadContentImages(snapshot);

       this.operation = `正在生成 ${this.currentThemeLabel()} 正文…`;
      this.render();
      const article = hidden.createDiv();
      await renderWeChatArticle(this.app, this, snapshot, article, {
        uploadedUrls,
        themeDocument,
        templateTheme: this.currentTemplateTheme(),
      });
      await replaceFormulaSvgs(article, async (asset) => {
        this.operation = '正在上传公式图片…';
        this.render();
        const result = await this.options.api.uploadAsset('content', asset);
        if (!result.url) throw new Error('公式图片上传失败');
        return result.url;
      }, theme.kind === 'template');
      const content = serializeWeChatArticle(article);
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([content], { type: 'text/html' }),
      })]);
      new Notice('已复制公众号文章格式，请前往后台粘贴。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '复制公众号文章格式失败';
      new Notice(this.error);
    } finally {
      hidden.remove();
      this.operation = null;
      this.render();
    }
  }

  private findDuplicatePath(draftId: string): string | null {
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === this.file?.path) continue;
      const value = recordValue(
        this.app.metadataCache.getFileCache(candidate)?.frontmatter,
        WECHAT_DRAFT_ID_FRONTMATTER_KEY,
      );
      if (value === draftId) return candidate.path;
    }
    return null;
  }

  private coverPreviewSource(snapshot: WeChatPreviewSnapshot): string | null {
    if (this.temporaryCover?.previewUrl) return this.temporaryCover.previewUrl;
    if (snapshot.coverAssetToken) {
      return snapshot.assets.find((asset) => asset.token === snapshot.coverAssetToken)?.previewUrl || null;
    }
    return snapshot.assets[0]?.previewUrl || null;
  }

  private coverDescription(snapshot: WeChatPreviewSnapshot): string {
    if (this.temporaryCover) return '本次临时选择的封面';
    if (snapshot.thumbMediaId) return '使用 Frontmatter 封面素材 ID';
    if (snapshot.coverAssetToken) return '使用 Frontmatter 指定封面';
    if (snapshot.assets.length) return '自动使用正文首图';
    if (this.connection?.defaultCoverMediaId) return '使用公众号默认封面';
    return '尚未选择封面';
  }

  private chooseTemporaryCover(): void {
    const input = createEl('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.arrayBuffer().then((body) => {
        this.clearTemporaryCover();
        this.temporaryCover = {
          token: '',
          source: file.name,
          fileName: file.name,
          mimeType: file.type,
          contentHash: '',
          body,
          previewUrl: URL.createObjectURL(file),
        };
        this.render();
      });
    };
    input.click();
  }

  private clearTemporaryCover(): void {
    if (this.temporaryCover?.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(this.temporaryCover.previewUrl);
    }
    this.temporaryCover = null;
  }
}
