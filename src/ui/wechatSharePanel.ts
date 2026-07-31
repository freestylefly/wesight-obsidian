import { App, Notice, setIcon, TFile } from 'obsidian';

import { CloudAuthService } from '../share/cloudAuth';
import { CloudApiError } from '../share/cloudApi';
import { parseWeChatPublishState } from '../wechat/frontmatter';
import { WeChatCloudApi } from '../wechat/cloudApi';
import type { WeChatConnectionState, WeChatDraftState } from '../wechat/types';

interface WeChatSharePanelOptions {
  app: App;
  auth: CloudAuthService;
  api: WeChatCloudApi;
  file: TFile;
  requestRender: () => void;
  requestPosition: () => void;
  openSettings: () => void;
  openPreview: (file: TFile) => Promise<void>;
}

export class WeChatSharePanel {
  private loading = false;
  private loaded = false;
  private loginPending = false;
  private connection: WeChatConnectionState | null = null;
  private draft: WeChatDraftState | null = null;
  private error: string | null = null;

  constructor(private readonly options: WeChatSharePanelOptions) {}

  activate(force = false): void {
    if ((this.loaded && !force) || this.loading) return;
    void this.load();
  }

  dispose(): void {
    this.loaded = false;
    this.loading = false;
  }

  render(parent: HTMLElement): void {
    if (this.loading) {
      this.renderLoading(parent);
      return;
    }
    if (!this.options.auth.getCurrentUser()) {
      this.renderLogin(parent);
      return;
    }
    if (this.error) {
      this.renderError(parent);
      return;
    }
    if (!this.connection) {
      this.renderDisconnected(parent);
      return;
    }
    this.renderConnected(parent);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.options.requestRender();
    try {
      const user = await this.options.auth.restoreSession();
      if (!user) return;
      this.connection = await this.options.api.getConnection();
      const publishState = parseWeChatPublishState(
        this.options.app.metadataCache.getFileCache(this.options.file)?.frontmatter,
      );
      this.draft = null;
      if (publishState) {
        try {
          this.draft = await this.options.api.getDraft(publishState.draftId);
        } catch (error) {
          if (!(error instanceof CloudApiError) || error.status !== 404) throw error;
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : '加载公众号状态失败';
    } finally {
      this.loading = false;
      this.loaded = true;
      this.options.requestRender();
      this.options.requestPosition();
    }
  }

  private renderLoading(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'wesight-share-loading' });
    const icon = row.createSpan();
    setIcon(icon, 'loader-circle');
    row.createSpan({ text: '正在检查公众号连接…' });
  }

  private renderLogin(parent: HTMLElement): void {
    this.renderHero(parent, '微信公众号', '登录 WeSight 后即可配置公众号并同步草稿。');
    const button = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-wechat',
      text: this.loginPending ? '等待登录完成' : '登录 WeSight',
      attr: { type: 'button' },
    });
    button.disabled = this.loginPending;
    button.onclick = () => {
      this.loginPending = true;
      this.options.auth.startLogin();
      this.options.requestRender();
    };
  }

  private renderDisconnected(parent: HTMLElement): void {
    this.renderHero(
      parent,
      '连接微信公众号',
      '配置公众号 AppID 与 AppSecret 后，可将当前笔记同步到后台草稿箱。',
    );
    const featureList = parent.createDiv({ cls: 'wesight-wechat-feature-list' });
    for (const text of ['Canghe Style 默认排版', '正文图片与封面自动上传', '后续更新同一篇草稿']) {
      const row = featureList.createDiv();
      const icon = row.createSpan();
      setIcon(icon, 'check');
      row.createSpan({ text });
    }
    const button = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-wechat',
      text: '连接微信公众号',
      attr: { type: 'button' },
    });
    button.onclick = this.options.openSettings;
  }

  private renderConnected(parent: HTMLElement): void {
    const account = parent.createDiv({ cls: 'wesight-wechat-account-card' });
    const logo = account.createDiv({ cls: 'wesight-wechat-logo' });
    logo.createSpan({ text: '微' });
    const copy = account.createDiv({ cls: 'wesight-wechat-account-copy' });
    copy.createEl('strong', { text: this.connection?.displayName || '微信公众号' });
    copy.createSpan({
      text: this.connection?.verified ? '已连接 · Canghe Style' : '连接需要重新验证',
    });
    const status = account.createSpan({ cls: 'wesight-wechat-account-status' });
    setIcon(status, this.connection?.verified ? 'circle-check' : 'circle-alert');

    const details = parent.createDiv({ cls: 'wesight-wechat-share-details' });
    this.detail(details, '默认排版', 'Canghe Style');
    this.detail(
      details,
      '封面',
      this.connection?.defaultCoverMediaId ? '已设置默认封面' : '优先使用正文首图',
    );
    this.detail(
      details,
      '当前笔记',
      this.draft ? `已同步 · ${this.formatTime(this.draft.updatedAt)}` : '尚未同步',
    );

    const open = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-wechat',
      text: '打开公众号预览',
      attr: { type: 'button' },
    });
    open.onclick = () => {
      void this.options.openPreview(this.options.file);
    };
    const settings = parent.createEl('button', {
      cls: 'wesight-wechat-link-button',
      text: '管理公众号连接',
      attr: { type: 'button' },
    });
    settings.onclick = this.options.openSettings;
  }

  private renderError(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = error.createSpan();
    setIcon(icon, 'circle-alert');
    error.createEl('strong', { text: '公众号状态加载失败' });
    error.createSpan({ text: this.error ?? '请稍后重试。' });
    const retry = parent.createEl('button', {
      cls: 'wesight-share-secondary-button',
      text: '重新检测',
      attr: { type: 'button' },
    });
    retry.onclick = () => this.activate(true);
  }

  private renderHero(parent: HTMLElement, title: string, description: string): void {
    const hero = parent.createDiv({ cls: 'wesight-wechat-hero' });
    const logo = hero.createDiv({ cls: 'wesight-wechat-logo is-large' });
    logo.createSpan({ text: '微' });
    const copy = hero.createDiv();
    copy.createEl('strong', { text: title });
    copy.createSpan({ text: description });
  }

  private detail(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv();
    row.createSpan({ text: label });
    row.createEl('strong', { text: value });
  }

  private formatTime(value: string): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value));
    } catch {
      new Notice('公众号草稿时间格式异常。');
      return value;
    }
  }
}
