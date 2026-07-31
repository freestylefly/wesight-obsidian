import {
  ItemView,
  MarkdownView,
  Notice,
  setIcon,
  TFile,
  type ViewStateResult,
  WorkspaceLeaf,
} from 'obsidian';

import { CloudAuthService } from '../share/cloudAuth';
import { CloudApiError } from '../share/cloudApi';
import { WeChatCloudApi } from '../wechat/cloudApi';
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
import { recordValue } from '../utils/records';
import { confirmShareAction } from './shareConfirm';

export const WESIGHT_WECHAT_PREVIEW_VIEW_TYPE = 'wesight-wechat-preview';

interface WeChatPreviewViewOptions {
  auth: CloudAuthService;
  api: WeChatCloudApi;
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
  private duplicatePath: string | null = null;
  private staleDraft = false;
  private acknowledgedWarnings = false;
  private titleValue = '';
  private authorValue = '';
  private digestValue = '';
  private temporaryCover: WeChatAssetDraft | null = null;
  private refreshTimer: number | null = null;

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
    this.clearTemporaryCover();
  }

  override getState(): Record<string, unknown> {
    return { filePath: this.file?.path ?? null };
  }

  override async setState(
    state: Record<string, unknown>,
    result: ViewStateResult,
  ): Promise<void> {
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    if (file instanceof TFile) this.file = file;
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
    const title = header.createDiv();
    title.createEl('strong', { text: '公众号预览' });
    title.createSpan({ text: this.file?.basename ?? '当前笔记' });
    const refresh = header.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': '刷新公众号排版' },
    });
    setIcon(refresh, 'refresh-cw');
    refresh.disabled = this.loading || Boolean(this.operation);
    refresh.onclick = () => void this.reload();
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
    error.createEl('strong', { text: '预览生成失败' });
    error.createEl('p', { text: this.error ?? '请稍后重试。' });
    const retry = error.createEl('button', { text: '重新生成' });
    retry.onclick = () => void this.reload();
  }

  private renderEditor(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    const controls = parent.createDiv({ cls: 'wesight-wechat-preview-controls' });
    const account = controls.createDiv({ cls: 'wesight-wechat-preview-account' });
    const logo = account.createDiv({ cls: 'wesight-wechat-logo' });
    logo.createSpan({ text: '微' });
    const accountCopy = account.createDiv();
    accountCopy.createEl('strong', { text: this.connection?.displayName ?? '微信公众号' });
    accountCopy.createSpan({ text: 'Canghe Style · Atom One Dark' });

    this.renderMetadataFields(controls);
    this.renderCover(controls, snapshot);
    this.renderWarnings(controls, snapshot);
    if (this.duplicatePath) {
      this.renderBanner(
        controls,
        'circle-alert',
        `另一篇笔记“${this.duplicatePath}”关联了同一篇公众号草稿，本次只能另存为新草稿。`,
      );
    } else if (this.staleDraft) {
      this.renderBanner(
        controls,
        'circle-alert',
        '原公众号草稿已删除、已发布或失效，本次将创建新草稿。',
      );
    }

    const canvasWrap = parent.createDiv({ cls: 'wesight-wechat-preview-canvas-wrap' });
    const canvas = canvasWrap.createDiv({ cls: 'wesight-wechat-preview-canvas' });
    const article = canvas.createDiv({ cls: 'wesight-wechat-preview-article' });
    void renderWeChatArticle(this.app, this, snapshot, article).catch((error) => {
      this.error = error instanceof Error ? error.message : '排版渲染失败';
      this.render();
    });

    const footer = parent.createDiv({ cls: 'wesight-wechat-preview-footer' });
    if (this.operation) {
      const progress = footer.createDiv({ cls: 'wesight-wechat-publish-progress' });
      const icon = progress.createSpan();
      setIcon(icon, 'loader-circle');
      progress.createSpan({ text: this.operation });
      return;
    }
    const prepared = this.preparedSnapshot();
    const unchanged = Boolean(this.draft && prepared.contentHash === this.draft.contentHash);
    const updateExisting = Boolean(this.draft && !this.duplicatePath && !this.staleDraft);
    const primary = footer.createEl('button', {
      cls: 'mod-cta wesight-wechat-publish-button',
      text: updateExisting ? '更新公众号草稿' : '同步到草稿箱',
    });
    primary.disabled = unchanged || (snapshot.warnings.some((warning) => warning.blocking) && !this.acknowledgedWarnings);
    primary.onclick = () => void this.publish(false);
    if (unchanged) {
      footer.createSpan({
        cls: 'wesight-wechat-unchanged',
        text: '公众号草稿已经是当前笔记的最新内容',
      });
    }
    if (this.draft) {
      const asNew = footer.createEl('button', {
        cls: 'wesight-wechat-secondary-action',
        text: '另存为新草稿',
      });
      asNew.disabled = snapshot.warnings.some((warning) => warning.blocking) && !this.acknowledgedWarnings;
      asNew.onclick = () => void this.publish(true);
    }
    if (this.draft) {
      const open = footer.createEl('button', {
        cls: 'wesight-wechat-link-button',
        text: '打开公众号后台',
      });
      open.onclick = () => window.open('https://mp.weixin.qq.com/', '_blank', 'noopener,noreferrer');
    }
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
    copy.createEl('strong', { text: '文章封面' });
    copy.createSpan({ text: this.coverDescription(snapshot) });
    const choose = row.createEl('button', { text: '更换封面' });
    choose.onclick = () => this.chooseTemporaryCover();
  }

  private renderWarnings(parent: HTMLElement, snapshot: WeChatPreviewSnapshot): void {
    if (!snapshot.warnings.length) return;
    const box = parent.createDiv({ cls: 'wesight-wechat-preview-warnings' });
    box.createEl('strong', { text: `发布前检查到 ${snapshot.warnings.length} 项内容` });
    const list = box.createEl('ul');
    for (const warning of snapshot.warnings) list.createEl('li', { text: warning.message });
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
    this.render();
    const hidden = document.body.createDiv({ cls: 'wesight-wechat-publish-render-host' });
    try {
      const uploadedUrls = new Map<string, string>();
      const contentAssets = snapshot.assets.filter((asset) => snapshot.markdown.includes(asset.token));
      for (let index = 0; index < contentAssets.length; index += 1) {
        const asset = contentAssets[index];
        this.operation = `正在上传正文图片 ${index + 1}/${contentAssets.length}…`;
        this.render();
        const result = await this.options.api.uploadAsset('content', asset);
        if (!result.url) throw new Error(`图片“${asset.fileName}”上传后没有返回地址`);
        uploadedUrls.set(asset.token, result.url);
      }

      this.operation = '正在生成 Canghe Style 正文…';
      this.render();
      const article = hidden.createDiv();
      await renderWeChatArticle(this.app, this, snapshot, article, uploadedUrls);
      await replaceFormulaSvgs(article, async (asset) => {
        this.operation = '正在上传公式图片…';
        this.render();
        const result = await this.options.api.uploadAsset('content', asset);
        if (!result.url) throw new Error('公式图片上传失败');
        return result.url;
      });
      const content = serializeWeChatArticle(article);
      const thumbMediaId = await this.resolveCoverMediaId(snapshot);
      const payload: WeChatDraftPayload = {
        title: snapshot.title,
        ...(snapshot.author ? { author: snapshot.author } : {}),
        ...(snapshot.digest ? { digest: snapshot.digest } : {}),
        content,
        contentHash: snapshot.contentHash,
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
