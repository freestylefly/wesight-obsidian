import { App, Notice, setIcon } from 'obsidian';

import {
  TENCENT_DOCS_AUTH_URL,
  type TencentDocsConnectionState,
  type TencentDocsService,
} from '../tencentDocs/service';
import { confirmShareAction } from './shareConfirm';

interface TencentDocsConnectorSettingsOptions {
  app: App;
  service: TencentDocsService;
}

export class TencentDocsConnectorSettings {
  private container: HTMLElement | null = null;
  private connection: TencentDocsConnectionState | null = null;
  private busy: string | null = null;
  private error: string | null = null;
  private token = '';
  private lifecycle = 0;
  private loggingIn = false;
  private verificationUrl: string | null = null;
  private userCode: string | null = null;
  private fallbackExpanded = false;

  constructor(private readonly options: TencentDocsConnectorSettingsOptions) {}

  render(parent: HTMLElement): void {
    this.container = parent.createDiv({ cls: 'wesight-connector-card wesight-tencent-docs-connector' });
    this.container.setAttribute('tabindex', '-1');
    this.renderCard();
  }

  activate(): void {
    if (!this.busy) void this.refresh();
  }

  focus(): void {
    this.container?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.container?.focus({ preventScroll: true });
  }

  dispose(): void {
    this.lifecycle += 1;
    if (this.loggingIn) this.options.service.cancelActiveOperation();
    this.loggingIn = false;
    this.verificationUrl = null;
    this.userCode = null;
    this.busy = null;
    this.token = '';
    this.container = null;
  }

