import { createHash } from 'crypto';
import { App, Notice, setIcon, TFile } from 'obsidian';

import { buildShareSnapshot } from '../share/snapshot';
import type { ShareSnapshot } from '../share/types';
import type { TencentDocsConnectionState, TencentDocsService } from '../tencentDocs/service';
import { confirmShareAction } from './shareConfirm';

interface TencentDocsSharePanelOptions {
  app: App;
  service: TencentDocsService;
  file: TFile;
  requestRender: () => void;
  requestPosition: () => void;
  openSettings: () => void;
}

interface PublishState {
  documentId: string;
  url: string;
  contentHash: string;
  title: string;
  updatedAt: string;
}

const DOC_ID = 'wesight-tencent-doc-id';
const DOC_URL = 'wesight-tencent-doc-url';
const CONTENT_HASH = 'wesight-tencent-content-hash';
const PUBLISHED_AT = 'wesight-tencent-published-at';
const TITLE = 'wesight-tencent-title';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function publishStateFrom(frontmatter: Record<string, unknown> | undefined): PublishState | null {
  const documentId = stringValue(frontmatter?.[DOC_ID]);
  const url = stringValue(frontmatter?.[DOC_URL]);
  if (!documentId || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.qq.com' || parsed.username || parsed.password) return null;
  } catch { return null; }
  return { documentId, url, contentHash: stringValue(frontmatter?.[CONTENT_HASH]), title: stringValue(frontmatter?.[TITLE]), updatedAt: stringValue(frontmatter?.[PUBLISHED_AT]) };
}

