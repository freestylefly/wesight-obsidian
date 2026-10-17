import { App, Notice, setIcon } from 'obsidian';

import type { MultiPublishBridge } from '../multiPublish/bridge';
import { CHROME_EXTENSION_DOWNLOAD_URL, CHROME_INSTALL_STEPS } from '../multiPublish/installGuide';
import type { CloudAuthService } from '../share/cloudAuth';
import { requireMemberFeature } from './memberFeatureGate';
import { confirmShareAction } from './shareConfirm';

const CONNECTION_WAIT_MS = 15_000;

interface BrowserConnectorSettingsOptions {
  app: App;
  auth: CloudAuthService;
  bridge: MultiPublishBridge;
}

/** Browser pairing lives here so publishing never needs to create a test draft. */
export class BrowserConnectorSettings {
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private waiting = false;
  private timedOut = false;
  private error: string | null = null;
  private timer: number | null = null;
  private disconnecting = false;
  private checkingMembership = false;
  private lifecycle = 0;

  constructor(private readonly options: BrowserConnectorSettingsOptions) {}

  render(parent: HTMLElement): void {
    this.container = parent.createDiv({ cls: 'wesight-connector-card wesight-browser-connector' });
    this.container.setAttribute('tabindex', '-1');
    this.renderCard();
  }

  activate(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.bridge.onChange(() => {
      if (this.options.bridge.getConnectionState().connected) {
        this.clearTimer();
        this.waiting = false;
        this.timedOut = false;
        this.error = null;
      }
      this.renderCard();
    });
  }

  focus(): void {
    this.container?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.container?.focus({ preventScroll: true });
  }

  dispose(): void {
    this.lifecycle += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    this.waiting = false;
    this.container = null;
  }

