import { App, Notice, Setting, setIcon } from 'obsidian';

import feishuLogoUrl from '../../assets/feishu-logo.png';
import { LarkCliError, type LarkCliService } from '../feishu/larkCli';
import type { FeishuAuthProgress, FeishuConnectionState } from '../feishu/types';
import { confirmShareAction } from './shareConfirm';
import type { MultiPublishBridge } from '../multiPublish/bridge';
import type { CloudAuthService } from '../share/cloudAuth';
import { BrowserConnectorSettings } from './browserConnectorSettings';

const LARK_CLI_INSTALL_URL = 'https://github.com/larksuite/cli#installation';

interface ConnectorsSettingsOptions {
  app: App;
  auth: CloudAuthService;
  larkCli: LarkCliService;
  multiPublishBridge: MultiPublishBridge;
}

function formatAuthorizedAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * 通用设置中的连接器，集中管理浏览器发布与飞书授权。
 */
export class ConnectorsSettings {
  private container: HTMLElement | null = null;
  private connection: FeishuConnectionState | null = null;
  private authProgress: FeishuAuthProgress | null = null;
  private loading = false;
  private busy: string | null = null;
  private error: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly browserConnector: BrowserConnectorSettings;

  constructor(private readonly options: ConnectorsSettingsOptions) {
    this.browserConnector = new BrowserConnectorSettings({ app: options.app, auth: options.auth, bridge: options.multiPublishBridge });
  }