function snapshotHash(snapshot: ShareSnapshot, title: string): string {
  return createHash('sha256').update(JSON.stringify({
    title: title.trim(), markdown: snapshot.markdown,
    assets: snapshot.assets.map(asset => asset.contentHash).sort(),
  })).digest('hex');
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export class TencentDocsSharePanel {
  private disposed = false;
  private loading = false;
  private publishing = false;
  private operationLabel = '';
  private connection: TencentDocsConnectionState | null = null;
  private snapshot: ShareSnapshot | null = null;
  private error: string | null = null;
  private metadataError: string | null = null;
  private title = '';
  private titleInitialized = false;
  private publishState: PublishState | null = null;
  private duplicatePath: string | null = null;
  private updateSameDocument = true;

  constructor(private readonly options: TencentDocsSharePanelOptions) {}

  activate(): void {
    if (this.loading || this.publishing || this.disposed) return;
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
  }

  render(parent: HTMLElement): void {
    if (this.loading || this.publishing || !this.connection && !this.error) {
      const status = parent.createDiv({ cls: 'wesight-share-loading' });
      setIcon(status.createSpan(), 'loader-circle');
      status.createSpan({ text: this.publishing ? this.operationLabel : '正在检查腾讯文档连接状态…' });
      return;
    }

    const hero = parent.createDiv({ cls: 'wesight-feishu-hero' });
    setIcon(hero.createDiv({ cls: 'wesight-feishu-logo is-tencent-docs' }), 'file-text');
    const copy = hero.createDiv({ cls: 'wesight-feishu-hero-copy' });
    copy.createEl('strong', { text: this.connection?.connected ? '发布到腾讯文档' : '连接腾讯文档后分享笔记' });
    copy.createSpan({ text: this.connection?.connected ? this.connection.accountName || '腾讯文档已连接' : '在设置中完成连接后，即可将当前笔记创建为腾讯文档。' });

    if (this.error) parent.createDiv({ cls: 'wesight-connector-error', text: this.error, attr: { role: 'alert' } });
    if (!this.connection?.connected) {
      this.button(parent, '前往连接腾讯文档', 'plug-zap', () => this.options.openSettings(), true);
      this.button(parent, '重新检测', 'refresh-cw', () => void this.load());
      return;
    }
    if (!this.snapshot) {
      this.button(parent, '重新读取笔记', 'refresh-cw', () => void this.load());
      return;
    }

    if (this.publishState) {
      const link = parent.createEl('a', {
        cls: 'wesight-share-published-url',
        text: '打开已发布的腾讯文档',
        attr: { href: this.publishState.url, target: '_blank', rel: 'noopener noreferrer' },
      });
      setIcon(link.createSpan(), 'external-link');
      this.button(parent, '复制文档链接', 'copy', () => void this.copyPublishedUrl());
      const updatedAt = formatUpdatedAt(this.publishState.updatedAt);
      if (updatedAt) parent.createDiv({ cls: 'wesight-share-published-at', text: `最后发布于 ${updatedAt}` });
    }

    if (this.duplicatePath) {
      parent.createDiv({ cls: 'wesight-share-warning-note', text: `另一篇笔记“${this.duplicatePath}”关联了同一篇腾讯文档，请作为新文档发布。` });
      this.button(parent, '作为新的腾讯文档发布', 'copy-plus', () => void this.publish(true), true);
      this.button(parent, '管理腾讯文档连接', 'settings', () => this.options.openSettings());
      return;
    }

    const form = parent.createDiv({ cls: 'wesight-feishu-publish-form' });
    const label = form.createEl('label', { text: '文档标题' });
    const title = form.createEl('input', { attr: { id: 'wesight-tencent-docs-title', type: 'text', value: this.title, 'aria-label': '腾讯文档标题' } });
    label.htmlFor = title.id;
    const updateRow = form.createEl('label', { cls: 'wesight-feishu-checkbox-row' });
    const update = updateRow.createEl('input', { attr: { type: 'checkbox' } });
    update.checked = this.updateSameDocument;
    updateRow.createSpan({ text: '后续更新同一篇腾讯文档' });
    update.onchange = () => {
      this.updateSameDocument = update.checked;
      this.requestRender();
    };
    const updating = Boolean(this.publishState && this.updateSameDocument);
    form.createDiv({ cls: 'wesight-feishu-form-hint', text: updating ? '更新后保持当前腾讯文档链接不变。' : '将在腾讯文档中创建一篇新文档。' });
    if (this.snapshot.assets.length) form.createDiv({ cls: 'wesight-feishu-form-hint', text: `发布时将一并上传 ${this.snapshot.assets.length} 张本地图片。` });
    for (const warning of this.snapshot.warnings) form.createDiv({ cls: 'wesight-feishu-form-hint', text: warning });
    const publish = this.button(parent, updating ? '更新腾讯文档' : '发布到腾讯文档', updating ? 'refresh-cw' : 'send', () => void this.publish(), true);
    const status = parent.createDiv({ cls: 'wesight-feishu-current-note' });
    const refreshAction = () => {
      const unchanged = updating && this.publishState?.contentHash === snapshotHash(this.snapshot!, this.title);
      publish.disabled = !this.title.trim() || unchanged;
      status.setText(updating ? unchanged ? '腾讯文档已经是当前笔记的最新内容' : this.publishState?.contentHash ? '笔记有更新，可以同步到腾讯文档' : '此笔记已关联腾讯文档，可以更新原文档' : '');
    };
    title.oninput = () => {
      this.title = title.value;
      refreshAction();
    };
    refreshAction();
    if (this.publishState) this.button(parent, '创建新的腾讯文档', 'copy-plus', () => void this.publish(true));
    this.button(parent, '管理腾讯文档连接', 'settings', () => this.options.openSettings());
  }

  private async load(): Promise<void> {
    if (this.loading || this.publishing || this.disposed) return;
    this.loading = true;
    this.error = this.metadataError;
    this.requestRender();
    try {
      const [connection, snapshot] = await Promise.all([
        this.options.service.getConnectionState(),
        buildShareSnapshot(this.options.app, this.options.file),
      ]);
      if (this.disposed) return;
      this.connection = connection;
      this.snapshot = snapshot;
      if (!this.metadataError) this.publishState = publishStateFrom(this.options.app.metadataCache.getFileCache(this.options.file)?.frontmatter);
      this.duplicatePath = this.publishState ? this.findDuplicatePath(this.publishState.documentId) : null;
      if (!this.titleInitialized) {
        this.title = this.publishState?.title || snapshot.title;
        this.titleInitialized = true;
      }
      if (connection.status === 'error') this.error = connection.message;
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : '加载腾讯文档分享状态失败';
    } finally {
      if (!this.disposed) {
        this.loading = false;
        this.requestRender();
      }
    }
  }

  private async publish(asNew = false): Promise<void> {
    if (this.publishing || !this.connection?.connected || !this.title.trim() || this.disposed) return;
    const existing = !asNew && this.updateSameDocument ? this.publishState : null;
    const duplicatePath = existing ? this.findDuplicatePath(existing.documentId) : null;
    if (duplicatePath) {
      this.duplicatePath = duplicatePath;
      this.requestRender();
      return;
    }
    this.publishing = true;
    this.operationLabel = existing ? '正在更新腾讯文档…' : '正在发布到腾讯文档…';
    this.error = null;
    this.requestRender();
    try {
      const snapshot = await buildShareSnapshot(this.options.app, this.options.file);
      if (this.disposed) return;
      this.snapshot = snapshot;
      const title = this.title.trim();
      const confirmed = await confirmShareAction(this.options.app, {
        title: existing ? '更新腾讯文档' : '发布到腾讯文档',
        message: existing ? '将使用当前笔记正文和图片更新已关联的腾讯文档。文档链接保持不变，云端直接编辑的内容会被覆盖。' : '当前笔记正文和图片会上传到你的腾讯文档空间，并创建一篇新文档。',
        confirmText: existing ? '确认更新' : '确认发布',
      });
      if (!confirmed || this.disposed) return;
      const result = await this.options.service.publish({ title, markdown: snapshot.markdown, assets: snapshot.assets, ...(existing ? { documentId: existing.documentId, url: existing.url } : {}) });
      const state: PublishState = { ...result, title, contentHash: snapshotHash(snapshot, title), updatedAt: new Date().toISOString() };
      this.publishState = state;
      this.duplicatePath = null;
      try {
        await this.options.app.fileManager.processFrontMatter(this.options.file, (frontmatter: Record<string, unknown>) => {
          frontmatter[DOC_ID] = state.documentId;
          frontmatter[DOC_URL] = state.url;
          frontmatter[CONTENT_HASH] = state.contentHash;
          frontmatter[PUBLISHED_AT] = state.updatedAt;
          frontmatter[TITLE] = state.title;
        });
        this.metadataError = null;
      } catch {
        this.metadataError = existing ? '腾讯文档已更新，发布状态未能保存到笔记。请先复制上方链接。' : '腾讯文档已创建，文档链接未能保存到笔记。请先复制上方链接。';
        this.error = this.metadataError;
      }
      new Notice(existing ? '腾讯文档已更新。' : '腾讯文档已创建。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : existing ? '更新腾讯文档失败' : '发布到腾讯文档失败';
    } finally {
      this.publishing = false;
      this.requestRender();
    }
  }

  private findDuplicatePath(documentId: string): string | null {
    for (const candidate of this.options.app.vault.getMarkdownFiles()) {
      if (candidate.path === this.options.file.path) continue;
      if (this.options.app.metadataCache.getFileCache(candidate)?.frontmatter?.[DOC_ID] === documentId) return candidate.path;
    }
    return null;
  }

  private async copyPublishedUrl(): Promise<void> {
    if (!this.publishState?.url) return;
    try {
      await navigator.clipboard.writeText(this.publishState.url);
      new Notice('腾讯文档链接已复制。');
    } catch {
      new Notice('复制失败，请通过上方链接打开腾讯文档。');
    }
  }

  private button(parent: HTMLElement, text: string, icon: string, onClick: () => void, primary = false): HTMLButtonElement {
    const button = parent.createEl('button', {
      cls: primary ? 'wesight-share-primary-button is-tencent-docs' : 'wesight-share-secondary-button',
      text,
      attr: { type: 'button' },
    });
    const iconEl = button.createSpan();
    setIcon(iconEl, icon);
    button.prepend(iconEl);
    button.onclick = onClick;
    return button;
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.options.requestRender();
    window.requestAnimationFrame(() => {
      if (!this.disposed) this.options.requestPosition();
    });
  }
}