  private renderCard(): void {
    const card = this.container;
    if (!card) return;
    const state = this.options.bridge.getConnectionState();
    card.empty();
    const header = card.createDiv({ cls: 'wesight-connector-header' });
    setIcon(header.createDiv({ cls: 'wesight-connector-logo' }), 'puzzle');
    const copy = header.createDiv({ cls: 'wesight-connector-copy' });
    const title = copy.createDiv({ cls: 'wesight-connector-title' });
    title.createEl('strong', { text: '浏览器发布助手' });
    title.createSpan({ cls: 'wesight-connector-badge', text: '会员专享' });
    const status = title.createSpan({
      cls: `wesight-connector-badge ${this.waiting ? 'is-pending' : state.connected ? 'is-connected' : 'is-idle'}`,
      text: this.waiting ? '等待连接' : state.connected ? '已连接' : state.paired ? '已配对，未连接' : '未连接',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    status.setAttribute('data-connection-state', this.waiting ? 'waiting' : state.connected ? 'connected' : 'disconnected');
    copy.createSpan({
      text: state.connected
        ? `WeSight 发布助手${state.extensionVersion ? ` v${state.extensionVersion}` : ''} · 可接收文章和图文`
        : this.waiting
          ? '请在安装了 WeSight 发布助手的浏览器中确认连接'
          : state.paired
            ? '已保存本机配对，打开浏览器恢复连接后即可发布'
            : '连接浏览器插件后，即可把文章和图文带入浏览器发布中心',
    });
    const actions = header.createDiv({ cls: 'wesight-connector-actions' });
    this.addButton(actions, this.checkingMembership ? '正在验证会员…' : state.connected ? '检测连接' : state.paired ? '重新连接' : '连接浏览器', () => void this.connect(), !state.connected, this.checkingMembership || this.waiting || this.disconnecting || !state.running);
    if (state.paired) {
      this.addButton(actions, '断开', () => void this.disconnect(), false, this.checkingMembership || this.disconnecting);
    }

    if (!state.running) {
      card.createDiv({ cls: 'wesight-connector-error', text: '本地连接服务尚未启动，请关闭后重新启用 WeSight 插件。' });
    }
    if (this.timedOut) {
      card.createDiv({
        cls: 'wesight-connector-note',
        text: '暂未检测到浏览器响应。请确认当前浏览器已安装并启用 WeSight 发布助手，安装后点击上方按钮重新连接。',
        attr: { role: 'status', 'aria-live': 'polite' },
      });
    }
    if (this.error) card.createDiv({ cls: 'wesight-connector-error', text: this.error });
    if (this.waiting) {
      const note = card.createDiv({ cls: 'wesight-connector-note' });
      note.createSpan({ text: '已打开连接页。使用其他浏览器时，请把该页面地址复制到安装了发布助手的浏览器中打开。' });
      this.addButton(note, '取消等待', () => {
        this.clearTimer();
        this.waiting = false;
        this.renderCard();
      });
    }
    this.renderInstallGuide(card, !state.paired || this.timedOut);
  }

  private renderInstallGuide(card: HTMLElement, expanded: boolean): void {
    const guide = card.createEl('details', { cls: 'wesight-browser-install-guide' });
    if (expanded) guide.setAttribute('open', '');
    guide.createEl('summary', { text: '安装或更新浏览器插件' });
    const steps = guide.createEl('ol');
    for (const step of CHROME_INSTALL_STEPS) {
      const row = steps.createEl('li');
      row.createEl('strong', { text: step.title });
      row.createSpan({ text: `：${step.description}` });
    }
    const actions = guide.createDiv({ cls: 'wesight-connector-actions' });
    this.addButton(actions, '下载插件 ZIP', () => {
      window.open(CHROME_EXTENSION_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
    });
    this.addButton(actions, 'Chrome / Arc 扩展管理', () => void this.openExtensions('chrome://extensions/'));
    this.addButton(actions, 'Edge 扩展管理', () => void this.openExtensions('edge://extensions/'));
    guide.createDiv({
      cls: 'wesight-connector-note',
      text: '管理页无法直接打开时，可将已复制的地址粘贴到对应浏览器。更新时使用新文件夹重新加载扩展，再回到这里连接。',
    });
  }

  private async connect(): Promise<void> {
    if (this.checkingMembership || this.waiting || this.disconnecting) return;
    const lifecycle = this.lifecycle;
    this.checkingMembership = true;
    this.renderCard();
    try {
      if (!await requireMemberFeature(this.options.app, this.options.auth, '浏览器发布助手连接')) return;
      if (!this.container || lifecycle !== this.lifecycle) return;
      this.startConnection();
    } finally {
      this.checkingMembership = false;
      this.renderCard();
    }
  }

  private startConnection(): void {
    this.clearTimer();
    this.error = null;
    this.timedOut = false;
    try {
      const url = this.options.bridge.createConnectionUrl();
      this.waiting = true;
      this.renderCard();
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.waiting = false;
        this.timedOut = !this.options.bridge.getConnectionState().connected;
        this.renderCard();
      }, CONNECTION_WAIT_MS);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.clearTimer();
      this.waiting = false;
      this.error = error instanceof Error ? error.message : '无法打开浏览器连接页';
      this.renderCard();
    }
  }

  private async disconnect(): Promise<void> {
    if (this.disconnecting) return;
    this.disconnecting = true;
    const confirmed = await confirmShareAction(this.options.app, {
      title: '断开浏览器发布助手？',
      message: '会清除这台设备的连接授权，浏览器中的草稿和已同步内容会保留。下次发布需要重新连接。',
      confirmText: '断开连接',
    });
    if (!confirmed) {
      this.disconnecting = false;
      this.renderCard();
      return;
    }
    this.clearTimer();
    this.waiting = false;
    this.timedOut = false;
    this.error = null;
    try {
      await this.options.bridge.clearPairing();
    } catch (error) {
      this.error = error instanceof Error ? error.message : '断开浏览器连接失败';
    } finally {
      this.disconnecting = false;
      this.renderCard();
    }
  }

  private async openExtensions(url: string): Promise<void> {
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      // Navigation can still succeed without clipboard permission.
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    new Notice(copied ? `已复制 ${url}，若未跳转请粘贴到对应浏览器。` : `请在对应浏览器地址栏打开 ${url}`);
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private addButton(parent: HTMLElement, text: string, onClick: () => void, primary = false, disabled = false): void {
    const button = parent.createEl('button', { text, attr: { type: 'button' } });
    if (primary) button.addClass('mod-cta');
    button.disabled = disabled;
    button.onclick = onClick;
  }
}