  render(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'wesight-settings-section wesight-connectors-settings' });
    new Setting(section).setName('连接器').setHeading();
    section.createDiv({
      cls: 'wesight-settings-section-intro',
      text: '一次授权，长期可用。连接后分享、发布等功能会直接复用这里的授权。',
    });
    this.container = section.createDiv({ cls: 'wesight-connector-card' });
    this.renderFeishu();
    this.browserConnector.render(section);
  }

  activate(): void {
    this.browserConnector.activate();
    if (!this.unsubscribe) {
      this.unsubscribe = this.options.larkCli.onProgress(progress => {
        if (!this.authProgress) return;
        this.authProgress = progress;
        this.renderFeishu();
      });
    }
    if (!this.connection && !this.loading) void this.refresh();
  }

  dispose(): void {
    this.browserConnector.dispose();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.authProgress) {
      this.options.larkCli.cancelActiveOperation();
      this.authProgress = null;
    }
    this.container = null;
  }

  focusBrowserConnector(): void {
    this.browserConnector.focus();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.renderFeishu();
    try {
      await this.options.larkCli.keepAlive();
      this.connection = await this.options.larkCli.getConnectionState();
      if (this.connection.status === 'error') this.error = this.connection.message;
    } catch (error) {
      this.error = error instanceof Error ? error.message : '检测飞书连接失败';
    } finally {
      this.loading = false;
      this.renderFeishu();
    }
  }

  private renderFeishu(): void {
    const card = this.container;
    if (!card) return;
    card.empty();

    const header = card.createDiv({ cls: 'wesight-connector-header' });
    const logo = header.createDiv({ cls: 'wesight-connector-logo' });
    logo.createEl('img', { attr: { src: feishuLogoUrl, alt: '飞书' } });
    const copy = header.createDiv({ cls: 'wesight-connector-copy' });
    const title = copy.createDiv({ cls: 'wesight-connector-title' });
    title.createEl('strong', { text: '飞书' });
    const subtitle = copy.createSpan();
    const actions = header.createDiv({ cls: 'wesight-connector-actions' });

    if (this.loading || this.busy) {
      subtitle.setText(this.busy ?? '正在检查连接状态…');
      this.renderBadge(title, '检测中', 'is-pending');
      return;
    }

    if (this.authProgress) {
      subtitle.setText('等待扫码授权');
      this.renderBadge(title, '授权中', 'is-pending');
      this.renderAuthProgress(card, this.authProgress);
      return;
    }

    const connection = this.connection;
    if (connection?.connected) {
      const authorizedAt = formatAuthorizedAt(connection.authorizedAt);
      subtitle.setText([
        connection.accountName || '飞书用户',
        authorizedAt ? `授权于 ${authorizedAt}` : '',
      ].filter(Boolean).join(' · '));
      this.renderBadge(title, '已连接', 'is-connected');
      this.addButton(actions, '重新检测', () => void this.refresh());
      this.addButton(actions, '断开', () => void this.disconnect());
      card.createDiv({
        cls: 'wesight-connector-note',
        text: '插件会在后台自动续期飞书授权，只要每 7 天内打开过一次 Obsidian 就无需重新扫码。',
      });
      return;
    }

    if (connection?.status === 'missing-cli') {
      subtitle.setText('未检测到飞书 CLI，请先按官方指引安装');
      this.renderBadge(title, '未安装', 'is-idle');
      this.addButton(actions, '安装指引', () => this.openExternal(LARK_CLI_INSTALL_URL));
      this.addButton(actions, '重新检测', () => void this.refresh());
      return;
    }

    subtitle.setText(
      connection?.status === 'admin-action-required'
        ? '需要企业管理员开放权限'
        : '连接后即可把笔记发布到飞书文档',
    );
    this.renderBadge(title, '未连接', 'is-idle');
    if (connection?.consoleUrl) {
      this.addButton(actions, '权限配置', () => this.openExternal(connection.consoleUrl!));
    }
    this.addButton(actions, '连接', () => void this.connect(), true);
    const message = this.error
      ?? (connection && !['needs-auth', 'needs-config'].includes(connection.status) ? connection.message : null);
    if (message) card.createDiv({ cls: 'wesight-connector-error', text: message });
  }

  private renderAuthProgress(card: HTMLElement, progress: FeishuAuthProgress): void {
    const body = card.createDiv({ cls: 'wesight-connector-auth' });
    if (progress.qrCodeDataUrl) {
      body.createEl('img', {
        cls: 'wesight-feishu-qr',
        attr: { src: progress.qrCodeDataUrl, alt: '飞书授权二维码' },
      });
    }
    const copy = body.createDiv({ cls: 'wesight-connector-auth-copy' });
    copy.createEl('strong', {
      text: progress.phase === 'configuring'
        ? '请在浏览器中完成飞书应用配置'
        : '用手机飞书 App 扫码，勾选全部权限并同意',
    });
    const status = copy.createDiv({ cls: 'wesight-feishu-waiting' });
    setIcon(status.createSpan(), 'loader-circle');
    status.createSpan({ text: progress.message });
    const buttons = copy.createDiv({ cls: 'wesight-connector-actions' });
    if (progress.verificationUrl) {
      this.addButton(buttons, '在浏览器中打开', () => this.openExternal(progress.verificationUrl!));
    }
    this.addButton(buttons, '取消', () => {
      this.options.larkCli.cancelActiveOperation();
      this.authProgress = null;
      this.renderFeishu();
    });
  }

  private async connect(): Promise<void> {
    const cli = this.options.larkCli;
    this.error = null;
    try {
      this.authProgress = { phase: 'detecting', message: '正在准备飞书授权…' };
      this.renderFeishu();
      await cli.ensureConfigured(url => this.openExternal(url));
      this.authProgress = await cli.startAuthorization();
      this.renderFeishu();
      this.connection = await cli.completeAuthorization();
      this.authProgress = null;
      new Notice('飞书已连接，之后分享无需再次授权。');
    } catch (error) {
      this.authProgress = null;
      const cancelled = error instanceof LarkCliError && /取消/.test(error.message);
      this.error = cancelled ? null : (error instanceof Error ? error.message : '连接飞书失败');
    }
    this.renderFeishu();
  }

  private async disconnect(): Promise<void> {
    const confirmed = await confirmShareAction(this.options.app, {
      title: '断开飞书连接？',
      message: '将清除本机飞书用户授权，已发布的飞书文档会继续保留。',
      confirmText: '断开连接',
      dangerous: true,
    });
    if (!confirmed) return;
    this.busy = '正在断开连接…';
    this.renderFeishu();
    try {
      await this.options.larkCli.disconnect();
      new Notice('飞书连接已断开。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '断开飞书连接失败';
    } finally {
      this.busy = null;
    }
    await this.refresh();
  }

  private renderBadge(parent: HTMLElement, text: string, cls: string): void {
    parent.createSpan({ cls: `wesight-connector-badge ${cls}`, text });
  }

  private addButton(
    parent: HTMLElement,
    text: string,
    onClick: () => void,
    primary = false,
  ): void {
    const button = parent.createEl('button', { text, attr: { type: 'button' } });
    if (primary) button.addClass('mod-cta');
    button.onclick = onClick;
  }

  private openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
