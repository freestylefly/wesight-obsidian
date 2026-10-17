import {
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  setIcon,
  TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';

import wesightLogo from '../../assets/wesight-logo.png';
import typographyThumbnail from '../../assets/xiaohongshu/category-typography.png';
import photographyThumbnail from '../../assets/xiaohongshu/category-photography.png';
import collageThumbnail from '../../assets/xiaohongshu/category-collage.png';
import illustrationThumbnail from '../../assets/xiaohongshu/category-illustration.png';
import infographicThumbnail from '../../assets/xiaohongshu/category-infographic.png';
import screenshotThumbnail from '../../assets/xiaohongshu/category-screenshot.png';
import {
  MULTI_PUBLISH_LOGIN_PROMPT,
  resolveMultiPublishAccess,
  validateMultiPublishTargetCount,
} from '../multiPublish/access';
import { DYNAMIC_COMPOSE_CAPABILITY, type MultiPublishBridge } from '../multiPublish/bridge';
import { requireBrowserConnection } from '../multiPublish/connection';
import { buildMultiPublishSnapshot } from '../multiPublish/snapshot';
import type { MultiPlatformTaskState, MultiPublishSnapshot, MultiPublishTaskState } from '../multiPublish/types';
import type { CloudAuthService } from '../share/cloudAuth';
import { hasActiveMembership, requireMemberFeature } from './memberFeatureGate';
import type { VaultStore } from '../storage/vaultStore';
import type { WeSightObsidianSettings } from '../types';
import type { WeiboPostDraftStore } from '../weiboPost/store';
import type { WeiboPostImage } from '../weiboPost/types';
import type { JikePostDraftStore } from '../jikePost/store';
import type { JikePostImage } from '../jikePost/types';
import { buildXPostText, normalizeXPostTopics, validateXPostCopy, xPostWeightedLength, X_POST_TEXT_LIMIT } from '../xPost/copy';
import { buildXPostPublishSnapshot, selectXPostImages } from '../xPost/publish';
import type { XPostCopyDraft } from '../xPost/types';
import {
  hasExplicitQuickTransformPlatformSelection,
  QUICK_TRANSFORM_PLATFORM_IDS,
  recommendQuickTransformImageIds,
  reconcileQuickTransformImageIds,
  restoreQuickTransformPlatformIds,
  type QuickTransformPlatformId,
} from '../quickTransform/selection';
import {
  quickTransformSourceImages,
  readSnapshotAssetReference,
} from '../quickTransform/images';
import {
  buildQuickPublishBatchSnapshot,
  isQuickPublishTaskReady,
  QUICK_PUBLISH_CAPABILITY,
  type QuickPublishSnapshotMap,
} from '../quickTransform/publish';
import {
  parseQuickTopics,
  sharedCopyRequirement,
  sharedCopyToJike,
  sharedCopyToWeibo,
  type QuickTransformCopyMode,
} from '../quickTransform/copy';
import {
  WeiboPostWorkbench,
  type ContentWorkbenchSection,
} from './weiboPostWorkbench';
import { JikePostWorkbench } from './jikePostWorkbench';
import {
  buildXhsPostText,
  clampXhsTitle,
  createInitialXhsCopy,
  createDefaultXhsPageContents,
  normalizeXhsTags,
  reconcileXhsPageContents,
  XHS_PAGE_TEXT_LIMIT,
  XHS_BODY_LIMIT,
  XHS_TITLE_LIMIT,
} from '../xiaohongshu/copy';
import type {
  XiaohongshuGenerationService,
  XhsImageGenerationProgress,
} from '../xiaohongshu/generationService';
import { recommendXhsVisualStyle } from '../xiaohongshu/recommendation';
import {
  buildXiaohongshuPublishSnapshot,
  validateXiaohongshuPublishInput,
} from '../xiaohongshu/publish';
import type { XiaohongshuDraftStore } from '../xiaohongshu/store';
import {
  buildXhsTypographyPageInput,
  getXhsTypographyTemplate,
  renderXhsTypographyTemplate,
} from '../xiaohongshu/typographyTemplates';
import {
  XHS_CATEGORIES,
  getXhsCategory,
  getXhsStyle,
  type XhsCopyDraft,
  type XhsDraftRecord,
  type XhsGeneratedPage,
  type XhsImageRatio,
  type XhsImageReference,
  type XhsPageContent,
  type XhsPageContentSource,
  type XhsStyleChoice,
  type XhsStyleRecommendation,
  type XhsVisualCategoryId,
} from '../xiaohongshu/types';

export const WESIGHT_XIAOHONGSHU_VIEW_TYPE = 'wesight-xiaohongshu-workbench';

type XhsWorkbenchSection = ContentWorkbenchSection;
type DetailPlatformId = Exclude<QuickTransformPlatformId, 'x-post'>;
type ContentPlatformId = 'quick' | DetailPlatformId;

interface QuickTransformImage {
  id: string;
  vaultPath: string;
  fileName: string;
  mimeType: string;
  label: string;
  source: 'article' | 'generated';
  size?: number;
  previewUrl?: string;
}

const QUICK_PLATFORM_COPY: Record<QuickTransformPlatformId, { label: string; icon: string }> = {
  xiaohongshu: { label: '小红书', icon: 'notebook-pen' },
  'weibo-post': { label: '微博', icon: 'radio-tower' },
  'jike-post': { label: '即刻', icon: 'circle-dot' },
  'x-post': { label: 'X', icon: 'send' },
};

const CATEGORY_THUMBNAILS: Record<XhsVisualCategoryId, string> = {
  typography: typographyThumbnail,
  photography: photographyThumbnail,
  collage: collageThumbnail,
  illustration: illustrationThumbnail,
  infographic: infographicThumbnail,
  screenshot: screenshotThumbnail,
};

const XHS_PUBLISH_STATUS: Record<MultiPlatformTaskState['status'], string> = {
  queued: '等待浏览器扩展',
  opening: '正在打开小红书',
  login_required: '需要登录小红书',
  filling: '正在上传图片并填充文案',
  ready: '内容已准备，请检查后发布',
  failed: '发布准备失败',
  cancelled: '任务已取消',
};

export interface XiaohongshuWorkbenchViewOptions {
  getSettings: () => WeSightObsidianSettings;
  auth: CloudAuthService;
  bridge: MultiPublishBridge;
  generationService: XiaohongshuGenerationService;
  draftStore: XiaohongshuDraftStore;
  weiboPostDraftStore: WeiboPostDraftStore;
  jikePostDraftStore: JikePostDraftStore;
  vaultStore: VaultStore;
  openSettings: () => void;
  openBrowserConnector: () => void;
}

export class XiaohongshuWorkbenchView extends ItemView {
  private file: TFile | null = null;
  private snapshot: MultiPublishSnapshot | null = null;
  private copy: XhsCopyDraft = { title: '', body: '', tags: [] };
  private recommendation: XhsStyleRecommendation | null = null;
  private style: XhsStyleChoice = { categoryId: 'typography', styleId: 'minimal' };
  private activePlatform: ContentPlatformId = 'quick';
  private activeSection: XhsWorkbenchSection = 'copy';
  private quickTargets = new Set<QuickTransformPlatformId>();
  private quickTargetsExplicit = false;
  private quickMembershipNotice = false;
  private quickMembershipReturnPending = false;
  private quickCopyMode: QuickTransformCopyMode = 'platform';
  private quickXPostCopy: XPostCopyDraft = { body: '', topics: [] };
  private quickPreviewPlatform: QuickTransformPlatformId = 'xiaohongshu';
  private quickPlatformStatus: Partial<Record<QuickTransformPlatformId, 'generating' | 'ready' | 'failed'>> = {};
  private quickSelectedImageIds: string[] = [];
  private quickRecommendedImageIds = new Set<string>();
  private quickStateSourcePath = '';
  private quickOperation = false;
  private quickCompleted = 0;
  private quickErrors: Partial<Record<QuickTransformPlatformId | 'general', string>> = {};
  private quickPublishTask: MultiPublishTaskState | null = null;
  private quickPublishBusy = false;
  private customStylePrompt = '';
  private imageRatio: XhsImageRatio = '3:4';
  private imageReferences: XhsImageReference[] = [];
  private aiSettingsOpen = false;
  private aiPendingPages = new Set<number>();
  private aiGalleryScrollLeft = 0;
  private copyRequirement = '';
  private pageCount = 6;
  private pageContents: XhsPageContent[] = [];
  private generatedPages: XhsGeneratedPage[] = [];
  private selectedPreviewPage = 0;
  private loading = false;
  private operation: 'copy' | 'pageContents' | 'pageContent' | 'images' | null = null;
  private recommendationRunning = false;
  private recommendationNote = '';
  private error = '';
  private publishTask: MultiPublishTaskState | null = null;
  private publishBusy = false;
  private publishAuthLoading = false;
  private publishLoginPending = false;
  private imageProgress: XhsImageGenerationProgress | null = null;
  private memberAccessEpoch = 0;
  private fileSwitchRequestId = 0;
  private fileSwitchTimer: number | null = null;
  private requestId = 0;
  private refreshTimer: number | null = null;
  private saveTimer: number | null = null;
  private generationController: AbortController | null = null;
  private recommendationController: AbortController | null = null;
  private lastActiveMarkdownFile: TFile | null = null;
  private readonly styleListScrollTops = new Map<XhsVisualCategoryId, number>();
  private readonly quickImageScrollLeft = new Map<string, number>();
  private readonly weiboPostWorkbench: WeiboPostWorkbench;
  private readonly jikePostWorkbench: JikePostWorkbench;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly options: XiaohongshuWorkbenchViewOptions,
  ) {
    super(leaf);
    this.weiboPostWorkbench = new WeiboPostWorkbench({
      app: this.app,
      getSettings: this.options.getSettings,
      auth: this.options.auth,
      bridge: this.options.bridge,
      generationService: this.options.generationService,
      draftStore: this.options.weiboPostDraftStore,
      vaultStore: this.options.vaultStore,
      getXiaohongshuImages: () => this.generatedPages,
      openBrowserConnector: this.options.openBrowserConnector,
      showSection: section => this.showSection(section),
      requestRender: () => this.render(),
    });
    this.jikePostWorkbench = new JikePostWorkbench({
      app: this.app,
      getSettings: this.options.getSettings,
      auth: this.options.auth,
      bridge: this.options.bridge,
      generationService: this.options.generationService,
      draftStore: this.options.jikePostDraftStore,
      vaultStore: this.options.vaultStore,
      getXiaohongshuImages: () => this.generatedPages,
      openSettings: this.options.openSettings,
      openBrowserConnector: this.options.openBrowserConnector,
      showSection: section => this.showSection(section),
      requestRender: () => this.render(),
    });
  }

  override getViewType(): string {
    return WESIGHT_XIAOHONGSHU_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return '图文动态';
  }

  override getIcon(): string {
    return 'notebook-pen';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.addClass('wesight-xhs-view-container');
    this.register(this.options.auth.onChange(() => {
      this.publishLoginPending = false;
      if (!this.options.auth.getCurrentUser() || this.options.auth.getBillingSummary()?.membership.active) {
        this.quickMembershipNotice = false;
      }
      if (this.options.auth.getCurrentUser() && this.options.auth.getBillingSummary()) {
        this.reconcileQuickTargetAccess();
      }
      this.weiboPostWorkbench.onAuthChange();
      this.jikePostWorkbench.onAuthChange();
      this.render();
    }));
    this.registerDomEvent(window, 'focus', () => {
      if (!this.quickMembershipReturnPending) return;
      this.quickMembershipReturnPending = false;
      void this.options.auth.refreshBillingSummary(false).catch(() => {
        new Notice('暂时无法刷新会员状态，请稍后重试。');
      });
    });
    this.register(this.options.bridge.onChange(() => {
      if (this.quickPublishTask) {
        this.quickPublishTask = this.options.bridge.getTask(this.quickPublishTask.taskId) ?? this.quickPublishTask;
      }
      if (this.publishTask) {
        this.publishTask = this.options.bridge.getTask(this.publishTask.taskId) ?? this.publishTask;
      }
      this.weiboPostWorkbench.onBridgeChange();
      this.jikePostWorkbench.onBridgeChange();
      this.render();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (this.fileSwitchTimer !== null) window.clearTimeout(this.fileSwitchTimer);
      this.fileSwitchTimer = window.setTimeout(() => {
        this.fileSwitchTimer = null;
        const file = leaf?.view instanceof MarkdownView ? leaf.view.file : null;
        if (file?.extension !== 'md') return;
        this.lastActiveMarkdownFile = file;
        void this.setFile(file);
      }, 0);
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.extension !== 'md') return;
      if (this.fileSwitchTimer !== null) window.clearTimeout(this.fileSwitchTimer);
      this.fileSwitchTimer = null;
      this.lastActiveMarkdownFile = file;
      void this.setFile(file);
    }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!(file instanceof TFile) || file.path !== this.file?.path) return;
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.loadFile(file, true);
      }, 500);
    }));

    const active = this.resolveActiveMarkdownFile() ?? this.lastActiveMarkdownFile;
    if (active) {
      this.lastActiveMarkdownFile = active;
      await this.setFile(active);
    } else {
      this.render();
    }
    void this.refreshPublishAuth();
  }

  override async onClose(): Promise<void> {
    this.memberAccessEpoch += 1;
    this.fileSwitchRequestId += 1;
    this.requestId += 1;
    this.generationController?.abort();
    this.recommendationController?.abort();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.fileSwitchTimer !== null) window.clearTimeout(this.fileSwitchTimer);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.refreshTimer = null;
    this.fileSwitchTimer = null;
    this.saveTimer = null;
    this.weiboPostWorkbench.dispose();
    this.jikePostWorkbench.dispose();
    await this.saveDraft();
    await this.weiboPostWorkbench.save();
    await this.jikePostWorkbench.save();
  }

  override getState(): Record<string, unknown> {
    return {
      filePath: this.file?.path ?? null,
      activeSection: this.activeSection,
      activePlatform: this.activePlatform,
    };
  }

  override async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const savedFile = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    const file = this.resolveActiveMarkdownFile()
      ?? (savedFile instanceof TFile ? this.markdownFile(savedFile) : null);
    if (file) this.file = file;
    this.activeSection = state.activeSection === 'images' || state.activeSection === 'review'
      ? state.activeSection
      : 'copy';
    this.activePlatform = state.activePlatform === 'xiaohongshu'
      || state.activePlatform === 'weibo-post'
      || state.activePlatform === 'jike-post'
      ? state.activePlatform
      : 'quick';
    await super.setState(state, result);
    if (this.contentEl.isConnected && this.file) await this.loadFile(this.file);
  }

  async setFile(file: TFile): Promise<void> {
    if (file.extension !== 'md') return;
    const switchRequestId = ++this.fileSwitchRequestId;
    if (this.file?.path === file.path && this.snapshot?.sourcePath === file.path) return;
    await this.saveDraft();
    await this.weiboPostWorkbench.save();
    await this.jikePostWorkbench.save();
    if (switchRequestId !== this.fileSwitchRequestId) return;
    this.file = file;
    this.activeSection = 'copy';
    this.pageContents = [];
    this.generatedPages = [];
    this.quickSelectedImageIds = [];
    this.quickRecommendedImageIds.clear();
    this.quickTargets.clear();
    this.quickTargetsExplicit = false;
    this.quickMembershipNotice = false;
    this.quickCopyMode = 'platform';
    this.quickXPostCopy = { body: '', topics: [] };
    this.quickPreviewPlatform = 'xiaohongshu';
    this.quickPlatformStatus = {};
    this.quickImageScrollLeft.clear();
    this.quickStateSourcePath = '';
    this.quickErrors = {};
    this.quickCompleted = 0;
    this.quickPublishTask = null;
    this.quickPublishBusy = false;
    this.publishTask = null;
    this.selectedPreviewPage = 0;
    this.weiboPostWorkbench.reset();
    this.jikePostWorkbench.reset();
    await this.loadFile(file);
  }

  async showQuick(file: TFile): Promise<void> {
    await this.setFile(file);
    this.activePlatform = 'quick';
    this.activeSection = 'copy';
    this.contentEl.scrollTop = 0;
    this.render();
  }

  private markdownFile(file: TFile | null): TFile | null {
    return file?.extension === 'md' ? file : null;
  }

  private resolveActiveMarkdownFile(): TFile | null {
    let visibleRootFile: TFile | null = null;
    this.app.workspace.iterateRootLeaves(leaf => {
      if (
        !visibleRootFile
        && leaf.view instanceof MarkdownView
        && leaf.view.containerEl.isShown()
      ) visibleRootFile = leaf.view.file;
    });
    const activeEditorFile = this.app.workspace.activeEditor?.file ?? null;
    const recentRootLeaf = this.app.workspace.getMostRecentLeaf();
    const recentRootFile = recentRootLeaf?.view instanceof MarkdownView
      ? recentRootLeaf.view.file
      : null;
    return this.markdownFile(visibleRootFile)
      ?? this.markdownFile(activeEditorFile)
      ?? this.markdownFile(recentRootFile)
      ?? this.markdownFile(this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null)
      ?? this.markdownFile(this.app.workspace.getActiveFile());
  }

  private async loadFile(file: TFile, preserveEdits = false): Promise<void> {
    const requestId = ++this.requestId;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const snapshot = await buildMultiPublishSnapshot(this.app, file);
      if (requestId !== this.requestId || this.file?.path !== file.path) return;
      const saved = await this.options.draftStore.load(snapshot.contentHash);
      if (requestId !== this.requestId || this.file?.path !== file.path) return;
      const savedPageContentsAreUnified = Boolean(
        saved?.pageContents?.length
        && saved.pageContents.every(page => typeof (page as unknown as Record<string, unknown>).text === 'string'),
      );
      this.snapshot = snapshot;
      await this.weiboPostWorkbench.load(snapshot, preserveEdits);
      await this.jikePostWorkbench.load(snapshot, preserveEdits);
      if (requestId !== this.requestId || this.file?.path !== file.path) return;
      const localRecommendation = recommendXhsVisualStyle(snapshot.markdown);
      if (!preserveEdits || !this.copy.title) {
        this.copy = saved?.copy ?? createInitialXhsCopy(snapshot);
        this.recommendation = saved?.recommendation ?? localRecommendation;
        this.style = saved?.style ?? {
          categoryId: localRecommendation.categoryId,
          styleId: localRecommendation.styleId,
        };
        this.customStylePrompt = saved?.customStylePrompt ?? '';
        this.imageRatio = saved?.imageRatio ?? '3:4';
        this.imageReferences = saved?.imageReferences ?? [];
        this.aiGalleryScrollLeft = 0;
        this.pageCount = saved?.pageCount ?? 6;
        this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, saved?.pageContents);
        this.generatedPages = savedPageContentsAreUnified ? saved?.pages ?? [] : [];
      } else {
        this.recommendation = localRecommendation;
        this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
      }
      this.initializeQuickState(saved);
      this.selectedPreviewPage = Math.min(this.selectedPreviewPage, Math.max(0, this.pageCount - 1));
      this.loading = false;
      this.render();
      if (!saved?.pageContents || !savedPageContentsAreUnified) void this.saveDraft();
      if (!saved || saved.recommendation.source !== 'engine') void this.refineRecommendation(true);
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.loading = false;
      this.error = error instanceof Error ? error.message : '小红书工作台加载失败';
      this.render();
    }
  }

  private async requireMembership(feature: string): Promise<boolean> {
    const epoch = this.memberAccessEpoch;
    const allowed = await requireMemberFeature(this.app, this.options.auth, feature);
    return allowed && epoch === this.memberAccessEpoch;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wesight-xhs-workbench');
    this.renderHeader(contentEl);
    if (!hasActiveMembership(this.options.auth)) {
      const card = contentEl.createDiv({ cls: 'wesight-quick-membership-notice' });
      const copy = card.createDiv({ cls: 'wesight-quick-membership-copy' });
      copy.createEl('strong', { text: '转为图文，会员专享' });
      copy.createEl('p', { text: '开通或续费会员后，即可生成图文并发布到多个平台。' });
      const actions = card.createDiv({ cls: 'wesight-quick-membership-actions' });
      const button = actions.createEl('button', {
        cls: 'mod-cta', text: '去充值会员', attr: { type: 'button' },
      });
      button.onclick = () => {
        void this.requireMembership('转为图文').then(allowed => {
          if (allowed) this.render();
        });
      };
      return;
    }
    if (this.activePlatform !== 'quick') this.renderWorkflow(contentEl);

    const body = contentEl.createDiv({ cls: 'wesight-xhs-body' });
    if (this.loading) {
      this.renderStatus(body, 'loader-circle', '正在读取左侧文章…', true);
      return;
    }
    if (!this.file || !this.snapshot) {
      this.renderStatus(body, 'file-text', this.error || '请先在左侧打开一篇 Markdown 文章');
      return;
    }
    if (this.activePlatform === 'quick') {
      this.renderQuickTransform(body);
      return;
    }
    if (this.activePlatform === 'weibo-post') {
      this.weiboPostWorkbench.render(body, this.activeSection);
      return;
    }
    if (this.activePlatform === 'jike-post') {
      this.jikePostWorkbench.render(body, this.activeSection);
      return;
    }
    if (this.error) this.renderError(body);
    if (this.activeSection === 'copy') this.renderCopySection(body);
    if (this.activeSection === 'images') this.renderImagesSection(body);
    if (this.activeSection === 'review') this.renderReviewSection(body);
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'wesight-xhs-header' });
    const brand = header.createDiv({ cls: 'wesight-xhs-brand' });
    brand.createEl('img', { attr: { src: wesightLogo, alt: 'WeSight' } });
    const copy = brand.createDiv({ cls: 'wesight-xhs-brand-copy' });
    copy.createEl('strong', { text: 'WeSight · 图文动态' });
    if (this.file?.basename) header.setAttribute('title', `当前文章：${this.file.basename}`);

    const actions = copy.createDiv({ cls: 'wesight-xhs-header-actions' });
    const platforms: Array<{ id: ContentPlatformId; label: string; icon: string }> = [
      { id: 'quick', label: '快速转', icon: 'zap' },
      { id: 'xiaohongshu', label: '小红书', icon: 'notebook-pen' },
      { id: 'weibo-post', label: '微博', icon: 'radio-tower' },
      { id: 'jike-post', label: '即刻', icon: 'circle-dot' },
    ];
    for (const platform of platforms) {
      const button = actions.createEl('button', {
        cls: `wesight-xhs-platform-badge${this.activePlatform === platform.id ? ' is-active' : ''}`,
        attr: {
          type: 'button',
          'aria-pressed': String(this.activePlatform === platform.id),
          'aria-label': `切换到${platform.label}`,
        },
      });
      const icon = button.createSpan();
      setIcon(icon, platform.icon);
      button.createSpan({ text: platform.label });
      button.onclick = () => this.switchPlatform(platform.id);
    }
    const addPlatform = actions.createEl('button', {
      cls: 'wesight-xhs-platform-badge',
      text: 'X',
      attr: { type: 'button', 'aria-label': 'X 图文动态' },
    });
    const addIcon = addPlatform.createSpan();
    setIcon(addIcon, 'send');
    addPlatform.prepend(addIcon);
    addPlatform.onclick = () => {
      if (!this.quickTargets.has('x-post')) this.toggleQuickTarget('x-post');
      this.openQuickPlatform('x-post');
    };
  }

  private renderWorkflow(parent: HTMLElement): void {
    const nav = parent.createDiv({ cls: 'wesight-xhs-workflow' });
    const sections: Array<{ id: XhsWorkbenchSection; label: string }> = [
      { id: 'copy', label: '文案' },
      { id: 'images', label: this.activePlatform === 'xiaohongshu' ? '图片' : '配图' },
      { id: 'review', label: '检查' },
    ];
    sections.forEach((section, index) => {
      const button = nav.createEl('button', {
        cls: `wesight-xhs-workflow-step${this.activeSection === section.id ? ' is-active' : ''}`,
        attr: { type: 'button', 'aria-current': this.activeSection === section.id ? 'step' : 'false' },
      });
      button.createSpan({ cls: 'wesight-xhs-step-number', text: String(index + 1) });
      button.createSpan({ text: section.label });
      button.onclick = () => this.showSection(section.id);
    });
  }

  private renderQuickTransform(parent: HTMLElement): void {
    const articleImages = this.quickArticleImages();
    const generatedImages = this.quickGeneratedImages();
    const allImages = [...articleImages, ...generatedImages];
    this.quickSelectedImageIds = reconcileQuickTransformImageIds(
      this.quickSelectedImageIds,
      allImages,
    );

    if (this.quickErrors.general) this.renderQuickError(parent, this.quickErrors.general);

    const heading = parent.createDiv({ cls: 'wesight-quick-heading' });
    const headingCopy = heading.createDiv();
    headingCopy.createEl('strong', { text: '快速转为图文' });
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(), this.options.auth.getBillingSummary(),
    );
    headingCopy.createSpan({
      text: `${this.quickTargets.size ? `已选择 ${this.quickTargets.size} 个平台` : '请选择发布平台'} · 图片和文案均可继续调整`,
    });
    const engine = heading.createEl('button', {
      cls: 'wesight-quick-engine',
      attr: { type: 'button', title: '打开设置更换生成引擎' },
    });
    engine.createSpan({ text: '当前引擎' });
    engine.createEl('strong', { text: engineLabel(this.options.getSettings().defaultAgentId) });
    const engineIcon = engine.createSpan();
    setIcon(engineIcon, 'chevron-down');
    engine.onclick = () => this.options.openSettings();

    const platformBar = parent.createDiv({ cls: 'wesight-quick-platform-bar' });
    platformBar.createSpan({ text: '生成平台' });
    const platformList = platformBar.createDiv({ cls: 'wesight-quick-platform-list' });
    for (const platformId of QUICK_TRANSFORM_PLATFORM_IDS) {
      const selected = this.quickTargets.has(platformId);
      const platform = QUICK_PLATFORM_COPY[platformId];
      const button = platformList.createEl('button', {
        cls: selected ? 'is-selected' : '',
        attr: {
          type: 'button',
          'aria-pressed': String(selected),
          'aria-label': `${selected ? '取消' : '选择'}${platform.label}`,
        },
      });
      const icon = button.createSpan();
      setIcon(icon, platform.icon);
      button.createSpan({ text: platform.label });
      button.onclick = () => this.toggleQuickTarget(platformId);
    }

    if (this.quickMembershipNotice && access.state === 'single-platform') {
      this.renderQuickMembershipNotice(parent);
    }

    this.renderQuickCopyMode(parent);
    this.renderQuickCopyPreview(parent);

    const imageHeading = parent.createDiv({ cls: 'wesight-quick-section-heading' });
    const imageHeadingCopy = imageHeading.createDiv();
    imageHeadingCopy.createEl('strong', { text: '文章图片' });
    imageHeadingCopy.createSpan({
      text: `共 ${articleImages.length} 张 · 已选 ${this.quickSelectedImageIds.length} 张`,
    });
    const recommendation = imageHeading.createDiv({ cls: 'wesight-quick-recommendation' });
    const recommendationIcon = recommendation.createSpan();
    setIcon(recommendationIcon, 'circle-check');
    recommendation.createSpan({ text: `智能推荐 ${this.quickRecommendedImageIds.size} 张` });
    const clear = imageHeading.createEl('button', {
      cls: 'wesight-quick-clear',
      text: '清空',
      attr: { type: 'button' },
    });
    clear.disabled = this.quickOperation || this.quickSelectedImageIds.length === 0;
    clear.onclick = () => {
      this.quickSelectedImageIds = [];
      this.quickErrors = {};
      this.quickCompleted = 0;
      this.clearQuickPublishTask();
      this.scheduleDraftSave();
      this.render();
    };

    if (articleImages.length) {
      this.renderQuickImageCarousel(parent, articleImages, 'article');
    } else {
      const empty = parent.createDiv({ cls: 'wesight-quick-empty' });
      const icon = empty.createSpan();
      setIcon(icon, 'image-off');
      empty.createSpan({ text: '原文中没有可用图片，可通过下方入口补充。' });
    }

    if (generatedImages.length) {
      const generatedHeading = parent.createDiv({ cls: 'wesight-quick-section-heading is-generated' });
      const generatedCopy = generatedHeading.createDiv();
      generatedCopy.createEl('strong', { text: '生成图片' });
      generatedCopy.createSpan({ text: `${generatedImages.length} 张 · 生成完成后会自动加入选择` });
      this.renderQuickImageCarousel(parent, generatedImages, 'generated');
    }

    const supplement = parent.createDiv({ cls: 'wesight-quick-supplement' });
    supplement.createEl('strong', { text: '还需要补充图片？' });
    const supplementActions = supplement.createDiv();
    const generateImage = supplementActions.createEl('button', {
      attr: { type: 'button' },
    });
    const generateImageIcon = generateImage.createSpan();
    setIcon(generateImageIcon, 'sparkles');
    generateImage.createSpan({ text: 'AI 生成图片' });
    generateImage.disabled = this.quickOperation;
    generateImage.onclick = () => this.openQuickImageStudio(false);
    const typography = supplementActions.createEl('button', {
      attr: { type: 'button' },
    });
    const typographyIcon = typography.createSpan();
    setIcon(typographyIcon, 'type');
    typography.createSpan({ text: '文字配图' });
    typography.disabled = this.quickOperation;
    typography.onclick = () => this.openQuickImageStudio(true);
    const supplementNote = supplement.createDiv({ cls: 'wesight-quick-supplement-note' });
    const noteIcon = supplementNote.createSpan();
    setIcon(noteIcon, 'info');
    supplementNote.createSpan({ text: '生成后的图片会自动加入已选列表' });

    const footer = parent.createDiv({ cls: 'wesight-quick-footer' });
    const status = footer.createDiv({ cls: 'wesight-quick-footer-status' });
    const generated = this.quickGenerationReady();
    const previousPublishReady = isQuickPublishTaskReady(this.quickPublishTask);
    const connection = this.options.bridge.getConnectionState();
    const extensionNeedsUpdate = connection.connected && (
      connection.supportedPlatforms !== null
        && Array.from(this.quickTargets).some(platformId => !connection.supportedPlatforms!.includes(platformId))
      || connection.capabilities !== null
        && [QUICK_PUBLISH_CAPABILITY, 'compose-v1', DYNAMIC_COMPOSE_CAPABILITY]
          .some(capability => !connection.capabilities!.includes(capability))
    );
    if (this.quickPublishBusy) {
      status.createEl('strong', { text: '正在打开动态发布中心' });
      status.createSpan({ text: `正在带入 ${this.quickTargets.size} 套平台文案和图片` });
    } else if (this.quickPublishTask) {
      const states = this.quickPublishTask.targets.map(platformId => this.quickPublishTask!.platforms[platformId]);
      const readyCount = states.filter(state => state.status === 'ready').length;
      const failedCount = states.filter(state => state.status === 'failed').length;
      const loginCount = states.filter(state => state.status === 'login_required').length;
      status.createEl('strong', { text: readyCount
        ? `${readyCount} 个平台等待检查`
        : `已交给动态发布中心 · ${states.length} 套平台文案` });
      status.createSpan({
        text: failedCount
          ? `${failedCount} 个失败，进入对应平台后可重试`
          : loginCount ? `${loginCount} 个平台需要登录` : '可在浏览器中继续编辑、选择平台并同步',
      });
    } else if (extensionNeedsUpdate && generated) {
      status.createEl('strong', { text: '发布助手版本过旧' });
      status.createSpan({ text: '请更新并重新加载浏览器扩展后继续' });
    } else if (this.quickOperation) {
      status.createEl('strong', { text: `正在生成 ${this.quickCompleted}/${this.quickTargets.size}` });
      const progress = status.createEl('progress', {
        attr: { max: String(Math.max(1, this.quickTargets.size)), value: String(this.quickCompleted) },
      });
      progress.value = this.quickCompleted;
    } else if (this.quickErrorSummary()) {
      status.createEl('strong', { text: '部分平台生成失败，可直接重试' });
      status.createSpan({ text: this.quickErrorSummary() });
    } else if (this.quickCompleted > 0) {
      status.createEl('strong', {
        text: this.quickCopyMode === 'shared'
          ? `统一文案已同步到 ${this.quickCompleted} 个平台`
          : `已生成 ${this.quickCompleted} 套平台文案`,
      });
      status.createSpan({ text: '点击后进入浏览器动态发布中心，继续编辑并选择同步平台' });
    } else {
      status.createSpan({
        text: this.quickCopyMode === 'shared'
          ? `将生成 1 套统一文案，复用当前 ${this.quickSelectedImageIds.length} 张图片`
          : `将生成 ${this.quickTargets.size} 套平台文案，复用当前 ${this.quickSelectedImageIds.length} 张图片`,
      });
    }
    const generate = footer.createEl('button', {
      cls: 'wesight-xhs-primary-button wesight-quick-generate',
      text: this.quickPublishBusy
        ? '正在打开动态发布中心…'
        : this.quickPublishTask
          ? previousPublishReady
            ? '重新发送到动态发布中心'
            : '打开动态发布中心'
          : this.quickOperation
            ? `正在生成 ${this.quickCompleted}/${this.quickTargets.size}`
            : generated
              ? `一键发布到 ${this.quickTargets.size} 个平台`
              : `一键生成 ${this.quickTargets.size} 个平台`,
      attr: { type: 'button' },
    });
    const generateIcon = generate.createSpan();
    setIcon(generateIcon, this.quickOperation || this.quickPublishBusy
      ? 'loader-circle'
      : this.quickPublishTask
        ? previousPublishReady ? 'refresh-cw' : 'external-link'
        : 'send');
    generate.prepend(generateIcon);
    generate.disabled = this.quickOperation
      || this.quickPublishBusy
      || this.quickTargets.size === 0
      || this.quickSelectedImageIds.length === 0
      || (generated && extensionNeedsUpdate);
    generate.onclick = () => {
      if (previousPublishReady) void this.startQuickPublish(false);
      else if (this.quickPublishTask) void this.openQuickPublishTask();
      else if (generated) void this.startQuickPublish(false);
      else void this.generateQuickTransform();
    };
  }

  private renderQuickCopyMode(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'wesight-quick-copy-mode' });
    row.createSpan({ text: '文案模式' });
    const control = row.createDiv({ cls: 'wesight-quick-copy-mode-control' });
    const modes: Array<{ id: QuickTransformCopyMode; label: string }> = [
      { id: 'shared', label: '统一文案' },
      { id: 'platform', label: '不同文案' },
    ];
    for (const mode of modes) {
      const button = control.createEl('button', {
        cls: this.quickCopyMode === mode.id ? 'is-selected' : '',
        text: mode.label,
        attr: {
          type: 'button',
          'aria-pressed': String(this.quickCopyMode === mode.id),
        },
      });
      button.disabled = this.quickOperation;
      button.onclick = () => this.setQuickCopyMode(mode.id);
    }
    row.createSpan({
      cls: 'wesight-quick-copy-mode-note',
      text: this.quickCopyMode === 'shared'
        ? this.quickTargets.has('x-post') ? '统一生成后可单独调整；X 另生成 280 字符以内的精简文案' : '统一生成后，各平台仍可单独调整'
        : '按平台风格分别生成，可在下方快速检查',
    });
  }

  private renderQuickImageCarousel(
    parent: HTMLElement,
    images: QuickTransformImage[],
    key: 'article' | 'generated',
  ): void {
    const carousel = parent.createDiv({ cls: 'wesight-quick-image-carousel' });
    const previous = carousel.createEl('button', {
      cls: 'wesight-quick-carousel-arrow is-previous',
      attr: { type: 'button', 'aria-label': '查看前面的图片' },
    });
    setIcon(previous, 'chevron-left');
    const viewport = carousel.createDiv({ cls: 'wesight-quick-image-viewport' });
    const grid = viewport.createDiv({ cls: 'wesight-quick-image-grid' });
    for (const image of images) {
      const selectedIndex = this.quickSelectedImageIds.indexOf(image.id);
      const selected = selectedIndex >= 0;
      const card = grid.createEl('button', {
        cls: `wesight-quick-image${selected ? ' is-selected' : ''}`,
        attr: {
          type: 'button',
          'aria-pressed': String(selected),
          title: selected ? '点击取消选择，拖拽可调整顺序' : `选择${image.label}`,
        },
      });
      card.draggable = selected && !this.quickOperation;
      card.dataset.quickImageId = image.id;
      card.createEl('img', {
        attr: { src: this.imageResourceUrl(image), alt: image.label },
      });
      const marker = card.createSpan({ cls: 'wesight-quick-image-marker' });
      if (selected) {
        marker.setText(String(selectedIndex + 1));
      } else {
        setIcon(marker, 'circle');
      }
      const check = card.createSpan({ cls: 'wesight-quick-image-check' });
      setIcon(check, selected ? 'check' : 'circle');
      if (this.quickRecommendedImageIds.has(image.id)) {
        card.createSpan({ cls: 'wesight-quick-image-recommended', text: '推荐' });
      } else if (image.source === 'generated') {
        card.createSpan({ cls: 'wesight-quick-image-recommended is-generated', text: '生成' });
      }
      card.disabled = this.quickOperation;
      card.onclick = () => {
        this.quickImageScrollLeft.set(key, grid.scrollLeft);
        this.toggleQuickImage(image.id);
      };
      card.ondragstart = event => {
        event.dataTransfer?.setData('text/x-wesight-quick-image', image.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      card.ondragover = event => {
        if (!selected) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      };
      card.ondrop = event => {
        event.preventDefault();
        const sourceId = event.dataTransfer?.getData('text/x-wesight-quick-image') ?? '';
        this.moveQuickImage(sourceId, image.id);
      };
    }
    const next = carousel.createEl('button', {
      cls: 'wesight-quick-carousel-arrow is-next',
      attr: { type: 'button', 'aria-label': '查看更多图片' },
    });
    setIcon(next, 'chevron-right');
    const counter = carousel.createSpan({ cls: 'wesight-quick-carousel-counter' });
    const savedScrollLeft = this.quickImageScrollLeft.get(key) ?? 0;
    let restoringScroll = savedScrollLeft > 0;

    const update = (): void => {
      if (!grid.isConnected) return;
      const firstCard = grid.querySelector<HTMLElement>('.wesight-quick-image');
      const gap = 10;
      const itemWidth = (firstCard?.offsetWidth ?? 1) + gap;
      const first = Math.min(images.length - 1, Math.max(0, Math.round(grid.scrollLeft / itemWidth)));
      const visible = Math.max(1, Math.floor((grid.clientWidth + gap) / itemWidth));
      const last = Math.min(images.length, first + visible);
      counter.setText(`${first + 1}–${last} / ${images.length}`);
      previous.disabled = grid.scrollLeft <= 1;
      next.disabled = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 1;
      if (!restoringScroll) this.quickImageScrollLeft.set(key, grid.scrollLeft);
    };
    const scrollAmount = (): number => Math.max(120, grid.clientWidth * 0.82);
    previous.onclick = () => grid.scrollBy({ left: -scrollAmount(), behavior: 'smooth' });
    next.onclick = () => grid.scrollBy({ left: scrollAmount(), behavior: 'smooth' });
    grid.addEventListener('scroll', update, { passive: true });
    window.requestAnimationFrame(() => {
      if (!grid.isConnected) return;
      grid.addClass('is-restoring-scroll');
      grid.scrollLeft = savedScrollLeft;
      update();
      window.requestAnimationFrame(() => {
        if (!grid.isConnected) return;
        grid.removeClass('is-restoring-scroll');
        restoringScroll = false;
        update();
      });
    });
  }

  private renderQuickCopyPreview(parent: HTMLElement): void {
    const targets = QUICK_TRANSFORM_PLATFORM_IDS.filter(platformId => this.quickTargets.has(platformId));
    if (!targets.length) return;
    if (!this.quickTargets.has(this.quickPreviewPlatform)) this.quickPreviewPlatform = targets[0];
    const platform = QUICK_PLATFORM_COPY[this.quickPreviewPlatform];
    const section = parent.createDiv({ cls: 'wesight-quick-copy-preview' });
    const heading = section.createDiv({ cls: 'wesight-quick-copy-preview-heading' });
    heading.createEl('strong', { text: '平台文案' });
    const detail = heading.createEl('button', {
      text: `前往${platform.label}细调`,
      attr: { type: 'button' },
    });
    const detailIcon = detail.createSpan();
    setIcon(detailIcon, 'arrow-right');
    detail.append(detailIcon);
    detail.onclick = () => this.openQuickPlatform(this.quickPreviewPlatform);

    const tabs = section.createDiv({ cls: 'wesight-quick-copy-tabs' });
    for (const platformId of targets) {
      const item = QUICK_PLATFORM_COPY[platformId];
      const state = this.quickPlatformStatus[platformId];
      const button = tabs.createEl('button', {
        cls: this.quickPreviewPlatform === platformId ? 'is-selected' : '',
        attr: {
          type: 'button',
          'aria-pressed': String(this.quickPreviewPlatform === platformId),
        },
      });
      const icon = button.createSpan();
      setIcon(icon, item.icon);
      button.createSpan({ text: item.label });
      const status = button.createSpan({ cls: `wesight-quick-copy-tab-status is-${state ?? 'pending'}` });
      setIcon(status, state === 'failed' ? 'circle-alert' : state === 'generating' ? 'loader-circle' : 'circle-check');
      button.onclick = () => {
        this.quickPreviewPlatform = platformId;
        this.render();
      };
    }

    const editor = section.createDiv({ cls: 'wesight-quick-copy-editor' });
    this.renderQuickCopyFields(editor, this.quickPreviewPlatform);
    editor.createSpan({
      cls: 'wesight-quick-copy-hint',
      text: '切换上方平台可预览不同文案；图片和文案均可进入对应 Tab 调整',
    });

    const destinations = section.createDiv({ cls: 'wesight-quick-destinations' });
    for (const platformId of targets) {
      const item = QUICK_PLATFORM_COPY[platformId];
      const state = this.quickPlatformStatus[platformId];
      const button = destinations.createEl('button', {
        attr: { type: 'button', 'aria-label': `前往${item.label}修改文案和图片` },
      });
      const icon = button.createSpan({ cls: 'wesight-quick-destination-icon' });
      setIcon(icon, item.icon);
      button.createSpan({ text: item.label });
      button.createSpan({
        cls: `wesight-quick-destination-state is-${state ?? 'pending'}`,
        text: state === 'ready' ? '已生成' : state === 'failed' ? '失败' : state === 'generating' ? '生成中' : '待生成',
      });
      const edit = button.createSpan({ cls: 'wesight-quick-destination-edit' });
      setIcon(edit, 'pencil');
      button.onclick = () => this.openQuickPlatform(platformId);
    }
  }

  private renderQuickCopyFields(parent: HTMLElement, platformId: QuickTransformPlatformId): void {
    if (platformId === 'x-post') {
      this.renderQuickBodyAndTopics(parent, this.quickXPostCopy.body, this.quickXPostCopy.topics, X_POST_TEXT_LIMIT, (body, topics) => {
        this.quickXPostCopy = { body, topics: normalizeXPostTopics(topics) };
        this.onQuickCopyEdited();
        this.scheduleDraftSave();
      }, buildXPostText, xPostWeightedLength);
      const selected = selectXPostImages(this.quickSelectedImages());
      parent.createSpan({ cls: 'wesight-quick-copy-hint', text: `X 中文通常计 2 字符，链接计 23；使用前 ${selected.images.length} 张 PNG/JPEG/WebP，每张不超过 5 MB。${selected.warnings.join('；')}` });
      return;
    }
    if (platformId === 'xiaohongshu') {
      const titleRow = parent.createDiv({ cls: 'wesight-quick-copy-title-row' });
      const title = titleRow.createEl('input', {
        attr: {
          type: 'text',
          maxlength: String(XHS_TITLE_LIMIT),
          placeholder: '小红书标题',
          'aria-label': '小红书标题',
        },
      });
      title.value = this.copy.title;
      const count = titleRow.createSpan({ text: `${Array.from(this.copy.title).length}/${XHS_TITLE_LIMIT}` });
      title.oninput = () => {
        this.copy.title = clampXhsTitle(title.value);
        count.setText(`${Array.from(this.copy.title).length}/${XHS_TITLE_LIMIT}`);
        this.onQuickCopyEdited();
        this.scheduleDraftSave();
      };
      this.renderQuickBodyAndTopics(parent, this.copy.body, this.copy.tags, XHS_BODY_LIMIT, (body, topics) => {
        this.copy.body = body;
        this.copy.tags = normalizeXhsTags(topics);
        this.onQuickCopyEdited();
        this.scheduleDraftSave();
      }, buildXhsPostText);
      return;
    }
    if (platformId === 'weibo-post') {
      const copy = this.weiboPostWorkbench.getQuickCopy();
      this.renderQuickBodyAndTopics(parent, copy.body, copy.topics, 2000, (body, topics) => {
        this.weiboPostWorkbench.updateQuickCopy({ body, topics });
        this.onQuickCopyEdited();
      });
      return;
    }
    const copy = this.jikePostWorkbench.getQuickCopy();
    this.renderQuickBodyAndTopics(parent, copy.body, copy.topics, 2000, (body, topics) => {
      this.jikePostWorkbench.updateQuickCopy({ body, topics });
      this.onQuickCopyEdited();
    });
  }

  private renderQuickBodyAndTopics(
    parent: HTMLElement,
    initialBody: string,
    initialTopics: string[],
    bodyLimit: number | undefined,
    onChange: (body: string, topics: string[]) => void,
    formatText?: (body: string, topics: string[]) => string,
    measureText: (text: string) => number = text => Array.from(text).length,
  ): void {
    let currentBody = initialBody;
    let currentTopics = [...initialTopics];
    const body = parent.createEl('textarea', {
      cls: 'wesight-quick-copy-body',
      attr: {
        rows: '5',
        placeholder: '生成后可在这里直接修改文案',
        'aria-label': '平台正文',
        ...(bodyLimit && !formatText ? { maxlength: String(bodyLimit) } : {}),
      },
    });
    body.value = initialBody;
    const meta = parent.createDiv({ cls: 'wesight-quick-copy-meta' });
    const topics = meta.createEl('input', {
      attr: {
        type: 'text',
        placeholder: '#话题1 #话题2',
        'aria-label': '平台话题',
      },
    });
    topics.value = initialTopics.map(topic => `#${topic}`).join(' ');
    const count = meta.createSpan();
    const updateCount = (): void => {
      const length = measureText(formatText ? formatText(currentBody, currentTopics) : currentBody);
      count.setText(bodyLimit ? `${length}/${bodyLimit}${formatText ? ' 字符（含话题）' : ''}` : `${length} 字`);
      count.classList.toggle('is-over-limit', Boolean(bodyLimit && length > bodyLimit));
      body.setAttribute('aria-invalid', String(Boolean(bodyLimit && length > bodyLimit)));
    };
    updateCount();
    body.oninput = () => {
      currentBody = body.value;
      updateCount();
      onChange(currentBody, currentTopics);
    };
    topics.oninput = () => {
      currentTopics = parseQuickTopics(topics.value);
      updateCount();
      onChange(currentBody, currentTopics);
    };
  }

  private setQuickCopyMode(mode: QuickTransformCopyMode): void {
    if (this.quickCopyMode === mode || this.quickOperation) return;
    this.quickCopyMode = mode;
    this.resetQuickGeneration();
    this.scheduleDraftSave();
    this.render();
  }

  private openQuickPlatform(platformId: QuickTransformPlatformId): void {
    if (platformId === 'x-post') {
      this.quickPreviewPlatform = platformId;
      this.activePlatform = 'quick';
      this.render();
      this.contentEl.querySelector<HTMLTextAreaElement>('.wesight-quick-copy-body')?.focus();
      return;
    }
    this.switchPlatform(platformId);
  }

  private onQuickCopyEdited(): void {
    this.clearQuickPublishTask();
  }

  private renderQuickError(parent: HTMLElement, message: string): void {
    const error = parent.createDiv({ cls: 'wesight-xhs-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    error.createSpan({ text: message });
    const dismiss = error.createEl('button', { attr: { type: 'button', 'aria-label': '关闭错误提示' } });
    setIcon(dismiss, 'x');
    dismiss.onclick = () => {
      delete this.quickErrors.general;
      this.render();
    };
  }

  private renderCopySection(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: 'wesight-xhs-copy-toolbar' });
    const heading = toolbar.createDiv();
    heading.createEl('strong', { text: '小红书文案' });
    heading.createSpan({ text: '标题、正文和标签都可编辑，也可用当前引擎一键重写。' });
    this.renderEngineBadge(toolbar, false);

    const layout = parent.createDiv({ cls: 'wesight-xhs-copy-layout' });
    const fields = layout.createDiv({ cls: 'wesight-xhs-copy-fields' });

    const titleField = fields.createDiv({ cls: 'wesight-xhs-field' });
    const titleLabel = titleField.createDiv({ cls: 'wesight-xhs-field-label' });
    titleLabel.createEl('label', { text: '标题' });
    const counter = titleLabel.createSpan({ text: `${Array.from(this.copy.title).length}/${XHS_TITLE_LIMIT}` });
    const title = titleField.createEl('input', {
      attr: {
        type: 'text',
        value: this.copy.title,
        maxlength: String(XHS_TITLE_LIMIT),
        placeholder: '输入不超过 20 个字符的标题',
      },
    });
    title.oninput = () => {
      this.copy.title = clampXhsTitle(title.value);
      if (title.value !== this.copy.title) title.value = this.copy.title;
      counter.setText(`${Array.from(this.copy.title).length}/${XHS_TITLE_LIMIT}`);
      this.scheduleDraftSave();
    };

    const bodyField = fields.createDiv({ cls: 'wesight-xhs-field' });
    const bodyLabel = bodyField.createDiv({ cls: 'wesight-xhs-field-label' });
    bodyLabel.createEl('label', { text: '正文' });
    const bodyCounter = bodyLabel.createSpan();
    const body = bodyField.createEl('textarea', {
      attr: { rows: '14', placeholder: '输入适合小红书阅读的正文' },
    });
    body.value = this.copy.body;
    const updateBodyCount = (): void => {
      const length = Array.from(buildXhsPostText(this.copy.body, this.copy.tags)).length;
      bodyCounter.setText(`${length}/${XHS_BODY_LIMIT} 字（含话题）`);
      bodyCounter.classList.toggle('is-over-limit', length > XHS_BODY_LIMIT);
      body.setAttribute('aria-invalid', String(length > XHS_BODY_LIMIT));
    };
    updateBodyCount();
    body.oninput = () => {
      this.copy.body = body.value;
      updateBodyCount();
      this.scheduleDraftSave();
    };

    const tagsField = fields.createDiv({ cls: 'wesight-xhs-field' });
    tagsField.createEl('label', { text: '标签' });
    const tagList = tagsField.createDiv({ cls: 'wesight-xhs-tags' });
    for (const tag of this.copy.tags) {
      const chip = tagList.createSpan({ cls: 'wesight-xhs-tag' });
      chip.createSpan({ text: `#${tag}` });
      const remove = chip.createEl('button', { attr: { type: 'button', 'aria-label': `删除标签 ${tag}` } });
      setIcon(remove, 'x');
      remove.onclick = () => {
        this.copy.tags = this.copy.tags.filter(value => value !== tag);
        this.scheduleDraftSave();
        this.render();
      };
    }
    const tagInput = tagsField.createEl('input', {
      cls: 'wesight-xhs-tag-input',
      attr: { type: 'text', placeholder: '输入标签后按回车' },
    });
    tagInput.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.copy.tags = normalizeXhsTags([...this.copy.tags, tagInput.value]);
      this.scheduleDraftSave();
      this.render();
    };

    const controls = layout.createDiv({ cls: 'wesight-xhs-copy-controls' });
    controls.createEl('strong', { text: '生成设置' });
    controls.createSpan({ text: '提示词可按你的账号定位长期调整。' });
    const requirement = controls.createEl('textarea', {
      attr: { rows: '8', placeholder: '例如：更像真实经验分享，减少营销感，保留技术细节。' },
    });
    requirement.value = this.copyRequirement;
    requirement.oninput = () => {
      this.copyRequirement = requirement.value;
    };
    const generate = controls.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: this.operation === 'copy' ? '正在生成文案…' : '使用当前引擎生成文案',
      attr: { type: 'button' },
    });
    const generateIcon = generate.createSpan();
    setIcon(generateIcon, this.operation === 'copy' ? 'loader-circle' : 'sparkles');
    generate.prepend(generateIcon);
    generate.disabled = Boolean(this.operation);
    generate.onclick = () => void this.generateCopy();

    const next = controls.createEl('button', {
      cls: 'wesight-xhs-secondary-button',
      text: '下一步：选择图片风格',
      attr: { type: 'button' },
    });
    next.onclick = () => this.showSection('images');
  }

  private renderImagesSection(parent: HTMLElement): void {
    if (this.style.categoryId !== 'typography') {
      this.renderAiImagesSection(parent);
      return;
    }
    this.renderRecommendation(parent);
    this.renderCategoryPicker(parent);

    const studio = parent.createDiv({ cls: 'wesight-xhs-studio' });
    this.renderLivePreview(studio);
    this.renderStyleRail(studio);
    this.renderImageSettings(studio);
    this.renderGeneratedStrip(parent);
    this.renderImageFooter(parent);
  }

  private renderAiImagesSection(parent: HTMLElement): void {
    const studio = parent.createDiv({ cls: 'wesight-xhs-ai-studio' });
    this.renderRecommendation(studio);
    this.renderCategoryPicker(studio);
    const toolbar = studio.createDiv({ cls: 'wesight-xhs-ai-toolbar' });
    const styles = toolbar.createEl('select', { attr: { 'aria-label': '选择 AI 图片风格' } });
    for (const style of getXhsCategory(this.style.categoryId).styles) {
      styles.createEl('option', { text: `风格：${style.label}`, value: style.id });
    }
    styles.value = this.style.styleId;
    styles.disabled = Boolean(this.operation);
    styles.onchange = () => this.chooseStyle({ ...this.style, styleId: styles.value });
    const engine = toolbar.createEl('button', { text: '图片引擎：Codex', attr: { type: 'button', title: '配置图片生成引擎' } });
    engine.onclick = () => this.options.openSettings();

    const heading = studio.createDiv({ cls: 'wesight-xhs-ai-gallery-heading' });
    heading.createEl('strong', { text: this.imageProgress?.label || (this.generatedPages.length ? `已生成 ${this.generatedPages.length} 张` : '图片预览') });
    const controls = heading.createDiv();
    const ratio = controls.createEl('select', { attr: { 'aria-label': 'AI 图片比例' } });
    (['3:4', '1:1', '4:3'] as const).forEach(value => ratio.createEl('option', { text: value, value }));
    ratio.value = this.imageRatio;
    ratio.disabled = Boolean(this.operation);
    ratio.onchange = () => { this.imageRatio = ratio.value as XhsImageRatio; this.scheduleDraftSave(); };
    const count = controls.createEl('select', { attr: { 'aria-label': 'AI 图片张数' } });
    for (let n = 1; n <= 9; n++) count.createEl('option', { text: `${n} 张`, value: String(n) });
    count.value = String(this.pageCount);
    count.disabled = Boolean(this.operation);
    count.onchange = () => {
      this.pageCount = Number(count.value);
      this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
      this.scheduleDraftSave();
      this.render();
    };
    if (this.imageProgress) studio.createEl('progress', { cls: 'wesight-xhs-ai-progress', attr: { max: String(this.imageProgress.total), value: String(this.imageProgress.completed) } });

    const gallery = studio.createDiv({ cls: 'wesight-xhs-ai-gallery', attr: { 'aria-label': 'AI 图片总览' } });
    gallery.addEventListener('scroll', () => { this.aiGalleryScrollLeft = gallery.scrollLeft; }, { passive: true });
    window.requestAnimationFrame(() => { if (gallery.isConnected) gallery.scrollLeft = this.aiGalleryScrollLeft; });
    for (let index = 0; index < Math.max(this.pageCount, this.generatedPages.length); index++) {
      const pageNumber = index + 1;
      const page = this.generatedPages.find(item => item.pageNumber === pageNumber);
      const card = gallery.createDiv({ cls: 'wesight-xhs-ai-card' });
      const preview = card.createEl('button', { cls: 'wesight-xhs-ai-image', attr: { type: 'button', 'aria-label': `放大第 ${pageNumber} 张图片` } });
      if (page) {
        preview.createEl('img', { attr: { src: this.imageResourceUrl(page), alt: `第 ${pageNumber} 张：${page.label}` } });
        preview.onclick = () => this.openAiImage(page);
        card.draggable = !this.operation;
        card.ondragstart = event => event.dataTransfer?.setData('application/x-wesight-image-page', String(index));
        card.ondragover = event => { if (!this.operation) event.preventDefault(); };
        card.ondrop = event => {
          event.preventDefault();
          const source = event.dataTransfer?.getData('application/x-wesight-image-page');
          if (source) this.moveAiImage(Number(source), index);
        };
      } else {
        preview.disabled = true;
        const icon = preview.createSpan();
        setIcon(icon, this.aiPendingPages.has(pageNumber) ? 'loader-circle' : 'image');
        preview.createSpan({ text: this.aiPendingPages.has(pageNumber) ? '正在生成…' : '等待生成' });
      }
      preview.createSpan({ cls: 'wesight-xhs-ai-number', text: `${String(pageNumber).padStart(2, '0')}${index === 0 ? ' 封面' : ''}` });
      if (page && this.aiPendingPages.has(pageNumber)) preview.createSpan({ cls: 'wesight-xhs-ai-pending', text: '正在重新生成…' });
      const actions = card.createDiv({ cls: 'wesight-xhs-ai-card-actions' });
      const zoom = actions.createEl('button', { text: '放大', attr: { type: 'button' } });
      const zoomIcon = zoom.createSpan(); setIcon(zoomIcon, 'zoom-in'); zoom.prepend(zoomIcon);
      zoom.disabled = !page;
      zoom.onclick = () => { if (page) this.openAiImage(page); };
      const regenerate = actions.createEl('button', { text: page ? '重新生成' : '生成本张', attr: { type: 'button', 'aria-label': `重新生成第 ${pageNumber} 张` } });
      const regenerateIcon = regenerate.createSpan(); setIcon(regenerateIcon, 'refresh-cw'); regenerate.prepend(regenerateIcon);
      regenerate.disabled = Boolean(this.operation) || pageNumber > this.pageCount;
      regenerate.onclick = () => void this.generateImages(pageNumber);
      if (page && index > 0) {
        const move = actions.createEl('button', { attr: { type: 'button', 'aria-label': `将第 ${pageNumber} 张向前移动`, title: '向前移动' } });
        setIcon(move, 'arrow-left');
        move.disabled = Boolean(this.operation);
        move.onclick = () => this.moveAiImage(index, index - 1);
      }
    }
    if (this.pageCount < 9) {
      const add = gallery.createEl('button', { cls: 'wesight-xhs-ai-add', attr: { type: 'button' } });
      const icon = add.createSpan(); setIcon(icon, 'plus');
      add.createSpan({ text: '添加一张' });
      add.disabled = Boolean(this.operation);
      add.onclick = () => {
        this.pageCount += 1;
        this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
        void this.generateImages(this.pageCount);
      };
    }

    const details = studio.createEl('details', { cls: 'wesight-xhs-ai-settings' });
    details.open = this.aiSettingsOpen;
    details.ontoggle = () => { this.aiSettingsOpen = details.open; };
    details.createEl('summary', { text: '生成描述与参考图　调整' });
    details.createEl('p', { text: '根据原文自动规划画面，可补充描述与参考图。' });
    const prompt = details.createEl('textarea', { attr: { rows: '3', 'aria-label': '生成画面描述', placeholder: '描述画面内容、配色、构图或需要保留的细节…' } });
    prompt.value = this.customStylePrompt;
    prompt.disabled = Boolean(this.operation);
    prompt.oninput = () => { this.customStylePrompt = prompt.value; this.scheduleDraftSave(); };
    const references = details.createDiv({ cls: 'wesight-xhs-ai-references' });
    this.imageReferences.forEach((reference, index) => {
      const chip = references.createEl('button', { attr: { type: 'button', title: `移除参考图：${reference.fileName}` } });
      chip.createEl('img', { attr: { src: this.imageResourceUrl(reference), alt: reference.fileName } });
      chip.createSpan({ text: '移除' });
      chip.disabled = Boolean(this.operation);
      chip.onclick = () => { this.imageReferences.splice(index, 1); this.scheduleDraftSave(); this.render(); };
    });
    const fromArticle = references.createEl('button', { text: '从原文选择', attr: { type: 'button' } });
    fromArticle.disabled = Boolean(this.operation) || this.imageReferences.length >= 4;
    fromArticle.onclick = () => this.chooseAiReferences();
    const upload = references.createEl('button', { text: '上传参考图', attr: { type: 'button' } });
    upload.disabled = Boolean(this.operation) || this.imageReferences.length >= 4;
    const input = references.createEl('input', { attr: { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: '' } });
    input.hidden = true;
    upload.onclick = () => input.click();
    input.onchange = () => void this.addAiReferenceFiles(Array.from(input.files ?? []));

    const footer = studio.createDiv({ cls: 'wesight-xhs-ai-footer' });
    const generate = footer.createEl('button', { cls: 'wesight-xhs-primary-button', text: this.operation === 'images' ? '正在生成图片…' : this.generatedPages.length ? '重新生成全部' : `生成 ${this.pageCount} 张图片`, attr: { type: 'button' } });
    generate.disabled = Boolean(this.operation);
    generate.onclick = () => void this.generateImages();
    const next = footer.createEl('button', { cls: 'wesight-xhs-secondary-button', text: '下一步：检查', attr: { type: 'button' } });
    next.disabled = Boolean(this.operation) || this.generatedPages.length !== this.pageCount;
    next.onclick = () => this.showSection('review');
    if (this.generatedPages.length > this.pageCount) {
      studio.createDiv({ cls: 'wesight-xhs-ai-hint', text: '当前图片多于设定张数。重新生成全部会按新张数替换，也可恢复原张数继续检查。' });
    }
    studio.createDiv({ cls: 'wesight-xhs-ai-hint', text: '切换风格保留当前结果，生成后应用新风格。图片可拖动排序。' });
  }

  private openAiImage(page: XhsGeneratedPage): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText(`第 ${page.pageNumber} 张 · ${page.label}`);
    modal.contentEl.addClass('wesight-xhs-ai-lightbox');
    modal.contentEl.createEl('img', { attr: { src: this.imageResourceUrl(page), alt: page.label } });
    modal.open();
  }

  private moveAiImage(from: number, to: number): void {
    if (this.operation || from === to || !Number.isInteger(from) || from < 0 || to < 0) return;
    const pages = [...this.generatedPages].sort((a, b) => a.pageNumber - b.pageNumber);
    if (pages.length !== this.pageCount || from >= pages.length || to >= pages.length) return;
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    const contents = [...this.pageContents];
    const [content] = contents.splice(from, 1);
    contents.splice(to, 0, content);
    this.generatedPages = pages.map((item, index) => ({ ...item, pageNumber: index + 1 }));
    this.pageContents = contents.map((item, index) => ({ ...item, pageNumber: index + 1 }));
    this.scheduleDraftSave();
    this.render();
  }

  private chooseAiReferences(): void {
    const snapshot = this.snapshot;
    const modal = new Modal(this.app);
    modal.titleEl.setText('选择原文参考图（最多 4 张）');
    const grid = modal.contentEl.createDiv({ cls: 'wesight-xhs-ai-reference-picker' });
    const images = this.quickArticleImages();
    if (!images.length) grid.createEl('p', { text: '原文中没有可用图片，可以上传参考图。' });
    for (const image of images) {
      const selected = this.imageReferences.some(item => item.vaultPath === image.vaultPath);
      const button = grid.createEl('button', { attr: { type: 'button', 'aria-pressed': String(selected), title: image.fileName } });
      button.createEl('img', { attr: { src: this.imageResourceUrl(image), alt: image.fileName } });
      button.disabled = selected;
      button.onclick = () => {
        if (this.snapshot !== snapshot || this.operation) { modal.close(); return; }
        if (this.imageReferences.length >= 4) return;
        this.imageReferences.push({ vaultPath: image.vaultPath, fileName: image.fileName, mimeType: image.mimeType, previewUrl: image.previewUrl });
        button.disabled = true;
        this.scheduleDraftSave(); this.render();
        if (this.imageReferences.length >= 4) modal.close();
      };
    }
    modal.open();
  }

  private async addAiReferenceFiles(files: File[]): Promise<void> {
    const snapshot = this.snapshot;
    try {
      const root = '.wesight/xiaohongshu-references';
      for (const directory of ['.wesight', root]) {
        if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
      }
      for (const file of files.slice(0, 4 - this.imageReferences.length)) {
        if (this.snapshot !== snapshot || this.operation || this.imageReferences.length >= 4) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('参考图支持 PNG、JPG、WebP，单张不超过 10 MB');
        const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
        const vaultPath = `${root}/${crypto.randomUUID()}.${extension}`;
        await this.app.vault.adapter.writeBinary(vaultPath, await file.arrayBuffer());
        if (this.snapshot !== snapshot || this.operation) return;
        this.imageReferences.push({ vaultPath, fileName: file.name, mimeType: file.type });
      }
      this.scheduleDraftSave();
    } catch (error) { this.error = error instanceof Error ? error.message : '参考图读取失败'; }
    this.render();
  }

  private renderRecommendation(parent: HTMLElement): void {
    if (!this.recommendation) return;
    const recommendation = this.recommendation;
    const category = getXhsCategory(recommendation.categoryId);
    const style = getXhsStyle(recommendation.categoryId, recommendation.styleId);
    const panel = parent.createDiv({ cls: 'wesight-xhs-recommendation' });
    const label = panel.createDiv({ cls: 'wesight-xhs-recommendation-label' });
    const icon = label.createSpan();
    setIcon(icon, 'sparkles');
    label.createSpan({ text: 'AI 风格推荐' });

    const summary = panel.createDiv({ cls: 'wesight-xhs-recommendation-summary' });
    const headline = summary.createDiv();
    headline.createEl('strong', { text: `${category.label} · ${style.label}` });
    headline.createSpan({ cls: 'wesight-xhs-confidence', text: `${recommendation.confidence}% 匹配` });
    const basis = panel.createEl('details', {
      cls: 'wesight-xhs-recommendation-basis',
    });
    basis.createEl('summary', { text: '查看依据' });
    const basisPopover = basis.createDiv({ cls: 'wesight-xhs-recommendation-basis-popover' });
    basisPopover.createEl('strong', { text: '为什么推荐这个风格' });
    recommendation.reasons.forEach(reason => basisPopover.createEl('p', { text: reason }));
    if (this.recommendationNote) {
      basisPopover.createSpan({ cls: 'wesight-xhs-recommendation-note', text: this.recommendationNote });
    }

    if (recommendation.alternatives.length) {
      const alternatives = basisPopover.createDiv({ cls: 'wesight-xhs-recommendation-alternatives' });
      alternatives.createSpan({ text: '备选风格' });
      for (const alternative of recommendation.alternatives) {
        const alternativeCategory = getXhsCategory(alternative.categoryId);
        const alternativeStyle = getXhsStyle(alternative.categoryId, alternative.styleId);
        const alternativeLabel = `${alternativeCategory.label} · ${alternativeStyle.label} ${alternative.confidence}%`;
        const button = alternatives.createEl('button', {
          text: alternativeLabel,
          attr: { type: 'button', title: alternativeLabel },
        });
        button.onclick = () => {
          this.chooseStyle({ categoryId: alternative.categoryId, styleId: alternative.styleId });
        };
      }
    }

    const actions = panel.createDiv({ cls: 'wesight-xhs-recommendation-actions' });
    const apply = actions.createEl('button', {
      cls: 'wesight-xhs-primary-button is-compact',
      text: '采用推荐',
      attr: { type: 'button' },
    });
    apply.onclick = () => this.applyRecommendation();
    const reanalyze = actions.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: this.recommendationRunning ? '分析中…' : '重新分析',
      attr: { type: 'button' },
    });
    const analyzeIcon = reanalyze.createSpan();
    setIcon(analyzeIcon, this.recommendationRunning ? 'loader-circle' : 'refresh-cw');
    reanalyze.prepend(analyzeIcon);
    reanalyze.disabled = this.recommendationRunning || Boolean(this.operation);
    reanalyze.onclick = () => void this.refineRecommendation(false);
  }

  private renderCategoryPicker(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'wesight-xhs-category-section' });
    const grid = section.createDiv({
      cls: 'wesight-xhs-category-grid',
      attr: { 'aria-label': '选择图片大类' },
    });
    for (const category of XHS_CATEGORIES) {
      const selected = this.style.categoryId === category.id;
      const recommended = this.recommendation?.categoryId === category.id;
      const card = grid.createEl('button', {
        cls: `wesight-xhs-category${selected ? ' is-selected' : ''}${recommended ? ' is-recommended' : ''}`,
        attr: { type: 'button', 'aria-pressed': String(selected) },
      });
      const visual = card.createDiv({ cls: 'wesight-xhs-category-visual' });
      visual.createEl('img', { attr: { src: CATEGORY_THUMBNAILS[category.id], alt: `${category.label}示例` } });
      if (recommended) visual.createSpan({ cls: 'wesight-xhs-recommended-marker', text: '推荐' });
      card.createEl('strong', { text: category.label });
      card.createSpan({ text: category.description });
      card.onclick = () => {
        this.chooseStyle({ categoryId: category.id, styleId: category.styles[0].id });
      };
    }
  }

  private renderLivePreview(parent: HTMLElement): void {
    const area = parent.createDiv({ cls: 'wesight-xhs-preview-area' });
    const heading = area.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: '实时预览' });
    heading.createSpan({ text: '3:4' });
    const preview = area.createDiv({ cls: `wesight-xhs-live-preview is-${this.style.categoryId}` });
    const pageContent = this.currentPageContent();
    const generated = this.generatedPages[this.selectedPreviewPage];
    if (generated) {
      preview.addClass('has-generated-image');
      preview.createEl('img', {
        attr: {
          src: this.imageResourceUrl(generated),
          alt: `小红书第 ${generated.pageNumber} 张图片`,
        },
      });
      return;
    }
    if (this.style.categoryId === 'typography') {
      const canvas = preview.createEl('canvas', {
        cls: 'wesight-xhs-typography-preview',
        attr: {
          width: '540',
          height: '720',
          role: 'img',
          'aria-label': `${getXhsTypographyTemplate(this.style.styleId).label}文字排版预览`,
        },
      });
      if (pageContent) {
        const input = buildXhsTypographyPageInput(
          pageContent.text,
          this.selectedPreviewPage + 1,
          this.pageCount,
        );
        void renderXhsTypographyTemplate(canvas, this.style.styleId, input).catch(error => {
          if (!canvas.isConnected) return;
          canvas.replaceWith(this.createTypographyPreviewError(error));
        });
      }
      return;
    }
    preview.createEl('img', {
      cls: 'wesight-xhs-preview-texture',
      attr: { src: CATEGORY_THUMBNAILS[this.style.categoryId], alt: '' },
    });
    const overlay = preview.createDiv({ cls: 'wesight-xhs-preview-overlay' });
    overlay.createDiv({
      cls: 'wesight-xhs-preview-text',
      text: pageContent?.text || '图片文字会在这里按照所选样式排版。',
    });
  }

  private renderStyleRail(parent: HTMLElement): void {
    const category = getXhsCategory(this.style.categoryId);
    const rail = parent.createDiv({ cls: 'wesight-xhs-style-rail' });
    const heading = rail.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: '二级样式' });
    heading.createSpan({ text: category.label });
    const list = rail.createDiv({ cls: 'wesight-xhs-style-list' });
    let selectedButton: HTMLButtonElement | null = null;
    for (const style of category.styles) {
      const selected = this.style.styleId === style.id;
      const button = list.createEl('button', {
        cls: `wesight-xhs-style${selected ? ' is-selected' : ''}`,
        attr: { type: 'button', 'aria-pressed': String(selected) },
      });
      if (selected) selectedButton = button;
      const thumbnail = category.id === 'typography'
        ? getXhsTypographyTemplate(style.id).referenceImage
        : CATEGORY_THUMBNAILS[category.id];
      button.createEl('img', { attr: { src: thumbnail, alt: '' } });
      const copy = button.createDiv();
      copy.createEl('strong', { text: style.label });
      copy.createSpan({ text: style.description });
      button.onclick = () => {
        this.styleListScrollTops.set(category.id, list.scrollTop);
        this.chooseStyle({ categoryId: category.id, styleId: style.id });
      };
    }

    list.addEventListener('scroll', () => {
      this.styleListScrollTops.set(category.id, list.scrollTop);
    }, { passive: true });

    const savedScrollTop = this.styleListScrollTops.get(category.id);
    window.requestAnimationFrame(() => {
      if (!list.isConnected) return;
      if (savedScrollTop !== undefined) list.scrollTop = savedScrollTop;
      if (!selectedButton) return;

      const listRect = list.getBoundingClientRect();
      const selectedRect = selectedButton.getBoundingClientRect();
      if (selectedRect.top < listRect.top) {
        list.scrollTop -= listRect.top - selectedRect.top;
      } else if (selectedRect.bottom > listRect.bottom) {
        list.scrollTop += selectedRect.bottom - listRect.bottom;
      }
      this.styleListScrollTops.set(category.id, list.scrollTop);
    });
  }

  private renderImageSettings(parent: HTMLElement): void {
    const settings = parent.createDiv({ cls: 'wesight-xhs-image-settings' });
    const heading = settings.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: '内容设置' });

    const count = settings.createDiv({ cls: 'wesight-xhs-setting-field wesight-xhs-page-count-field' });
    count.createEl('label', { text: '页数' });
    const select = count.createEl('select', {
      attr: { 'aria-label': '选择小红书图片页数' },
    });
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(value => {
      const option = select.createEl('option', { text: `${value} 张`, attr: { value: String(value) } });
      option.selected = this.pageCount === value;
    });
    select.onchange = () => {
      this.pageCount = Number(select.value);
      this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
      this.generatedPages = [];
      this.selectedPreviewPage = Math.min(this.selectedPreviewPage, this.pageCount - 1);
      this.scheduleDraftSave();
      this.render();
    };

    const page = this.currentPageContent();
    if (page) this.renderPageContentEditor(settings, page);

    const generateAll = settings.createEl('button', {
      cls: 'wesight-xhs-primary-button wesight-xhs-content-generate',
      text: this.operation === 'pageContents'
        ? `正在生成 ${this.pageCount} 张内容…`
        : `一键生成 ${this.pageCount} 张内容`,
      attr: { type: 'button' },
    });
    const generateAllIcon = generateAll.createSpan();
    setIcon(generateAllIcon, this.operation === 'pageContents' ? 'loader-circle' : 'sparkles');
    generateAll.prepend(generateAllIcon);
    generateAll.disabled = Boolean(this.operation);
    generateAll.onclick = () => void this.generatePageContents();

    const saved = settings.createDiv({ cls: 'wesight-xhs-content-saved' });
    const savedIcon = saved.createSpan();
    setIcon(savedIcon, 'lock-keyhole');
    saved.createSpan({ text: `${this.pageContents.length} 张内容已保存 · 切换样式不改变` });

    settings.createDiv({
      cls: 'wesight-xhs-current-page',
      text: `当前编辑：第 ${this.selectedPreviewPage + 1} 张`,
    });

    if (page) {
      const regenerate = settings.createEl('button', {
        cls: 'wesight-xhs-content-regenerate',
        text: this.operation === 'pageContent' ? '正在重新生成本页…' : '重新生成本页',
        attr: { type: 'button' },
      });
      const regenerateIcon = regenerate.createSpan();
      setIcon(regenerateIcon, this.operation === 'pageContent' ? 'loader-circle' : 'refresh-cw');
      regenerate.prepend(regenerateIcon);
      regenerate.disabled = Boolean(this.operation);
      regenerate.onclick = () => void this.regenerateCurrentPageContent();
    }

    const ratio = settings.createDiv({ cls: 'wesight-xhs-setting-row' });
    ratio.createSpan({ text: '比例' });
    ratio.createEl('strong', { text: '3:4' });

    if (this.style.categoryId !== 'typography') {
      const prompt = settings.createDiv({ cls: 'wesight-xhs-setting-field' });
      prompt.createEl('label', { text: '自定义风格' });
      const textarea = prompt.createEl('textarea', {
        attr: { rows: '5', placeholder: '补充配色、字体、人物、质感或品牌风格。' },
      });
      textarea.value = this.customStylePrompt;
      textarea.oninput = () => {
        this.customStylePrompt = textarea.value;
        this.scheduleDraftSave();
      };
    }

    const engine = settings.createDiv({ cls: 'wesight-xhs-setting-engine' });
    this.renderEngineBadge(engine, true, this.style.categoryId === 'typography');
  }

  private renderPageContentEditor(
    parent: HTMLElement,
    page: XhsPageContent,
  ): void {
    const editor = parent.createDiv({ cls: 'wesight-xhs-content-editor' });
    const sourceHeading = editor.createDiv({ cls: 'wesight-xhs-content-field-heading' });
    sourceHeading.createSpan({ text: '来源' });
    const sources = editor.createDiv({ cls: 'wesight-xhs-content-sources' });
    const options: Array<{ id: XhsPageContentSource; label: string }> = [
      { id: 'article', label: '正文提取' },
      { id: 'ai', label: 'AI 生成' },
      { id: 'manual', label: '手动输入' },
    ];
    for (const option of options) {
      const button = sources.createEl('button', {
        cls: page.textSource === option.id ? 'is-selected' : '',
        text: option.label,
        attr: { type: 'button', 'aria-pressed': String(page.textSource === option.id) },
      });
      button.onclick = () => this.setPageContentSource(option.id);
    }

    const textHeading = editor.createDiv({ cls: 'wesight-xhs-content-field-heading' });
    textHeading.createSpan({ text: '图片文字' });
    const counter = textHeading.createSpan({
      cls: 'wesight-xhs-content-counter',
      text: `${Array.from(page.text).length}/${XHS_PAGE_TEXT_LIMIT}`,
    });
    const textarea = editor.createEl('textarea', {
      attr: {
        rows: '5',
        maxlength: String(XHS_PAGE_TEXT_LIMIT),
        placeholder: '输入一句话或一段话，整张图会使用同一套文字样式',
        'data-xhs-page-field': 'text',
      },
    });
    textarea.value = page.text;
    textarea.oninput = () => {
      const next = Array.from(textarea.value).slice(0, XHS_PAGE_TEXT_LIMIT).join('');
      if (textarea.value !== next) textarea.value = next;
      const current = this.currentPageContent();
      if (!current) return;
      current.text = next;
      current.textSource = 'manual';
      this.generatedPages = [];
      counter.setText(`${Array.from(next).length}/${XHS_PAGE_TEXT_LIMIT}`);
      sources.querySelectorAll('button').forEach(button => {
        const selected = button.textContent === '手动输入';
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      this.refreshPageContentVisual(current);
      this.scheduleDraftSave();
    };
  }

  private renderGeneratedStrip(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'wesight-xhs-generated-section' });
    const heading = section.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: this.generatedPages.length ? `生成结果（${this.generatedPages.length} 张）` : `页面内容（${this.pageCount} 张）` });
    if (this.generatedPages.length) {
      const regenerate = heading.createEl('button', {
        cls: 'wesight-xhs-subtle-button',
        text: '重新生成',
        attr: { type: 'button' },
      });
      regenerate.onclick = () => void this.generateImages();
    }
    const strip = section.createDiv({ cls: 'wesight-xhs-generated-strip' });
    this.pageContents.forEach((page, index) => {
      const generated = this.generatedPages[index];
      const button = strip.createEl('button', {
        cls: `wesight-xhs-page-thumb${this.selectedPreviewPage === index ? ' is-selected' : ''}`,
        attr: {
          type: 'button',
          'aria-label': `查看第 ${index + 1} 张`,
          'data-xhs-page-number': String(page.pageNumber),
        },
      });
      button.createSpan({ cls: 'wesight-xhs-page-number', text: String(index + 1) });
      if (generated) {
        button.createEl('img', {
          attr: { src: this.imageResourceUrl(generated), alt: generated.label },
        });
      } else {
        button.createSpan({ cls: 'wesight-xhs-thumb-text', text: page.text || page.label });
      }
      button.onclick = () => {
        this.selectedPreviewPage = index;
        this.render();
      };
    });
  }

  private renderImageFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: 'wesight-xhs-image-footer' });
    const status = footer.createDiv({ cls: 'wesight-xhs-generation-status' });
    if (this.imageProgress) {
      status.createEl('strong', { text: this.imageProgress.label });
      const progress = status.createEl('progress', {
        attr: { max: String(this.imageProgress.total), value: String(this.imageProgress.completed) },
      });
      progress.value = this.imageProgress.completed;
    } else {
      const category = getXhsCategory(this.style.categoryId);
      const style = getXhsStyle(this.style.categoryId, this.style.styleId);
      status.createSpan({ text: `当前选择：${category.label} · ${style.label}` });
    }
    const actions = footer.createDiv({ cls: 'wesight-xhs-footer-actions' });
    const previous = actions.createEl('button', {
      cls: 'wesight-xhs-secondary-button',
      text: '返回文案',
      attr: { type: 'button' },
    });
    previous.disabled = Boolean(this.operation);
    previous.onclick = () => this.showSection('copy');
    const generate = actions.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: this.operation === 'images'
        ? '正在生成图片…'
        : this.style.categoryId === 'typography'
          ? '生成本地模板图片'
          : '使用 Codex 生成图片',
      attr: { type: 'button' },
    });
    const icon = generate.createSpan();
    setIcon(
      icon,
      this.operation === 'images'
        ? 'loader-circle'
        : this.style.categoryId === 'typography'
          ? 'image-down'
          : 'image-plus',
    );
    generate.prepend(icon);
    generate.disabled = Boolean(this.operation);
    generate.onclick = () => void this.generateImages();
  }

  private renderReviewSection(parent: HTMLElement): void {
    const summary = parent.createDiv({ cls: 'wesight-xhs-review-summary' });
    const copy = summary.createDiv({ cls: 'wesight-xhs-review-copy' });
    const heading = copy.createDiv({ cls: 'wesight-xhs-section-heading' });
    heading.createEl('strong', { text: '文案检查' });
    const edit = heading.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: '返回编辑',
      attr: { type: 'button' },
    });
    edit.onclick = () => this.showSection('copy');
    copy.createEl('h2', { text: this.copy.title || '未填写标题' });
    const body = copy.createEl('p', { text: this.copy.body || '未填写正文' });
    body.addClass('wesight-xhs-review-body');
    const tags = copy.createDiv({ cls: 'wesight-xhs-tags' });
    this.copy.tags.forEach(tag => tags.createSpan({ cls: 'wesight-xhs-tag', text: `#${tag}` }));
    const copyButton = copy.createEl('button', {
      cls: 'wesight-xhs-secondary-button',
      text: '复制完整文案',
      attr: { type: 'button' },
    });
    const copyIcon = copyButton.createSpan();
    setIcon(copyIcon, 'copy');
    copyButton.prepend(copyIcon);
    copyButton.onclick = () => void this.copyFullDraft();

    const images = summary.createDiv({ cls: 'wesight-xhs-review-images' });
    const imageHeading = images.createDiv({ cls: 'wesight-xhs-section-heading' });
    imageHeading.createEl('strong', { text: `图片检查（${this.generatedPages.length}/${this.pageCount}）` });
    const editImages = imageHeading.createEl('button', {
      cls: 'wesight-xhs-subtle-button',
      text: '调整图片',
      attr: { type: 'button' },
    });
    editImages.onclick = () => this.showSection('images');
    if (!this.generatedPages.length) {
      images.createDiv({ cls: 'wesight-xhs-review-empty', text: '还没有生成图片，可返回图片风格页继续。' });
    } else {
      const grid = images.createDiv({ cls: 'wesight-xhs-review-grid' });
      for (const page of this.generatedPages) {
        const link = grid.createEl('a', {
          attr: {
            href: this.imageResourceUrl(page),
            target: '_blank',
            rel: 'noopener',
            title: `打开第 ${page.pageNumber} 张`,
          },
        });
        link.createEl('img', {
          attr: { src: this.imageResourceUrl(page), alt: page.label },
        });
        link.createSpan({ text: `${page.pageNumber}. ${page.label}` });
      }
    }

    this.renderPublishSection(parent);
  }

  private renderPublishSection(parent: HTMLElement): void {
    const validationErrors = validateXiaohongshuPublishInput(this.copy, this.pageCount, this.generatedPages);
    if (validationErrors.length) {
      const preflight = parent.createDiv({ cls: 'wesight-xhs-publish-preflight' });
      const icon = preflight.createSpan();
      setIcon(icon, 'triangle-alert');
      const copy = preflight.createDiv();
      copy.createEl('strong', { text: '发布前还需要处理' });
      validationErrors.slice(0, 3).forEach(message => copy.createSpan({ text: message }));
    }

    if (this.publishAuthLoading) {
      const loading = parent.createDiv({ cls: 'wesight-xhs-publish-card is-loading' });
      const icon = loading.createSpan();
      setIcon(icon, 'loader-circle');
      loading.createSpan({ text: '正在检查 WeSight 登录状态…' });
      return;
    }

    if (!this.options.auth.getCurrentUser()) {
      const gate = parent.createDiv({ cls: 'wesight-xhs-publish-card' });
      const heading = gate.createDiv({ cls: 'wesight-xhs-publish-card-heading' });
      const headingIcon = heading.createSpan();
      setIcon(headingIcon, 'log-in');
      const copy = heading.createDiv();
      copy.createEl('strong', { text: '登录后使用小红书发布助手' });
      copy.createSpan({ text: '开通或续费会员后，即可使用浏览器发布助手。' });
      const login = gate.createEl('button', {
        cls: 'wesight-xhs-primary-button',
        text: this.publishLoginPending ? '等待登录完成' : '请先登录 WeSight',
        attr: { type: 'button' },
      });
      login.disabled = this.publishLoginPending;
      login.onclick = () => {
        this.publishLoginPending = true;
        this.options.auth.startLogin();
        this.render();
      };
      return;
    }

    const connection = this.options.bridge.getConnectionState();
    const extensionNeedsUpdate = connection.connected
      && connection.supportedPlatforms !== null
      && !connection.supportedPlatforms.includes('xiaohongshu');
    if (!connection.connected) {
      this.renderPublishInstallGuide(parent);
      return;
    }

    const connectionRow = parent.createDiv({
      cls: `wesight-xhs-publish-connection${connection.connected ? ' is-connected' : ''}${extensionNeedsUpdate ? ' is-outdated' : ''}`,
    });
    const connectionIcon = connectionRow.createSpan();
    setIcon(connectionIcon, extensionNeedsUpdate ? 'circle-alert' : connection.connected ? 'link' : connection.paired ? 'radio' : 'plug-zap');
    const connectionCopy = connectionRow.createDiv();
    connectionCopy.createEl('strong', {
      text: extensionNeedsUpdate
        ? '发布助手版本过旧'
        : connection.connected ? '发布助手已连接' : connection.paired ? '发布助手已配对，等待连接' : '首次任务将完成发布助手配对',
    });
    connectionCopy.createSpan({
      text: extensionNeedsUpdate
        ? '当前浏览器扩展还不支持小红书，请更新本地扩展后重试'
        : '文案和图片仅通过 127.0.0.1 临时通道传输',
    });
    if (extensionNeedsUpdate) {
      const update = connectionRow.createEl('button', {
        cls: 'wesight-xhs-subtle-button',
        text: '连接设置',
        attr: { type: 'button' },
      });
      update.onclick = () => void this.openChromeExtensions();
    }
    if (connection.paired && !this.publishTask) {
      const repair = connectionRow.createEl('button', {
        cls: 'wesight-xhs-subtle-button',
        text: '连接设置',
        attr: { type: 'button' },
      });
      repair.disabled = this.publishBusy || validationErrors.length > 0;
      repair.onclick = () => void this.startXiaohongshuPublish(true);
    }

    if (this.publishTask) {
      this.renderPublishTask(parent, this.publishTask, extensionNeedsUpdate);
      return;
    }

    const footer = parent.createDiv({ cls: 'wesight-xhs-review-footer' });
    const note = footer.createDiv();
    const savedIcon = note.createSpan();
    setIcon(savedIcon, 'folder-check');
    const savedCopy = note.createDiv();
    savedCopy.createEl('strong', { text: '素材已保存在当前仓库' });
    savedCopy.createSpan({ text: '发布助手会打开小红书并填好内容，最终由你确认发布。' });
    const publish = footer.createEl('button', {
      cls: 'wesight-xhs-primary-button',
      text: this.publishBusy ? '正在打开发布助手…' : '使用发布助手发布',
      attr: { type: 'button' },
    });
    const publishIcon = publish.createSpan();
    setIcon(publishIcon, this.publishBusy ? 'loader-circle' : 'send');
    publish.prepend(publishIcon);
    publish.disabled = this.publishBusy || validationErrors.length > 0 || extensionNeedsUpdate;
    publish.onclick = () => void this.startXiaohongshuPublish(false);
  }

  private renderPublishInstallGuide(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'wesight-multi-install-guide' });
    card.createEl('strong', { text: '连接浏览器发布助手' });
    card.createEl('p', { text: '请在设置 → 连接器中完成安装与连接，当前内容会保留。' });
    const button = card.createEl('button', { text: '前往连接设置', cls: 'wesight-xhs-primary-button', attr: { type: 'button' } });
    button.onclick = this.options.openBrowserConnector;
  }

  private renderPublishTask(parent: HTMLElement, task: MultiPublishTaskState, extensionNeedsUpdate: boolean): void {
    const state = task.platforms.xiaohongshu;
    const card = parent.createDiv({ cls: `wesight-xhs-publish-task is-${state.status}` });
    const icon = card.createSpan();
    setIcon(icon, state.status === 'ready' ? 'circle-check' : state.status === 'failed' || state.status === 'login_required' ? 'circle-alert' : 'loader-circle');
    const copy = card.createDiv();
    copy.createEl('strong', { text: extensionNeedsUpdate ? '发布助手版本过旧' : XHS_PUBLISH_STATUS[state.status] });
    copy.createSpan({
      text: extensionNeedsUpdate
        ? '请在扩展管理页重新加载支持小红书的最新构建'
        : state.message || XHS_PUBLISH_STATUS[state.status],
    });
    if (state.warnings.length) copy.createSpan({ text: state.warnings[0] });
    const actions = card.createDiv();
    if (state.status === 'ready' || state.status === 'login_required') {
      const open = actions.createEl('button', { text: '打开编辑页', attr: { type: 'button' } });
      open.onclick = () => void this.openXiaohongshuTask();
    }
    if (['queued', 'opening', 'failed', 'login_required'].includes(state.status)) {
      const retry = actions.createEl('button', {
        text: state.status === 'queued' || state.status === 'opening' ? '重新打开发布助手' : '重试',
        attr: { type: 'button' },
      });
      retry.disabled = extensionNeedsUpdate;
      retry.onclick = () => void this.retryXiaohongshuTask();
    }
    if (['queued', 'opening', 'ready', 'failed', 'cancelled'].includes(state.status)) {
      const restart = actions.createEl('button', { text: '重新准备', attr: { type: 'button' } });
      restart.onclick = () => {
        this.publishTask = null;
        this.render();
      };
    }
  }

  private renderEngineBadge(parent: HTMLElement, image: boolean, local = false): void {
    const settings = this.options.getSettings();
    const engine = parent.createDiv({ cls: 'wesight-xhs-engine-badge' });
    const icon = engine.createSpan();
    setIcon(icon, local ? 'layout-template' : image ? 'image' : 'sparkles');
    engine.createSpan({ text: local ? '渲染方式' : image ? '图片引擎' : '当前引擎' });
    engine.createEl('strong', {
      text: local ? '本地模板' : image ? 'Codex' : engineLabel(settings.defaultAgentId),
    });
  }

  private createTypographyPreviewError(error: unknown): HTMLElement {
    const message = document.createElement('div');
    message.className = 'wesight-xhs-typography-preview-error';
    const icon = message.createSpan();
    setIcon(icon, 'image-off');
    message.createSpan({
      text: error instanceof Error ? error.message : '文字排版预览加载失败',
    });
    return message;
  }

  private renderStatus(parent: HTMLElement, iconName: string, text: string, spinning = false): void {
    const status = parent.createDiv({ cls: `wesight-xhs-status${spinning ? ' is-loading' : ''}` });
    const icon = status.createSpan();
    setIcon(icon, iconName);
    status.createSpan({ text });
  }

  private renderError(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-xhs-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    error.createSpan({ text: this.error });
    const dismiss = error.createEl('button', { attr: { type: 'button', 'aria-label': '关闭错误提示' } });
    setIcon(dismiss, 'x');
    dismiss.onclick = () => {
      this.error = '';
      this.render();
    };
  }

  private currentPageContent(): XhsPageContent | null {
    if (this.pageContents.length !== this.pageCount) {
      this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
    }
    return this.pageContents[this.selectedPreviewPage] ?? this.pageContents[0] ?? null;
  }

  private refreshPageContentVisual(page: XhsPageContent): void {
    const thumb = this.contentEl.querySelector<HTMLElement>(
      `[data-xhs-page-number="${page.pageNumber}"]`,
    );
    thumb?.querySelector<HTMLElement>('.wesight-xhs-thumb-text')?.setText(page.text || page.label);
    if (page.pageNumber !== this.selectedPreviewPage + 1) return;

    const preview = this.contentEl.querySelector<HTMLElement>('.wesight-xhs-live-preview');
    if (!preview) return;
    if (this.style.categoryId === 'typography') {
      let canvas = preview.querySelector<HTMLCanvasElement>('.wesight-xhs-typography-preview');
      if (!canvas) {
        preview.empty();
        preview.removeClass('has-generated-image');
        canvas = preview.createEl('canvas', {
          cls: 'wesight-xhs-typography-preview',
          attr: {
            width: '540',
            height: '720',
            role: 'img',
            'aria-label': `${getXhsTypographyTemplate(this.style.styleId).label}文字排版预览`,
          },
        });
      }
      const input = buildXhsTypographyPageInput(
        page.text,
        page.pageNumber,
        this.pageCount,
      );
      void renderXhsTypographyTemplate(canvas, this.style.styleId, input).catch(error => {
        if (!canvas?.isConnected) return;
        canvas.replaceWith(this.createTypographyPreviewError(error));
      });
      return;
    }

    let overlay = preview.querySelector<HTMLElement>('.wesight-xhs-preview-overlay');
    if (!overlay) {
      preview.empty();
      preview.removeClass('has-generated-image');
      preview.createEl('img', {
        cls: 'wesight-xhs-preview-texture',
        attr: { src: CATEGORY_THUMBNAILS[this.style.categoryId], alt: '' },
      });
      overlay = preview.createDiv({ cls: 'wesight-xhs-preview-overlay' });
      overlay.createDiv({ cls: 'wesight-xhs-preview-text' });
    }
    overlay.querySelector<HTMLElement>('.wesight-xhs-preview-text')
      ?.setText(page.text || '图片文字会在这里按照所选样式排版。');
  }

  private chooseStyle(style: XhsStyleChoice): void {
    if (this.operation) return;
    const changed = this.style.categoryId !== style.categoryId || this.style.styleId !== style.styleId;
    const involvesTypography = this.style.categoryId === 'typography' || style.categoryId === 'typography';
    this.style = style;
    if (changed && involvesTypography) this.generatedPages = [];
    this.scheduleDraftSave();
    this.render();
  }

  private setPageContentSource(
    source: XhsPageContentSource,
  ): void {
    const page = this.currentPageContent();
    if (!page) return;
    page.textSource = source;
    if (source === 'article') {
      const fallback = createDefaultXhsPageContents(this.copy, this.pageCount)[page.pageNumber - 1];
      if (fallback) page.text = fallback.text;
    }
    this.generatedPages = [];
    this.scheduleDraftSave();
    this.render();
    if (source === 'ai') {
      void this.regenerateCurrentPageContent();
      return;
    }
    if (source === 'manual') {
      window.requestAnimationFrame(() => {
        this.contentEl
          .querySelector<HTMLTextAreaElement>('[data-xhs-page-field="text"]')
          ?.focus();
      });
    }
  }

  private async refineRecommendation(silent: boolean): Promise<void> {
    if (!this.snapshot || this.recommendationRunning || this.operation) return;
    const epoch = this.memberAccessEpoch;
    if (silent) {
      // Restored workspaces must not start paid AI work or show a recharge dialog.
      if (!hasActiveMembership(this.options.auth)) return;
      const userId = this.options.auth.getCurrentUser()?.userId;
      try {
        await this.options.auth.refreshBillingSummary(false);
      } catch {
        return;
      }
      if (epoch !== this.memberAccessEpoch || this.options.auth.getCurrentUser()?.userId !== userId
        || !hasActiveMembership(this.options.auth)) return;
    } else if (!await this.requireMembership('转为图文')) {
      return;
    }
    this.recommendationController?.abort();
    this.recommendationController = new AbortController();
    this.recommendationRunning = true;
    this.recommendationNote = '';
    this.render();
    try {
      const recommendation = await this.options.generationService.recommend(
        this.snapshot,
        this.recommendationController.signal,
      );
      this.recommendation = recommendation;
      this.recommendationNote = '已由当前引擎结合文章结构与文案内容分析';
      await this.saveDraft();
    } catch (error) {
      if (this.recommendationController.signal.aborted) return;
      this.recommendationNote = '当前引擎分析未完成，已保留本地结构推荐';
      if (!silent) this.error = error instanceof Error ? error.message : '风格分析失败';
    } finally {
      this.recommendationRunning = false;
      this.render();
    }
  }

  private applyRecommendation(): void {
    if (!this.recommendation) return;
    this.chooseStyle({
      categoryId: this.recommendation.categoryId,
      styleId: this.recommendation.styleId,
    });
  }

  private renderQuickMembershipNotice(parent: HTMLElement): void {
    const notice = parent.createDiv({
      cls: 'wesight-quick-membership-notice',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    const icon = notice.createSpan({ cls: 'wesight-quick-membership-icon' });
    setIcon(icon, 'crown');
    const copy = notice.createDiv({ cls: 'wesight-quick-membership-copy' });
    copy.createEl('strong', { text: '转为图文，会员专享' });
    copy.createEl('p', { text: '转为图文和多平台发布需要有效会员，请充值开通或续费后使用。' });
    const actions = notice.createDiv({ cls: 'wesight-quick-membership-actions' });
    const dismiss = actions.createEl('button', {
      text: '稍后再说', attr: { type: 'button' },
    });
    dismiss.onclick = () => {
      this.quickMembershipNotice = false;
      notice.remove();
      this.contentEl.querySelector<HTMLButtonElement>('.wesight-quick-platform-list .is-selected')?.focus();
    };
    const learn = actions.createEl('button', {
      cls: 'wesight-quick-membership-learn', text: '去充值会员', attr: { type: 'button' },
    });
    setIcon(learn.createSpan(), 'arrow-right');
    learn.onclick = () => {
      // Returning from membership settings must not expand the current selection.
      this.quickTargetsExplicit = true;
      this.scheduleDraftSave();
      this.quickMembershipReturnPending = true;
      this.options.auth.openBilling();
    };
  }

  private initializeQuickState(saved: XhsDraftRecord | null): void {
    if (!this.snapshot || this.quickStateSourcePath === this.snapshot.sourcePath) return;
    this.quickStateSourcePath = this.snapshot.sourcePath;
    const articleImages = this.quickArticleImages();
    const recommended = recommendQuickTransformImageIds(articleImages, 3);
    this.quickRecommendedImageIds = new Set(recommended);
    const savedImageIds = saved?.quickTransform?.selectedImageIds;
    this.quickSelectedImageIds = Array.isArray(savedImageIds)
      ? reconcileQuickTransformImageIds(
        savedImageIds,
        [...articleImages, ...this.quickGeneratedImages()],
      )
      : recommended;
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    this.quickTargetsExplicit = hasExplicitQuickTransformPlatformSelection(saved?.quickTransform);
    const restoredTargets = restoreQuickTransformPlatformIds(
      this.quickTargetsExplicit ? saved?.quickTransform?.targets : undefined,
      access.state,
    );
    this.quickMembershipNotice = false;
    this.quickTargets = new Set(restoredTargets);
    this.quickCopyMode = saved?.quickTransform?.copyMode === 'shared' ? 'shared' : 'platform';
    const savedXCopy = saved?.quickTransform?.xPostCopy;
    this.quickXPostCopy = savedXCopy && typeof savedXCopy.body === 'string'
      ? { body: savedXCopy.body, topics: normalizeXPostTopics(Array.isArray(savedXCopy.topics) ? savedXCopy.topics.filter((topic): topic is string => typeof topic === 'string') : []) }
      : { body: '', topics: [] };
    const savedPreviewPlatform = saved?.quickTransform?.previewPlatform;
    this.quickPreviewPlatform = savedPreviewPlatform && this.quickTargets.has(savedPreviewPlatform)
      ? savedPreviewPlatform
      : QUICK_TRANSFORM_PLATFORM_IDS.find(platformId => this.quickTargets.has(platformId))
      ?? 'xiaohongshu';
    this.quickCompleted = 0;
    this.quickPlatformStatus = {};
    this.quickErrors = {};
    this.clearQuickPublishTask();
  }

  private quickGenerationReady(): boolean {
    return !this.quickOperation
      && this.quickTargets.size > 0
      && this.quickCompleted === this.quickTargets.size
      && Array.from(this.quickTargets).every(platformId => !this.quickErrors[platformId]);
  }

  private clearQuickPublishTask(): void {
    const taskId = this.quickPublishTask?.taskId;
    this.quickPublishTask = null;
    if (!taskId) return;
    if (this.publishTask?.taskId === taskId) this.publishTask = null;
    this.weiboPostWorkbench.setQuickPublishTask(null);
    this.jikePostWorkbench.setQuickPublishTask(null);
  }

  private resetQuickGeneration(): void {
    this.quickCompleted = 0;
    this.quickPlatformStatus = {};
    this.quickErrors = {};
    this.clearQuickPublishTask();
  }

  private enforceQuickTargetAccess(): void {
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    if (access.maxTargets === null || this.quickTargets.size <= access.maxTargets) return;
    const first = QUICK_TRANSFORM_PLATFORM_IDS.find(platformId => this.quickTargets.has(platformId));
    this.quickTargets = new Set(first ? [first] : []);
    if (first) this.quickPreviewPlatform = first;
    this.resetQuickGeneration();
    this.scheduleDraftSave();
  }

  private reconcileQuickTargetAccess(): void {
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    if (!this.quickTargetsExplicit) {
      const targets = restoreQuickTransformPlatformIds(undefined, access.state);
      const changed = targets.length !== this.quickTargets.size
        || targets.some(platformId => !this.quickTargets.has(platformId));
      if (changed) {
        this.quickTargets = new Set(targets);
        this.quickPreviewPlatform = targets[0] ?? 'xiaohongshu';
        this.resetQuickGeneration();
        this.scheduleDraftSave();
      }
    }
    this.enforceQuickTargetAccess();
  }

  private quickArticleImages(): QuickTransformImage[] {
    if (!this.snapshot) return [];
    return quickTransformSourceImages(
      this.snapshot,
      vaultPath => this.options.vaultStore.getResourcePath(vaultPath),
    ).map(image => ({ ...image, source: 'article' as const }));
  }

  private quickGeneratedImages(): QuickTransformImage[] {
    const articlePaths = new Set(this.quickArticleImages().map(image => image.vaultPath));
    return this.generatedPages
      .filter(page => !articlePaths.has(page.vaultPath))
      .map(page => ({
        id: `generated:${page.id}`,
        vaultPath: page.vaultPath,
        fileName: page.fileName || page.vaultPath.split('/').pop() || `generated-${page.pageNumber}.png`,
        mimeType: page.mimeType,
        label: page.label || `生成图片 ${page.pageNumber}`,
        source: 'generated' as const,
        previewUrl: page.previewUrl,
      }));
  }

  private imageResourceUrl(image: { vaultPath: string; previewUrl?: string }): string {
    return image.previewUrl?.trim() || this.options.vaultStore.getResourcePath(image.vaultPath);
  }

  private async readPublishImage(reference: string): Promise<ArrayBuffer> {
    if (!this.snapshot) throw new Error('当前文章还没有加载完成');
    return readSnapshotAssetReference(
      this.snapshot,
      reference,
      vaultPath => this.app.vault.adapter.readBinary(vaultPath),
    );
  }

  private quickSelectedImages(): QuickTransformImage[] {
    const byId = new Map(
      [...this.quickArticleImages(), ...this.quickGeneratedImages()].map(image => [image.id, image]),
    );
    return this.quickSelectedImageIds
      .map(id => byId.get(id))
      .filter((image): image is QuickTransformImage => Boolean(image));
  }

  private toggleQuickTarget(platformId: QuickTransformPlatformId): void {
    if (this.quickOperation || this.quickPublishBusy) return;
    if (this.quickTargets.has(platformId)) {
      this.quickTargetsExplicit = true;
      this.quickMembershipNotice = false;
      this.quickTargets.delete(platformId);
      if (this.quickPreviewPlatform === platformId) {
        this.quickPreviewPlatform = QUICK_TRANSFORM_PLATFORM_IDS.find(candidate => this.quickTargets.has(candidate))
          ?? 'xiaohongshu';
      }
      this.resetQuickGeneration();
      this.scheduleDraftSave();
      this.render();
      return;
    }
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    const error = validateMultiPublishTargetCount(access, this.quickTargets.size + 1);
    if (error) {
      if (access.state === 'single-platform') {
        this.quickMembershipNotice = true;
        this.render();
        this.contentEl.querySelector<HTMLButtonElement>('.wesight-quick-membership-actions button')?.focus({ preventScroll: true });
      } else {
        new Notice(error);
        this.options.auth.startLogin();
      }
      return;
    }
    this.quickMembershipNotice = false;
    this.quickTargetsExplicit = true;
    this.quickTargets.add(platformId);
    if (this.quickTargets.size === 1) this.quickPreviewPlatform = platformId;
    this.resetQuickGeneration();
    this.scheduleDraftSave();
    this.render();
  }

  private toggleQuickImage(imageId: string): void {
    if (this.quickOperation) return;
    const selectedIndex = this.quickSelectedImageIds.indexOf(imageId);
    if (selectedIndex >= 0) {
      this.quickSelectedImageIds.splice(selectedIndex, 1);
    } else if (this.quickSelectedImageIds.length >= 9) {
      new Notice('图文动态最多选择 9 张图片');
      return;
    } else {
      this.quickSelectedImageIds.push(imageId);
    }
    this.resetQuickGeneration();
    this.scheduleDraftSave();
    this.render();
  }

  private moveQuickImage(sourceId: string, targetId: string): void {
    if (!sourceId || sourceId === targetId || this.quickOperation) return;
    const sourceIndex = this.quickSelectedImageIds.indexOf(sourceId);
    const targetIndex = this.quickSelectedImageIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = this.quickSelectedImageIds.splice(sourceIndex, 1);
    this.quickSelectedImageIds.splice(targetIndex, 0, source);
    this.resetQuickGeneration();
    this.scheduleDraftSave();
    this.render();
  }

  private openQuickImageStudio(typography: boolean): void {
    const selectedCount = this.quickSelectedImageIds.length;
    this.pageCount = Math.max(3, Math.min(9, selectedCount || 3));
    this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
    if (typography) this.style = { categoryId: 'typography', styleId: 'minimal' };
    this.activePlatform = 'xiaohongshu';
    this.activeSection = 'images';
    this.contentEl.scrollTop = 0;
    this.render();
    new Notice(typography ? '已打开文字配图，可选择版式后生成。' : '已打开图片工作台，可选择风格后生成。');
  }

  private async generateQuickTransform(): Promise<void> {
    if (!this.snapshot || this.quickOperation) return;
    if (!await this.requireMembership('转为图文')) return;
    const targets = Array.from(this.quickTargets);
    if (!targets.length) {
      new Notice('请至少选择一个平台');
      return;
    }
    const user = this.options.auth.getCurrentUser();
    const billing = this.options.auth.getBillingSummary();
    const access = resolveMultiPublishAccess(user, billing);
    const accessError = validateMultiPublishTargetCount(access, targets.length);
    if (accessError) {
      this.quickMembershipNotice = access.state === 'single-platform';
      this.quickTargets = new Set(targets);
      this.enforceQuickTargetAccess();
      this.render();
      return;
    }
    this.quickTargets = new Set(targets);
    const images = this.quickSelectedImages();
    if (!images.length) {
      new Notice('请至少选择一张图片');
      return;
    }

    this.generationController?.abort();
    this.generationController = new AbortController();
    const signal = this.generationController.signal;
    this.quickOperation = true;
    this.quickCompleted = 0;
    this.quickErrors = {};
    this.quickPlatformStatus = Object.fromEntries(
      targets.map(platformId => [platformId, 'generating']),
    );
    this.clearQuickPublishTask();
    this.render();

    const weiboImages: WeiboPostImage[] = images.map(image => ({
      id: image.id,
      vaultPath: image.vaultPath,
      fileName: image.fileName,
      mimeType: image.mimeType,
      label: image.label,
      source: image.source === 'article' ? 'article' : 'xiaohongshu',
      size: image.size,
      previewUrl: image.previewUrl,
    }));
    const jikeImages: JikePostImage[] = images.map(image => ({
      id: image.id,
      vaultPath: image.vaultPath,
      fileName: image.fileName,
      mimeType: image.mimeType,
      label: image.label,
      source: image.source === 'article' ? 'article' : 'xiaohongshu',
      size: image.size,
      previewUrl: image.previewUrl,
    }));
    const applyXiaohongshuDraft = async (copy: XhsCopyDraft): Promise<void> => {
      this.copy = copy;
      this.pageCount = images.length;
      this.pageContents = reconcileXhsPageContents(copy, this.pageCount, undefined);
      this.generatedPages = images.map((image, index) => ({
        id: image.id,
        type: 'image' as const,
        vaultPath: image.vaultPath,
        mimeType: image.mimeType,
        createdAt: Date.now(),
        pageNumber: index + 1,
        label: image.label,
        fileName: image.fileName,
        previewUrl: image.previewUrl,
      }));
      await this.saveDraft();
    };

    if (this.quickCopyMode === 'shared') {
      try {
        const sharedCopy = await this.options.generationService.generateCopy(
          this.snapshot,
          sharedCopyRequirement(this.copyRequirement),
          signal,
        );
        if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');

        await Promise.all(targets.map(async platformId => {
          try {
            if (platformId === 'xiaohongshu') await applyXiaohongshuDraft(sharedCopy);
            if (platformId === 'weibo-post') {
              await this.weiboPostWorkbench.setQuickDraft(
                sharedCopyToWeibo(sharedCopy, this.weiboPostWorkbench.getQuickCopy()),
                weiboImages,
              );
            }
            if (platformId === 'jike-post') {
              await this.jikePostWorkbench.setQuickDraft(
                sharedCopyToJike(sharedCopy, this.jikePostWorkbench.getQuickCopy()),
                jikeImages,
              );
            }
            if (platformId === 'x-post') {
              const sharedX = { body: sharedCopy.body, topics: normalizeXPostTopics(sharedCopy.tags) };
              this.quickXPostCopy = validateXPostCopy(sharedX)
                ? await this.options.generationService.generateXPostCopy(this.snapshot!, [this.copyRequirement, `请围绕这套统一文案的核心观点生成 X 精简版：\n${sharedCopy.body}`].filter(Boolean).join('\n'), signal)
                : sharedX;
              await this.saveDraft();
            }
            this.quickPlatformStatus[platformId] = 'ready';
          } catch (error) {
            this.quickErrors[platformId] = error instanceof Error
              ? error.message
              : `${QUICK_PLATFORM_COPY[platformId].label}草稿保存失败`;
            this.quickPlatformStatus[platformId] = 'failed';
          } finally {
            this.quickCompleted += 1;
            this.render();
          }
        }));
      } catch (error) {
        if (!signal.aborted) {
          const message = error instanceof Error ? error.message : '统一文案生成失败';
          for (const platformId of targets) {
            this.quickErrors[platformId] = message;
            this.quickPlatformStatus[platformId] = 'failed';
          }
          this.quickCompleted = targets.length;
        }
      }
      this.quickOperation = false;
      if (!signal.aborted) {
        const failed = Object.keys(this.quickErrors).length;
        if (failed) {
          this.quickErrors.general = `${failed} 个平台生成失败，已完成的平台可以继续编辑。`;
        } else {
          new Notice(`统一文案已同步到 ${targets.length} 个平台。`);
        }
      }
      this.render();
      return;
    }

    const tasks = targets.map(async platformId => {
      try {
        if (platformId === 'xiaohongshu') {
          const copy = await this.options.generationService.generateCopy(
            this.snapshot!,
            this.copyRequirement,
            signal,
          );
          if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
          await applyXiaohongshuDraft(copy);
        }
        if (platformId === 'weibo-post') {
          await this.weiboPostWorkbench.prepareQuickDraft(weiboImages, signal);
        }
        if (platformId === 'jike-post') {
          await this.jikePostWorkbench.prepareQuickDraft(jikeImages, signal);
        }
        if (platformId === 'x-post') {
          this.quickXPostCopy = await this.options.generationService.generateXPostCopy(this.snapshot!, this.copyRequirement, signal);
          if (signal.aborted) throw new DOMException('已停止生成', 'AbortError');
          await this.saveDraft();
        }
        this.quickPlatformStatus[platformId] = 'ready';
      } catch (error) {
        if (signal.aborted) return;
        this.quickErrors[platformId] = error instanceof Error ? error.message : `${QUICK_PLATFORM_COPY[platformId].label}生成失败`;
        this.quickPlatformStatus[platformId] = 'failed';
      } finally {
        if (!signal.aborted) {
          this.quickCompleted += 1;
          this.render();
        }
      }
    });

    await Promise.all(tasks);
    this.quickOperation = false;
    if (!signal.aborted) {
      const failed = Object.keys(this.quickErrors).length;
      if (failed) {
        this.quickErrors.general = `${failed} 个平台生成失败，已完成的平台可以继续编辑。`;
      } else {
        new Notice(`已生成 ${targets.length} 个平台的图文内容。`);
      }
    }
    this.render();
  }

  private async startQuickPublish(forcePair: boolean): Promise<void> {
    if (!this.snapshot || this.quickPublishBusy || !this.quickGenerationReady()) return;
    if (!await this.requireMembership('转为图文和多平台发布')) return;
    if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector, forcePair)) return;
    const targets = Array.from(this.quickTargets);
    this.quickPublishBusy = true;
    delete this.quickErrors.general;
    this.render();
    try {
      const user = this.options.auth.getCurrentUser();
      const billing = this.options.auth.getBillingSummary();
      const access = resolveMultiPublishAccess(user, billing);
      const accessError = validateMultiPublishTargetCount(access, targets.length);
      if (accessError) {
        this.quickMembershipNotice = access.state === 'single-platform';
        this.quickTargets = new Set(targets);
        this.enforceQuickTargetAccess();
        return;
      }
      this.quickTargets = new Set(targets);
      const connection = this.options.bridge.getConnectionState();
      if (connection.connected && connection.supportedPlatforms !== null) {
        const unsupported = targets.find(platformId => !connection.supportedPlatforms!.includes(platformId));
        if (unsupported) throw new Error(`发布助手还不支持${QUICK_PLATFORM_COPY[unsupported].label}，请更新扩展后重试`);
      }
      if (connection.connected
        && connection.capabilities !== null
        && [QUICK_PUBLISH_CAPABILITY, 'compose-v1', DYNAMIC_COMPOSE_CAPABILITY]
          .some(capability => !connection.capabilities!.includes(capability))) {
        throw new Error('发布助手版本过旧，请更新并重新加载扩展后使用动态发布中心');
      }

      const snapshots: QuickPublishSnapshotMap = {};
      await Promise.all(targets.map(async platformId => {
        if (platformId === 'xiaohongshu') {
          await this.saveDraft();
          snapshots[platformId] = await buildXiaohongshuPublishSnapshot({
            source: this.snapshot!,
            copy: this.copy,
            pageCount: this.pageCount,
            pages: this.generatedPages,
            readBinary: reference => this.readPublishImage(reference),
          });
          return;
        }
        if (platformId === 'weibo-post') {
          snapshots[platformId] = await this.weiboPostWorkbench.buildQuickPublishSnapshot();
          return;
        }
        if (platformId === 'x-post') {
          await this.saveDraft();
          snapshots[platformId] = await buildXPostPublishSnapshot({
            source: this.snapshot!, copy: this.quickXPostCopy, images: this.quickSelectedImages(),
            readBinary: reference => this.readPublishImage(reference),
          });
          return;
        }
        snapshots[platformId] = await this.jikePostWorkbench.buildQuickPublishSnapshot();
      }));

      const batchSnapshot = buildQuickPublishBatchSnapshot(targets, snapshots);
      const result = this.options.bridge.createDynamicComposeTask(batchSnapshot, targets, access, forcePair);
      if (result.task.targets.length !== targets.length
        || targets.some(platformId => !result.task.targets.includes(platformId))) {
        throw new Error('发布任务的平台数量与当前选择不一致，请重新生成后重试');
      }
      this.quickPublishTask = result.task;
      window.open(result.handoffUrl, '_blank', 'noopener,noreferrer');
      new Notice(`已打开动态发布中心，带入 ${targets.length} 套平台文案和图片，请在浏览器中选择平台并同步。`);
    } catch (error) {
      this.quickErrors.general = error instanceof Error ? error.message : '多平台发布任务启动失败';
    } finally {
      this.quickPublishBusy = false;
      this.render();
    }
  }

  private async openQuickPublishTask(): Promise<void> {
    if (!this.quickPublishTask) return;
    if (!await this.requireMembership('浏览器发布助手')) return;
    if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
    try {
      const url = this.options.bridge.createOpenTaskUrl(this.quickPublishTask.taskId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.quickErrors.general = error instanceof Error ? error.message : '打开动态发布中心失败';
      this.render();
    }
  }

  private quickErrorSummary(): string {
    return QUICK_TRANSFORM_PLATFORM_IDS
      .filter(platformId => Boolean(this.quickErrors[platformId]))
      .map(platformId => `${QUICK_PLATFORM_COPY[platformId].label}：${this.quickErrors[platformId]}`)
      .join(' · ');
  }

  private async generateCopy(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    if (!await this.requireMembership('转为图文')) return;
    this.generationController?.abort();
    this.generationController = new AbortController();
    this.operation = 'copy';
    this.error = '';
    this.render();
    try {
      this.copy = await this.options.generationService.generateCopy(
        this.snapshot,
        this.copyRequirement,
        this.generationController.signal,
      );
      this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, undefined);
      this.generatedPages = [];
      await this.saveDraft();
      new Notice('小红书文案已生成，可继续手动调整。');
    } catch (error) {
      if (this.generationController.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '文案生成失败';
    } finally {
      this.operation = null;
      this.render();
    }
  }

  private async generatePageContents(): Promise<void> {
    if (!this.snapshot || this.operation) return;
    if (!await this.requireMembership('转为图文')) return;
    this.generationController?.abort();
    this.generationController = new AbortController();
    this.operation = 'pageContents';
    this.error = '';
    this.render();
    try {
      this.pageContents = await this.options.generationService.generatePageContents(
        this.snapshot,
        this.copy,
        this.pageCount,
        this.generationController.signal,
      );
      this.generatedPages = [];
      await this.saveDraft();
      new Notice(`已生成并保存 ${this.pageContents.length} 张图片内容。`);
    } catch (error) {
      if (this.generationController.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '逐页内容生成失败';
    } finally {
      this.operation = null;
      this.render();
    }
  }

  private async regenerateCurrentPageContent(): Promise<void> {
    const current = this.currentPageContent();
    if (!this.snapshot || !current || this.operation) return;
    if (!await this.requireMembership('转为图文')) return;
    this.generationController?.abort();
    this.generationController = new AbortController();
    this.operation = 'pageContent';
    this.error = '';
    this.render();
    try {
      const page = await this.options.generationService.regeneratePageContent(
        this.snapshot,
        this.copy,
        current,
        this.pageCount,
        this.generationController.signal,
      );
      this.pageContents = this.pageContents.map(existing => (
        existing.pageNumber === page.pageNumber ? page : existing
      ));
      this.generatedPages = [];
      await this.saveDraft();
      new Notice(`第 ${page.pageNumber} 张内容已重新生成。`);
    } catch (error) {
      if (this.generationController.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '当前页面内容生成失败';
    } finally {
      this.operation = null;
      this.render();
    }
  }

  private async generateImages(onlyPage?: number): Promise<void> {
    if (!this.snapshot || this.operation) return;
    if (!await this.requireMembership('转为图文')) return;
    this.generationController?.abort();
    this.generationController = new AbortController();
    const controller = this.generationController;
    const snapshot = this.snapshot;
    const isAi = this.style.categoryId !== 'typography';
    const total = onlyPage ? 1 : this.pageCount;
    this.aiPendingPages = new Set(onlyPage ? [onlyPage] : Array.from({ length: this.pageCount }, (_, index) => index + 1));
    this.operation = 'images';
    this.error = '';
    this.imageProgress = { completed: 0, total, label: '正在准备图片任务…' };
    this.render();
    try {
      this.pageContents = reconcileXhsPageContents(this.copy, this.pageCount, this.pageContents);
      const generationContents = isAi ? createDefaultXhsPageContents(this.copy, this.pageCount) : this.pageContents;
      if (isAi && onlyPage) {
        const previous = this.generatedPages.find(page => page.pageNumber === onlyPage)?.generationContent;
        if (previous) generationContents[onlyPage - 1] = { ...previous, pageNumber: onlyPage };
      }
      const withGenerationContent = (page: XhsGeneratedPage): XhsGeneratedPage => isAi
        ? { ...page, generationContent: generationContents.find(content => content.pageNumber === page.pageNumber) }
        : page;
      const referenceImages = isAi ? await Promise.all(this.imageReferences.map(async reference => {
        const body = await this.readPublishImage(reference.vaultPath);
        if (body.byteLength > 10 * 1024 * 1024) throw new Error(`参考图 ${reference.fileName} 超过 10 MB`);
        return { fileName: reference.fileName, mimeType: reference.mimeType, body };
      })) : [];
      if (controller.signal.aborted || this.snapshot !== snapshot) return;
      const pages = await this.options.generationService.generateImages({
        draftId: `xiaohongshu-${this.snapshot.contentHash.slice(0, 16)}`,
        copy: this.copy,
        pageContents: onlyPage ? generationContents.filter(page => page.pageNumber === onlyPage) : generationContents,
        pageCount: this.pageCount,
        imageRatio: this.imageRatio,
        referenceImages,
        sourceMarkdown: snapshot.markdown,
        style: this.style,
        customStylePrompt: this.customStylePrompt,
        signal: controller.signal,
        onPage: isAi ? page => {
          if (controller.signal.aborted || this.snapshot !== snapshot) return;
          this.generatedPages = [...this.generatedPages.filter(item => item.pageNumber !== page.pageNumber), withGenerationContent(page)].sort((a, b) => a.pageNumber - b.pageNumber);
          this.aiPendingPages.delete(page.pageNumber);
          this.scheduleDraftSave();
        } : undefined,
        onProgress: progress => {
          if (controller.signal.aborted || this.snapshot !== snapshot) return;
          this.imageProgress = progress;
          this.render();
        },
      });
      if (controller.signal.aborted || this.snapshot !== snapshot) return;
      this.generatedPages = onlyPage
        ? [...this.generatedPages.filter(page => page.pageNumber !== onlyPage), ...pages.map(withGenerationContent)].sort((a, b) => a.pageNumber - b.pageNumber)
        : pages.map(withGenerationContent);
      this.quickSelectedImageIds = reconcileQuickTransformImageIds(
        [
          ...this.quickSelectedImageIds,
          ...pages.map(page => `generated:${page.id}`),
        ],
        [...this.quickArticleImages(), ...this.quickGeneratedImages()],
      );
      this.selectedPreviewPage = 0;
      this.activeSection = isAi ? 'images' : 'review';
      this.contentEl.scrollTop = 0;
      await this.saveDraft();
      new Notice(`已生成 ${pages.length} 张小红书图片。`);
    } catch (error) {
      if (controller.signal.aborted || this.snapshot !== snapshot) return;
      this.error = error instanceof Error ? error.message : '图片生成失败';
    } finally {
      if (this.generationController === controller) {
        this.aiPendingPages.clear();
        this.imageProgress = null;
        this.operation = null;
        this.render();
      }
    }
  }

  private scheduleDraftSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveDraft();
    }, 500);
  }

  private switchPlatform(platform: ContentPlatformId): void {
    if (platform === this.activePlatform) return;
    if (this.activePlatform === 'xiaohongshu') void this.saveDraft();
    if (this.activePlatform === 'weibo-post') void this.weiboPostWorkbench.save();
    if (this.activePlatform === 'jike-post') void this.jikePostWorkbench.save();
    this.activePlatform = platform;
    this.activeSection = 'copy';
    this.contentEl.scrollTop = 0;
    this.render();
  }

  private showSection(section: XhsWorkbenchSection): void {
    this.activeSection = section;
    this.contentEl.scrollTop = 0;
    this.render();
  }

  private async refreshPublishAuth(): Promise<void> {
    if (this.publishAuthLoading) return;
    if (this.options.auth.getCurrentUser() && this.options.auth.getBillingSummary()) {
      this.reconcileQuickTargetAccess();
      return;
    }
    this.publishAuthLoading = true;
    this.render();
    try {
      const user = this.options.auth.getCurrentUser() ?? await this.options.auth.restoreSession();
      if (user && !this.options.auth.getBillingSummary()) {
        await this.options.auth.refreshBillingSummary(false).catch(() => null);
      }
      if (user) this.publishLoginPending = false;
      if (user && this.options.auth.getBillingSummary()) this.reconcileQuickTargetAccess();
    } finally {
      this.publishAuthLoading = false;
      this.render();
    }
  }

  private async startXiaohongshuPublish(forcePair: boolean): Promise<void> {
    if (!this.snapshot || this.publishBusy) return;
    if (!await this.requireMembership('浏览器发布助手')) return;
    if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector, forcePair)) return;
    const validationErrors = validateXiaohongshuPublishInput(this.copy, this.pageCount, this.generatedPages);
    if (validationErrors.length) {
      new Notice(validationErrors[0]);
      return;
    }
    this.publishBusy = true;
    this.error = '';
    this.render();
    try {
      const user = await this.options.auth.restoreSession();
      if (!user) {
        new Notice(MULTI_PUBLISH_LOGIN_PROMPT);
        this.options.auth.startLogin();
        this.publishLoginPending = true;
        return;
      }
      await this.saveDraft();
      const publishSnapshot = await buildXiaohongshuPublishSnapshot({
        source: this.snapshot,
        copy: this.copy,
        pageCount: this.pageCount,
        pages: this.generatedPages,
        readBinary: reference => this.readPublishImage(reference),
      });
      const result = this.options.bridge.createTask(publishSnapshot, ['xiaohongshu'], forcePair);
      this.publishTask = result.task;
      window.open(result.handoffUrl, '_blank', 'noopener,noreferrer');
      new Notice('已交给 WeSight 发布助手准备小红书图文。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '小红书发布任务启动失败';
    } finally {
      this.publishBusy = false;
      this.render();
    }
  }

  private async retryXiaohongshuTask(): Promise<void> {
    if (!this.publishTask) return;
    if (!await this.requireMembership('浏览器发布助手')) return;
    if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
    try {
      const url = this.options.bridge.createRetryUrl(this.publishTask.taskId, 'xiaohongshu');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '重试小红书发布任务失败';
      this.render();
    }
  }

  private async openXiaohongshuTask(): Promise<void> {
    if (!this.publishTask) return;
    if (!await this.requireMembership('浏览器发布助手')) return;
    if (!requireBrowserConnection(this.options.bridge, this.options.openBrowserConnector)) return;
    try {
      const url = this.options.bridge.createOpenUrl(this.publishTask.taskId, 'xiaohongshu');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '打开小红书编辑页失败';
      this.render();
    }
  }

  private openChromeExtensions(): void { this.options.openBrowserConnector(); }

  private async saveDraft(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.snapshot || !this.recommendation) return;
    const record: XhsDraftRecord = {
      version: 1,
      sourcePath: this.snapshot.sourcePath,
      contentHash: this.snapshot.contentHash,
      updatedAt: new Date().toISOString(),
      copy: this.copy,
      style: this.style,
      recommendation: this.recommendation,
      customStylePrompt: this.customStylePrompt,
      imageRatio: this.imageRatio,
      imageReferences: this.imageReferences,
      pageCount: this.pageCount,
      pageContents: this.pageContents,
      pages: this.generatedPages,
      quickTransform: {
        targets: QUICK_TRANSFORM_PLATFORM_IDS.filter(platformId => this.quickTargets.has(platformId)),
        targetsExplicit: this.quickTargetsExplicit,
        copyMode: this.quickCopyMode,
        selectedImageIds: [...this.quickSelectedImageIds],
        previewPlatform: this.quickPreviewPlatform,
        xPostCopy: this.quickXPostCopy,
      },
    };
    await this.options.draftStore.save(record);
  }

  private async copyFullDraft(): Promise<void> {
    const text = [
      this.copy.title,
      '',
      this.copy.body,
      '',
      this.copy.tags.map(tag => `#${tag}`).join(' '),
    ].join('\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      new Notice('完整文案已复制。');
    } catch {
      this.error = '复制失败，请检查系统剪贴板权限。';
      this.render();
    }
  }
}

function engineLabel(agentId: WeSightObsidianSettings['defaultAgentId']): string {
  if (agentId === 'claude') return 'Claude Code';
  if (agentId === 'codex') return 'Codex';
  return 'OpenCode';
}