  private renderCard(): void {
    const card = this.container;
    if (!card) return;
    card.empty();
    const header = card.createDiv({ cls: 'wesight-connector-header' });
    setIcon(header.createDiv({ cls: 'wesight-connector-logo is-tencent-docs' }), 'file-text');
    const copy = header.createDiv({ cls: 'wesight-connector-copy' });
    const title = copy.createDiv({ cls: 'wesight-connector-title' });
    title.createEl('strong', { text: '腾讯文档' });
    title.createSpan({
      cls: `wesight-connector-badge ${this.busy ? 'is-pending' : this.connection?.connected ? 'is-connected' : 'is-idle'}`,
      text: this.loggingIn ? '等待授权' : this.busy ? '检测中' : this.connection?.connected ? '已连接' : '未连接',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    copy.createSpan({
      text: this.busy ?? (this.connection?.connected
        ? `${this.connection.accountName || '腾讯文档用户'} · 可发布笔记到腾讯文档`
        : '连接后即可把笔记发布到腾讯文档'),
    });
    const actions = header.createDiv({ cls: 'wesight-connector-actions' });
    if (this.loggingIn) {
      if (this.verificationUrl) this.addButton(actions, '重新打开授权页', () => this.openVerificationPage());
      this.addButton(actions, '取消', () => this.cancelLogin());
      const note = card.createDiv({ cls: 'wesight-connector-note', attr: { role: 'status', 'aria-live': 'polite' } });
      note.createDiv({ text: this.verificationUrl ? '请在浏览器中登录腾讯文档并确认授权，完成后会自动连接。' : '正在准备腾讯文档登录…' });
      if (this.userCode) note.createDiv({ text: `授权码：${this.userCode}` });
    } else if (this.connection?.connected) {
      this.addButton(actions, '重新检测', () => void this.refresh(), false, Boolean(this.busy));
      this.addButton(actions, '断开', () => void this.disconnect(), false, Boolean(this.busy));
    } else {
      this.addButton(actions, '登录授权', () => void this.login(), true, Boolean(this.busy));
      this.addButton(actions, '重新检测', () => void this.refresh(), false, Boolean(this.busy));
      card.createDiv({ cls: 'wesight-connector-note', text: '点击登录授权，在浏览器中登录腾讯文档后即可自动连接。' });
      const fallback = card.createEl('details');
      fallback.open = this.fallbackExpanded;
      fallback.ontoggle = () => { this.fallbackExpanded = fallback.open; };
      fallback.createEl('summary', { text: '使用授权凭证连接' });
      const auth = fallback.createDiv({ cls: 'wesight-tencent-docs-token-form' });
      this.addButton(auth, '获取授权 Token', () => window.open(TENCENT_DOCS_AUTH_URL, '_blank', 'noopener,noreferrer'));
      const label = auth.createEl('label', { text: '腾讯文档授权凭证' });
      const input = auth.createEl('input', {
        attr: {
          id: 'wesight-tencent-docs-token',
          type: 'password',
          value: this.token,
          placeholder: '粘贴腾讯文档官方授权页生成的凭证',
          autocomplete: 'off',
          'aria-label': '腾讯文档授权凭证',
        },
      });
      label.htmlFor = input.id;
      input.disabled = Boolean(this.busy);
      const connect = this.addButton(auth, this.busy ? '正在连接…' : '连接', () => void this.connect(), true, Boolean(this.busy) || !this.token.trim());
      input.oninput = () => {
        this.token = input.value;
        connect.disabled = Boolean(this.busy) || !this.token.trim();
      };
      auth.createDiv({ cls: 'wesight-connector-note', text: '先打开官方授权页登录并生成 Token，再回到这里完成连接。授权信息保存在 Obsidian 安全存储中。' });
    }
    if (this.error) card.createDiv({ cls: 'wesight-connector-error', text: this.error, attr: { role: 'alert' } });
  }

  private async login(): Promise<void> {
    if (this.busy) return;
    const lifecycle = this.lifecycle;
    this.loggingIn = true;
    this.busy = '正在准备腾讯文档登录…';
    this.error = null;
    this.verificationUrl = null;
    this.userCode = null;
    this.renderCard();
    try {
      const connection = await this.options.service.login(info => {
        if (lifecycle !== this.lifecycle) return;
        let url: URL;
        try { url = new URL(info.verificationUrl); } catch { throw new Error('腾讯文档未返回有效授权地址，请重试。'); }
        if (url.protocol !== 'https:' || url.hostname !== 'docs.qq.com' || url.username || url.password) {
          throw new Error('腾讯文档未返回有效授权地址，请重试。');
        }
        const openBrowser = !this.verificationUrl;
        this.verificationUrl = url.href;
        this.userCode = info.userCode || null;
        this.busy = '等待你在浏览器中完成授权…';
        this.renderCard();
        if (openBrowser) this.openVerificationPage();
      });
      if (lifecycle !== this.lifecycle) return;
      this.connection = connection;
      if (connection.connected) {
        this.token = '';
        new Notice('腾讯文档已连接。');
      } else this.error = connection.message || '腾讯文档授权尚未完成，请重试。';
    } catch (error) {
      if (lifecycle === this.lifecycle) this.error = error instanceof Error ? error.message : '腾讯文档登录授权失败';
    } finally {
      if (lifecycle === this.lifecycle) {
        this.loggingIn = false;
        this.busy = null;
        this.verificationUrl = null;
        this.userCode = null;
        this.renderCard();
      }
    }
  }

  private cancelLogin(): void {
    if (!this.loggingIn) return;
    this.lifecycle += 1;
    this.options.service.cancelActiveOperation();
    this.loggingIn = false;
    this.busy = null;
    this.verificationUrl = null;
    this.userCode = null;
    this.error = null;
    this.renderCard();
  }

  private openVerificationPage(): void {
    if (this.verificationUrl) window.open(this.verificationUrl, '_blank', 'noopener,noreferrer');
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    const lifecycle = this.lifecycle;
    this.busy = '正在检查连接状态…';
    this.error = null;
    this.renderCard();
    try {
      const connection = await this.options.service.getConnectionState();
      if (lifecycle !== this.lifecycle) return;
      this.connection = connection;
      if (connection.status === 'error') this.error = connection.message;
    } catch (error) {
      if (lifecycle === this.lifecycle) this.error = error instanceof Error ? error.message : '检测腾讯文档连接失败';
    } finally {
      if (lifecycle === this.lifecycle) {
        this.busy = null;
        this.renderCard();
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.busy || !this.token.trim()) return;
    const lifecycle = this.lifecycle;
    this.busy = '正在连接腾讯文档…';
    this.error = null;
    this.renderCard();
    try {
      const connection = await this.options.service.connect(this.token.trim());
      if (lifecycle !== this.lifecycle) return;
      this.connection = connection;
      if (connection.connected) {
        this.token = '';
        new Notice('腾讯文档已连接。');
      } else this.error = connection.message || '腾讯文档授权尚未完成，请重试。';
    } catch (error) {
      if (lifecycle === this.lifecycle) this.error = error instanceof Error ? error.message : '连接腾讯文档失败';
    } finally {
      if (lifecycle === this.lifecycle) {
        this.busy = null;
        this.renderCard();
      }
    }
  }

  private async disconnect(): Promise<void> {
    if (this.busy) return;
    const lifecycle = this.lifecycle;
    const confirmed = await confirmShareAction(this.options.app, {
      title: '断开腾讯文档连接？',
      message: '将清除本机腾讯文档授权，已发布的文档会继续保留。',
      confirmText: '断开连接',
      dangerous: true,
    });
    if (!confirmed || lifecycle !== this.lifecycle) return;
    this.busy = '正在断开连接…';
    this.error = null;
    this.renderCard();
    try {
      await this.options.service.disconnect();
      if (lifecycle !== this.lifecycle) return;
      this.connection = null;
      this.token = '';
      new Notice('腾讯文档连接已断开。');
    } catch (error) {
      if (lifecycle === this.lifecycle) this.error = error instanceof Error ? error.message : '断开腾讯文档连接失败';
    } finally {
      if (lifecycle === this.lifecycle) {
        this.busy = null;
        this.renderCard();
      }
    }
  }

  private addButton(parent: HTMLElement, text: string, onClick: () => void, primary = false, disabled = false): HTMLButtonElement {
    const button = parent.createEl('button', { text, attr: { type: 'button' } });
    if (primary) button.addClass('mod-cta');
    button.disabled = disabled;
    button.onclick = onClick;
    return button;
  }
}
