import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  setIcon,
  TFile,
  type ViewStateResult,
  WorkspaceLeaf,
} from 'obsidian';

import { CloudAuthService } from '../share/cloudAuth';
import { CloudApiError } from '../share/cloudApi';
import { WeChatCloudApi } from '../wechat/cloudApi';
import { WeChatThemeService } from '../wechat/themeService';
import {
  WECHAT_CONTENT_HASH_FRONTMATTER_KEY,
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  WECHAT_PUBLISHED_AT_FRONTMATTER_KEY,
  parseWeChatPublishState,
} from '../wechat/frontmatter';
import {
  renderWeChatArticle,
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
  type WeChatThemeDocument,
  type WeChatThemeId,
  type WeChatThemeKind,
} from '../wechat/themes';
import { recordValue } from '../utils/records';
import { confirmShareAction } from './shareConfirm';

export const WESIGHT_WECHAT_PREVIEW_VIEW_TYPE = 'wesight-wechat-preview';

type WeChatPreviewTab = 'preview' | 'settings';

interface WeChatPreviewViewOptions {
  auth: CloudAuthService;
  api: WeChatCloudApi;
  themeService: WeChatThemeService;
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
  private activeTab: WeChatPreviewTab = 'preview';
  private themeDocument: WeChatThemeDocument | null = null;
  private themeMenuEl: HTMLElement | null = null;
  private themeSubmenuEl: HTMLElement | null = null;
  private themeMenuHideTimer: number | null = null;

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
        void this.reload();
      }, 450);
    }));
    if (!this.file) {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active) this.file = active;
    }
    await this.reload();
  }

  override async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
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
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    if (file instanceof TFile) this.file = file;
    this.activeTab = state.activeTab === 'settings' ? 'settings' : 'preview';
    await super.setState(state, result);
    if (this.contentEl.isConnected) await this.reload();
  }

  async setFile(file: TFile): Promise<void> {
    if (this.file?.path === file.path && this.snapshot) return;
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
    this.loading = true;
    this.error = null;
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
      this.snapshot = await buildWeChatSnapshot(this.app, this.file);
      this.titleValue = this.snapshot.title;
      this.authorValue = this.snapshot.author;
      this.digestValue = this.snapshot.digest;
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
    const identity = header.createDiv({ cls: 'wesight-wechat-preview-identity' });
    identity.createEl('strong', { text: '公众号预览' });
    if (this.connection) {
      const account = identity.createDiv({ cls: 'wesight-wechat-preview-account-chip' });
      account.createSpan({
        cls: 'wesight-wechat-preview-avatar',
        text: (this.connection.displayName || '微').slice(-1),
      });
      account.createSpan({ text: this.connection.displayName || '微信公众号' });
    } else {
      identity.createSpan({
        cls: 'wesight-wechat-preview-note-name',
        text: this.file?.basename ?? '当前笔记',
      });
    }
    const actions = header.createDiv({ cls: 'wesight-wechat-preview-header-actions' });
    const refresh = header.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': '刷新公众号排版' },
    });
    actions.appendChild(refresh);
    setIcon(refresh, 'refresh-cw');
    refresh.disabled = this.loading || Boolean(this.operation);
    refresh.onclick = () => void this.refreshPreview();
  }

  private renderLogin(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'wesight-wechat-preview-empty' });
    empty.createEl('h3', { text: '登录 WeSight' });
    empty.createEl('p', { text: '登录后即可连接公众号并同步后台草稿箱。' });
    const button = empty.createEl('button', {
      cls: 'mod-cta',
      text: '登录 WeSight',
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

    const prepared = this.preparedSnapshot();
    if (this.themeNeedsGeneration(prepared)) {
      this.renderBanner(
        parent,
        'sparkles',
        `${getWeChatTheme(this.currentThemeId()).label} 主题待重新生成，当前暂时显示 Canghe Style 预览。`,
      );
    }

    if (this.activeTab === 'settings') {
      this.renderPublishingSettings(parent, snapshot);
      return;
    }

    this.renderPreviewSummary(parent, snapshot);

    const canvasWrap = parent.createDiv({ cls: 'wesight-wechat-preview-canvas-wrap' });
    const canvas = canvasWrap.createDiv({ cls: 'wesight-wechat-preview-canvas' });
    const article = canvas.createDiv({ cls: 'wesight-wechat-preview-article' });
    void renderWeChatArticle(this.app, this, prepared, article, {
      themeDocument: this.validThemeDocument(prepared),
    }).catch((error) => {
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
      text: '预览',
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(this.activeTab === 'preview'),
      },
    });
    preview.onclick = () => {
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
    const primary = toolbar.createEl('button', {
      cls: 'mod-cta wesight-wechat-publish-button',
      text: updateExisting ? '更新公众号草稿' : '同步到草稿箱',
      attr: { type: 'button' },
    });
    primary.disabled = Boolean(this.operation)
      || unchanged
      || themeNeedsGeneration
      || (hasBlockingWarnings && !this.acknowledgedWarnings);
    primary.onclick = () => void this.publish(false);

    const currentTheme = getWeChatTheme(this.currentThemeId());
    const themeTrigger = toolbar.createEl('button', {
      cls: 'wesight-wechat-theme-trigger',
      attr: {
        type: 'button',
        'aria-label': `选择公众号主题，当前为 ${currentTheme.label}`,
        'aria-haspopup': 'menu',
        'aria-expanded': String(Boolean(this.themeMenuEl)),
      },
    });
    themeTrigger.createSpan({
      cls: 'wesight-wechat-theme-trigger-label',
      text: `主题 · ${currentTheme.label}`,
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
      state.createSpan({ text: '准备同步到草稿箱' });
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
      cls: 'wesight-wechat-theme-menu-item has-submenu is-ai',
      attr: { role: 'menuitem', tabindex: '0' },
    });
    const aiIcon = ai.createSpan({ cls: 'wesight-wechat-theme-menu-icon' });
    setIcon(aiIcon, 'sparkles');
    ai.createSpan({ text: 'AI自定义主题' });
    const aiArrow = ai.createSpan({ cls: 'wesight-wechat-theme-menu-arrow' });
    setIcon(aiArrow, 'chevron-right');
    const showComingSoon = (aiEvent: Event): void => {
      aiEvent.stopPropagation();
      this.closeThemeMenus();
      new Notice('AI自定义主题即将支持。');
    };
    ai.onclick = showComingSoon;
    ai.onkeydown = aiEvent => {
      if (aiEvent.key === 'Enter' || aiEvent.key === ' ') showComingSoon(aiEvent);
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
      if (theme.id === 'canghe-style') {
        item.createSpan({ cls: 'wesight-wechat-theme-option-note', text: '默认' });
      }
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
    const title = fields.createEl('label');
    title.createSpan({ text: '标题' });
    const titleInput = title.createEl('input', { type: 'text' });
    titleInput.value = this.titleValue;
    titleInput.maxLength = 128;
    titleInput.oninput = () => {
      this.titleValue = titleInput.value;
    };
    titleInput.onblur = () => this.render();
    const author = fields.createEl('label');
    author.createSpan({ text: '作者' });
    const authorInput = author.createEl('input', { type: 'text' });
    authorInput.value = this.authorValue;
    authorInput.maxLength = 64;
    authorInput.oninput = () => {
      this.authorValue = authorInput.value;
    };
    authorInput.onblur = () => this.render();
    const digest = fields.createEl('label', { cls: 'is-wide' });
    digest.createSpan({ text: '摘要' });
    const digestInput = digest.createEl('textarea');
    digestInput.value = this.digestValue;
    digestInput.maxLength = 600;
    digestInput.rows = 2;
    digestInput.oninput = () => {
      this.digestValue = digestInput.value;
    };
    digestInput.onblur = () => this.render();
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
    return this.options.getSettings().wechatThemeId;
  }

  private loadCachedThemeDocument(snapshot: WeChatPreviewSnapshot): void {
    const themeId = this.currentThemeId();
    this.themeDocument = getWeChatTheme(themeId).kind === 'template'
      ? createTemplateThemeDocument(snapshot)
      : this.options.themeService.getCached(snapshot, themeId);
  }

  private validThemeDocument(snapshot: WeChatPreviewSnapshot): WeChatThemeDocument | null {
    const themeId = this.currentThemeId();
    if (getWeChatTheme(themeId).kind === 'template') {
      return createTemplateThemeDocument(snapshot);
    }
    return this.themeDocument?.themeId === themeId
      && this.themeDocument.sourceHash === snapshot.contentHash
      ? this.themeDocument
      : null;
  }

  private themeNeedsGeneration(snapshot: WeChatPreviewSnapshot): boolean {
    return getWeChatTheme(this.currentThemeId()).kind === 'skill'
      && !this.validThemeDocument(snapshot);
  }

  private async refreshPreview(): Promise<void> {
    await this.reload();
    if (!this.snapshot) return;
    const themeId = this.currentThemeId();
    if (getWeChatTheme(themeId).kind === 'skill' && this.themeNeedsGeneration(this.preparedSnapshot())) {
      await this.generateSkillTheme(themeId, true);
    }
  }

  private async selectTheme(themeId: WeChatThemeId): Promise<void> {
    this.closeThemeMenus();
    if (!this.snapshot) return;
    if (getWeChatTheme(themeId).kind === 'skill') {
      await this.generateSkillTheme(themeId, false);
      return;
    }
    const settings = this.options.getSettings();
    settings.wechatThemeId = themeId;
    this.themeDocument = createTemplateThemeDocument(this.preparedSnapshot());
    await this.options.saveSettings();
    this.render();
  }

  private async generateSkillTheme(themeId: WeChatThemeId, force: boolean): Promise<void> {
    if (!this.snapshot || this.operation) return;
    const theme = getWeChatTheme(themeId);
    const snapshot = this.preparedSnapshot();
    const previousThemeId = this.currentThemeId();
    const previousDocument = this.themeDocument;
    this.operation = `正在生成 ${theme.label} 主题…`;
    this.render();
    try {
      const document = await this.options.themeService.generate(snapshot, themeId, {
        force,
        onProgress: progress => {
          this.operation = progress.label;
          this.render();
        },
      });
      const settings = this.options.getSettings();
      settings.wechatThemeId = themeId;
      this.themeDocument = document;
      await this.options.saveSettings();
      this.activeTab = 'preview';
      new Notice(`${theme.label} 主题已生成。`);
    } catch (error) {
      this.options.getSettings().wechatThemeId = previousThemeId;
      this.themeDocument = previousDocument;
      new Notice(error instanceof Error ? error.message : `${theme.label} 主题生成失败`);
    } finally {
      this.operation = null;
      this.render();
    }
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
    if (theme.kind === 'skill' && !themeDocument) {
      new Notice(`请先重新生成 ${theme.label} 主题预览。`);
      return;
    }
    if (!snapshot.title.trim()) {
      new Notice('请填写文章标题。');
      return;
    }
    const existing = !asNew && !this.duplicatePath && !this.staleDraft ? this.draft : null;
    const confirmed = await confirmShareAction(this.app, {
      title: existing ? '更新公众号草稿？' : '同步到公众号草稿箱？',
      message: existing
        ? '当前排版、正文图片和封面将覆盖已关联的公众号草稿。'
        : '当前笔记、正文图片和封面将上传到微信公众号后台草稿箱。',
      confirmText: existing ? '确认更新' : '确认同步',
    });
    if (!confirmed) return;

    this.operation = '正在上传正文图片…';
    this.error = null;
    this.errorTitle = '同步草稿失败';
    this.render();
    const hidden = document.body.createDiv({ cls: 'wesight-wechat-publish-render-host' });
    try {
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

      this.operation = `正在生成 ${theme.label} 正文…`;
      this.render();
      const article = hidden.createDiv();
      await renderWeChatArticle(this.app, this, snapshot, article, {
        uploadedUrls,
        themeDocument,
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
        ? await this.options.api.updateDraft(existing.id, payload)
        : await this.options.api.createDraft(payload);
      await this.writePublishState(draft);
      this.draft = draft;
      this.staleDraft = false;
      this.duplicatePath = null;
      new Notice(existing ? '公众号草稿已更新。' : '笔记已同步到公众号草稿箱。');
    } catch (error) {
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
      frontmatter[WECHAT_DRAFT_ID_FRONTMATTER_KEY] = draft.id;
      frontmatter[WECHAT_CONTENT_HASH_FRONTMATTER_KEY] = draft.contentHash;
      frontmatter[WECHAT_PUBLISHED_AT_FRONTMATTER_KEY] = draft.updatedAt;
    });
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
