import { App, Notice, setIcon, TFile } from 'obsidian';

import feishuLogoUrl from '../../assets/feishu-logo.png';
import {
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
  parseFeishuPublishState,
} from '../feishu/frontmatter';
import { LarkCliError, LarkCliService } from '../feishu/larkCli';
import {
  buildFeishuSnapshot,
  withFeishuSnapshotTitle,
} from '../feishu/snapshot';
import type {
  FeishuAuthProgress,
  FeishuCapabilityId,
  FeishuConnectionState,
  FeishuPublishState,
  FeishuSnapshot,
} from '../feishu/types';
import type { WeSightObsidianSettings } from '../types';
import { recordValue } from '../utils/records';
import { confirmShareAction } from './shareConfirm';

interface FeishuSharePanelOptions {
  app: App;
  cli: LarkCliService;
  file: TFile;
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  requestRender: () => void;
  requestPosition: () => void;
}

const CAPABILITY_ICONS: Record<FeishuCapabilityId, string> = {
  im: 'message-circle',
  docs: 'file-text',
  base: 'table-2',
  calendar: 'calendar-days',
  drive: 'cloud',
};

const CAPABILITY_ORDER: FeishuCapabilityId[] = [
  'im',
  'docs',
  'base',
  'calendar',
  'drive',
];

function formatUpdatedAt(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function buttonWithIcon(
  parent: HTMLElement,
  className: string,
  text: string,
  iconName: string,
): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: className,
    text,
    attr: { type: 'button' },
  });
  const icon = button.createSpan();
  setIcon(icon, iconName);
  button.prepend(icon);
  return button;
}

export class FeishuSharePanel {
  private loaded = false;
  private disposed = false;
  private loading = false;
  private connection: FeishuConnectionState | null = null;
  private snapshot: FeishuSnapshot | null = null;
  private publishState: FeishuPublishState | null = null;
  private duplicatePath: string | null = null;
  private authProgress: FeishuAuthProgress | null = null;
  private operationLabel: string | null = null;
  private error: string | null = null;
  private consoleUrl: string | null = null;
  private title = '';
  private updateSameDocument = true;
  private openedConfigUrl: string | null = null;
  private authUnsubscribe: (() => void) | null = null;

  constructor(private readonly options: FeishuSharePanelOptions) {}

  activate(): void {
    if (this.loaded || this.loading) return;
    this.authUnsubscribe = this.options.cli.onProgress(progress => {
      this.authProgress = progress;
      if (progress.consoleUrl) this.consoleUrl = progress.consoleUrl;
      this.requestRender();
    });
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    if (
      this.authProgress
      && !['success', 'failed', 'cancelled'].includes(this.authProgress.phase)
    ) {
      this.options.cli.cancelActiveOperation();
    }
  }

  render(parent: HTMLElement): void {
    if (this.loading || !this.loaded) {
      this.renderLoading(parent);
      return;
    }
    if (this.operationLabel) {
      this.renderOperation(parent);
      return;
    }
    if (this.authProgress && this.isAuthFlowVisible()) {
      this.renderAuthProgress(parent);
      return;
    }
    if (this.error && (!this.connection || this.connection.status === 'error')) {
      this.renderError(parent);
      return;
    }
    if (!this.connection) {
      this.renderError(parent, '无法读取飞书连接状态。');
      return;
    }
    if (this.connection.status === 'admin-action-required') {
      this.renderAdminAction(parent);
      return;
    }
    if (this.connection.connected) {
      this.renderConnected(parent);
      return;
    }
    this.renderDisconnected(parent);
  }

  private async load(verifyCapabilities = false): Promise<void> {
    this.loading = true;
    this.error = null;
    this.requestRender();
    try {
      const frontmatter = this.options.app.metadataCache
        .getFileCache(this.options.file)
        ?.frontmatter;
      this.publishState = parseFeishuPublishState(frontmatter);
      this.duplicatePath = this.publishState
        ? this.findDuplicatePath(this.publishState.documentId)
        : null;
      this.snapshot = await buildFeishuSnapshot(this.options.app, this.options.file);
      this.title = this.publishState?.title || this.snapshot.title;
      this.connection = await this.options.cli.getConnectionState(verifyCapabilities);
      this.consoleUrl = this.connection.consoleUrl;
      this.error = this.connection.status === 'error' ? this.connection.message : null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : '加载飞书发布状态失败';
    } finally {
      if (!this.disposed) {
        this.loaded = true;
        this.loading = false;
        this.requestRender();
      }
    }
  }

  private renderLoading(parent: HTMLElement): void {
    const loading = parent.createDiv({ cls: 'wesight-share-loading' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在检查飞书连接状态…' });
  }

  private renderDisconnected(parent: HTMLElement): void {
    const status = this.connection?.status;
    this.renderFeishuHero(
      parent,
      '连接飞书后发布文档',
      '请先独立安装飞书 CLI，再通过手机飞书 App 授权发布所需能力。',
    );
    const statusRow = parent.createDiv({ cls: 'wesight-feishu-cli-status' });
    const statusIcon = statusRow.createSpan();
    setIcon(statusIcon, status === 'missing-cli'
      ? 'circle-alert'
      : 'circle-check');
    statusRow.createSpan({
      text: status === 'missing-cli'
        ? '未检测到系统飞书 CLI'
        : status === 'needs-config'
          ? `已安装飞书 CLI${this.connection?.cliVersion ? ` · ${this.connection.cliVersion}` : ''}`
          : this.connection?.permissionsComplete
            ? '飞书 CLI 已就绪，需要完成本机首次授权'
            : '飞书 CLI 已就绪，等待全部权限授权',
    });
    this.renderCapabilityStrip(parent);

    const missingCli = status === 'missing-cli';
    const primary = buttonWithIcon(
      parent,
      'wesight-share-primary-button is-feishu',
      missingCli
        ? '查看飞书 CLI 安装指引'
        : '连接飞书',
      missingCli ? 'external-link' : 'plug-zap',
    );
    primary.onclick = () => {
      if (missingCli) {
        window.open(
          'https://github.com/larksuite/cli#installation',
          '_blank',
          'noopener,noreferrer',
        );
        return;
      }
      void this.connect();
    };
    parent.createDiv({
      cls: 'wesight-feishu-security-note',
      text: 'WeSight 不会安装或更新飞书 CLI；凭据由飞书 CLI 与系统安全存储管理',
    });
  }

  private renderAuthProgress(parent: HTMLElement): void {
    const progress = this.authProgress!;
    this.renderAuthStepper(parent, progress.phase);
    if (progress.phase === 'configuring') {
      this.renderFeishuHero(
        parent,
        '配置飞书应用',
        '请在浏览器中完成飞书应用配置，完成后会自动继续授权。',
        false,
      );
      if (progress.verificationUrl) {
        const open = buttonWithIcon(
          parent,
          'wesight-share-secondary-button wesight-feishu-full-button',
          '在浏览器中打开配置',
          'external-link',
        );
        open.onclick = () => this.openExternal(progress.verificationUrl!);
      }
      this.renderSpinnerStatus(parent, progress.message);
      this.renderCancelButton(parent);
      return;
    }
    if (progress.phase === 'failed' || progress.phase === 'cancelled') {
      if (progress.phase === 'cancelled') {
        this.renderError(parent, progress.message);
      } else {
        this.renderAuthorizationFailure(parent, progress);
      }
      return;
    }

    parent.createEl('h3', {
      cls: 'wesight-feishu-auth-title',
      text: progress.phase === 'verifying' ? '正在确认全部权限' : '完成授权',
    });
    if (progress.qrCodeDataUrl && progress.verificationUrl) {
      parent.createDiv({
        cls: 'wesight-feishu-auth-lead',
        text: '请打开手机飞书 App，扫描下方二维码。',
      });
      const authGrid = parent.createDiv({ cls: 'wesight-feishu-auth-grid' });
      authGrid.createEl('img', {
        cls: 'wesight-feishu-qr',
        attr: {
          src: progress.qrCodeDataUrl,
          alt: '飞书授权二维码',
        },
      });
      const authCopy = authGrid.createDiv({ cls: 'wesight-feishu-auth-copy' });
      authCopy.createEl('strong', {
        text: '进入授权页面后，勾选全部权限项目并点击同意。',
      });
      authCopy.createSpan({
        text: '文档、消息、多维表格、日历、云盘等全部飞书能力。',
      });
      authCopy.createSpan({
        text: '真实权限清单由飞书官方授权页展示。',
      });
    }
    this.renderSpinnerStatus(
      parent,
      progress.phase === 'verifying'
        ? '正在验证全部权限和五项只读能力……'
        : '等待你在手机飞书 App 内完成授权……',
    );

    const separator = parent.createDiv({ cls: 'wesight-feishu-separator' });
    separator.createEl('strong', { text: '本次授权' });
    this.renderCapabilityList(parent);
    parent.createDiv({
      cls: 'wesight-feishu-auth-footnote',
      text: '二维码、授权链接和 device code 仅保留在当前连接会话中',
    });
    if (progress.verificationUrl) {
      const open = buttonWithIcon(
        parent,
        'wesight-share-secondary-button wesight-feishu-full-button',
        '在浏览器中打开授权',
        'external-link',
      );
      open.onclick = () => this.openExternal(progress.verificationUrl!);
    }
    const cancel = parent.createEl('button', {
      cls: 'wesight-feishu-link-button',
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => {
      this.options.cli.cancelActiveOperation();
      this.authProgress = null;
      this.requestRender();
    };
  }

  private renderConnected(parent: HTMLElement): void {
    const connection = this.connection!;
    const account = parent.createDiv({ cls: 'wesight-feishu-account-card' });
    const logoWrap = account.createDiv({ cls: 'wesight-feishu-account-logo' });
    logoWrap.createEl('img', {
      attr: { src: feishuLogoUrl, alt: '飞书' },
    });
    const copy = account.createDiv({ cls: 'wesight-feishu-account-copy' });
    copy.createEl('strong', { text: connection.accountName || '飞书用户' });
    const authorizedAt = connection.authorizedAt
      ? formatUpdatedAt(connection.authorizedAt)
      : '';
    copy.createSpan({
      text: connection.tenantName
        || (authorizedAt ? `全部权限 · 授权于 ${authorizedAt}` : '已连接飞书企业'),
    });
    const actions = account.createDiv({ cls: 'wesight-feishu-account-actions' });
    const manage = actions.createEl('button', {
      text: '管理权限',
      attr: { type: 'button' },
    });
    manage.onclick = () => void this.reauthorize();
    const disconnect = actions.createEl('button', {
      text: '断开连接',
      attr: { type: 'button' },
    });
    disconnect.onclick = () => void this.disconnect();

    const granted = parent.createDiv({ cls: 'wesight-feishu-granted-row' });
    const grantedIcon = granted.createSpan();
    setIcon(grantedIcon, 'circle-check');
    granted.createSpan({ text: '消息、文档、多维表格、日历和云盘等全部权限已授权' });

    if (this.duplicatePath) {
      this.renderDuplicate(parent);
      return;
    }
    if (!this.snapshot) {
      this.renderError(parent, '无法读取当前笔记。');
      return;
    }

    if (this.publishState?.url) {
      this.renderPublishedLink(parent);
    }

    const form = parent.createDiv({ cls: 'wesight-feishu-publish-form' });
    const locationLabel = form.createEl('label', { text: '保存位置' });
    const location = form.createEl('select', {
      attr: { 'aria-label': '飞书文档保存位置' },
    });
    location.createEl('option', {
      text: '我的空间 / WeSight 分享',
      attr: { value: this.options.getSettings().feishuFolderToken || 'default' },
    });
    locationLabel.htmlFor = location.id;

    const titleLabel = form.createEl('label', { text: '文档标题' });
    const title = form.createEl('input', {
      attr: {
        type: 'text',
        value: this.title,
        'aria-label': '飞书文档标题',
      },
    });
    titleLabel.htmlFor = title.id;
    title.oninput = () => {
      this.title = title.value;
      this.requestRender();
    };

    const updateRow = form.createEl('label', { cls: 'wesight-feishu-checkbox-row' });
    const update = updateRow.createEl('input', {
      attr: { type: 'checkbox' },
    });
    update.checked = this.updateSameDocument;
    update.onchange = () => {
      this.updateSameDocument = update.checked;
      this.requestRender();
    };
    updateRow.createSpan({ text: '后续更新同一篇飞书文档' });
    form.createDiv({
      cls: 'wesight-feishu-form-hint',
      text: this.publishState && this.updateSameDocument
        ? '更新后保持当前飞书文档链接不变'
        : '首次创建文档，后续更新可保持同一链接',
    });

    this.renderWarnings(parent, this.snapshot);
    const titledSnapshot = withFeishuSnapshotTitle(this.snapshot, this.title);
    const unchanged = Boolean(
      this.publishState
      && this.updateSameDocument
      && this.publishState.contentHash === titledSnapshot.contentHash,
    );
    const publish = buttonWithIcon(
      parent,
      'wesight-share-primary-button is-feishu',
      this.publishState && this.updateSameDocument ? '更新飞书文档' : '发布到飞书文档',
      this.publishState && this.updateSameDocument ? 'refresh-cw' : 'send',
    );
    publish.disabled = unchanged || !this.title.trim();
    publish.onclick = () => void this.publish(false);
    if (unchanged) {
      parent.createDiv({
        cls: 'wesight-feishu-current-note',
        text: '飞书文档已经是当前笔记的最新内容',
      });
    }
  }

  private renderPublishedLink(parent: HTMLElement): void {
    const state = this.publishState!;
    const row = parent.createDiv({ cls: 'wesight-share-link-actions' });
    const open = buttonWithIcon(
      row,
      'wesight-share-secondary-button',
      '打开文档',
      'external-link',
    );
    open.onclick = () => this.openExternal(state.url);
    const copy = buttonWithIcon(
      row,
      'wesight-share-copy-button',
      '复制链接',
      'copy',
    );
    copy.onclick = () => void navigator.clipboard.writeText(state.url).then(() => {
      new Notice('飞书文档链接已复制。');
    });
    const updated = formatUpdatedAt(state.updatedAt);
    if (updated) {
      parent.createDiv({
        cls: 'wesight-share-published-at',
        text: `最后发布于 ${updated}`,
      });
    }
  }

  private renderDuplicate(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = error.createSpan();
    setIcon(icon, 'copy-x');
    const copy = error.createDiv();
    copy.createEl('strong', { text: '检测到重复的飞书文档标识' });
    copy.createSpan({
      text: `另一篇笔记“${this.duplicatePath}”关联了同一篇飞书文档。`,
    });
    const publish = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-feishu',
      text: '作为新的飞书文档发布',
      attr: { type: 'button' },
    });
    publish.onclick = () => void this.publish(true);
  }

  private renderAdminAction(parent: HTMLElement): void {
    this.renderFeishuHero(
      parent,
      '等待企业管理员开放权限',
      this.connection?.message || '当前飞书应用缺少所需权限，请完成企业权限配置。',
    );
    const warning = parent.createDiv({ cls: 'wesight-share-warning-note' });
    const icon = warning.createSpan();
    setIcon(icon, 'shield-alert');
    warning.createSpan({ text: '飞书返回了权限配置入口，完成设置后可重新检测。' });
    if (this.consoleUrl) {
      const consoleButton = buttonWithIcon(
        parent,
        'wesight-share-secondary-button wesight-feishu-full-button',
        '打开飞书权限配置',
        'external-link',
      );
      consoleButton.onclick = () => this.openExternal(this.consoleUrl!);
    }
    const retry = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-feishu',
      text: '重新检测',
      attr: { type: 'button' },
    });
    retry.onclick = () => void this.load(true);
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
    copy.createEl('strong', { text: '暂时无法完成飞书操作' });
    copy.createSpan({ text: override || this.error || '请稍后重试。' });
    if (this.consoleUrl) {
      const consoleButton = buttonWithIcon(
        parent,
        'wesight-share-secondary-button wesight-feishu-full-button',
        '打开飞书权限配置',
        'external-link',
      );
      consoleButton.onclick = () => this.openExternal(this.consoleUrl!);
    }
    const retry = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-feishu',
      text: '重试',
      attr: { type: 'button' },
    });
    retry.onclick = () => {
      this.authProgress = null;
      void this.load();
    };
  }

  private renderAuthorizationFailure(
    parent: HTMLElement,
    progress: FeishuAuthProgress,
  ): void {
    const expired = /过期|失效|expired/i.test(progress.message);
    const rejected = /拒绝|取消|denied|declined/i.test(progress.message);
    const discovered = this.options.cli.discoverCli();
    const canReauthorize = Boolean(discovered.path && this.connection?.configured);
    this.renderFeishuHero(
      parent,
      expired
        ? '授权二维码已过期'
        : rejected
          ? '尚未同意全部权限'
          : '飞书授权暂未完成',
      progress.message,
      false,
    );
    const retry = buttonWithIcon(
      parent,
      'wesight-share-primary-button is-feishu',
      expired
        ? '刷新二维码'
        : canReauthorize
          ? '重新申请权限'
          : '重试连接',
      expired ? 'refresh-cw' : canReauthorize ? 'scan-line' : 'rotate-cw',
    );
    retry.onclick = () => {
      this.authProgress = null;
      if (canReauthorize) {
        void this.reauthorize();
      } else {
        void this.connect();
      }
    };
    if (progress.consoleUrl) {
      const consoleButton = buttonWithIcon(
        parent,
        'wesight-share-secondary-button wesight-feishu-full-button',
        '打开飞书权限配置',
        'external-link',
      );
      consoleButton.onclick = () => this.openExternal(progress.consoleUrl!);
    }
  }

  private renderFeishuHero(
    parent: HTMLElement,
    title: string,
    description: string,
    showLogo = true,
  ): void {
    const hero = parent.createDiv({ cls: 'wesight-feishu-hero' });
    if (showLogo) {
      const logo = hero.createDiv({ cls: 'wesight-feishu-logo' });
      logo.createEl('img', {
        attr: { src: feishuLogoUrl, alt: '飞书' },
      });
    }
    const copy = hero.createDiv({ cls: 'wesight-feishu-hero-copy' });
    copy.createEl('strong', { text: title });
    copy.createSpan({ text: description });
  }

  private renderCapabilityStrip(parent: HTMLElement): void {
    const strip = parent.createDiv({ cls: 'wesight-feishu-capability-strip' });
    for (const id of CAPABILITY_ORDER) {
      const item = strip.createDiv();
      const icon = item.createSpan();
      setIcon(icon, CAPABILITY_ICONS[id]);
      item.createSpan({ text: CAPABILITY_META_LABELS[id] });
    }
  }

  private renderCapabilityList(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: 'wesight-feishu-capability-list' });
    const capabilities = this.connection?.capabilities;
    for (const id of CAPABILITY_ORDER) {
      const item = list.createDiv();
      const icon = item.createSpan();
      setIcon(icon, CAPABILITY_ICONS[id]);
      item.createEl('strong', { text: `${CAPABILITY_META_LABELS[id]}：` });
      item.createSpan({ text: CAPABILITY_DESCRIPTIONS[id] });
      if (capabilities?.[id]?.granted) {
        item.classList.add('is-granted');
      }
    }
  }

  private renderAuthStepper(parent: HTMLElement, phase: FeishuAuthProgress['phase']): void {
    const stepper = parent.createDiv({ cls: 'wesight-feishu-stepper' });
    const cliDone = phase !== 'detecting';
    const requestDone = ['verifying', 'success'].includes(phase);
    const authDone = phase === 'success';
    const steps = [
      { label: '检测 CLI', done: cliDone, active: !cliDone },
      {
        label: '申请权限',
        done: requestDone,
        active: cliDone && !requestDone,
      },
      {
        label: '完成授权',
        done: authDone,
        active: phase === 'verifying',
      },
    ];
    steps.forEach((step, index) => {
      const item = stepper.createDiv({
        cls: `wesight-feishu-step${step.done ? ' is-done' : ''}${step.active ? ' is-active' : ''}`,
      });
      const marker = item.createSpan();
      if (step.done) {
        setIcon(marker, 'check');
      } else {
        marker.setText(String(index + 1));
      }
      item.createSpan({ text: step.label });
      if (index < steps.length - 1) stepper.createDiv({ cls: 'wesight-feishu-step-line' });
    });
  }

  private renderSpinnerStatus(parent: HTMLElement, text: string): void {
    const status = parent.createDiv({ cls: 'wesight-feishu-waiting' });
    const icon = status.createSpan();
    setIcon(icon, 'loader-circle');
    status.createSpan({ text });
  }

  private renderCancelButton(parent: HTMLElement): void {
    const cancel = parent.createEl('button', {
      cls: 'wesight-feishu-link-button',
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => {
      this.options.cli.cancelActiveOperation();
      this.authProgress = null;
      void this.load();
    };
  }

  private renderWarnings(parent: HTMLElement, snapshot: FeishuSnapshot): void {
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

  private async connect(): Promise<void> {
    this.error = null;
    this.consoleUrl = null;
    try {
      if (!this.options.cli.discoverCli().path) {
        window.open(
          'https://github.com/larksuite/cli#installation',
          '_blank',
          'noopener,noreferrer',
        );
        throw new Error('请先按照官方指引独立安装飞书 CLI。');
      }
      await this.options.cli.ensureConfigured(url => {
        this.openedConfigUrl = url;
        this.openExternal(url);
      });
      const progress = await this.options.cli.startAuthorization();
      this.authProgress = progress;
      this.requestRender();
      window.setTimeout(() => void this.finishAuthorization(), 0);
    } catch (error) {
      this.handleError(error, '连接飞书失败');
    }
  }

  private async finishAuthorization(): Promise<void> {
    try {
      this.connection = await this.options.cli.completeAuthorization();
      this.authProgress = null;
      this.error = null;
      new Notice('飞书已连接，全部权限已授权，下次打开无需再次授权。');
      await this.load();
    } catch (error) {
      this.handleError(error, '飞书授权失败');
    }
  }

  private async reauthorize(): Promise<void> {
    try {
      const progress = await this.options.cli.startAuthorization();
      this.authProgress = progress;
      this.requestRender();
      window.setTimeout(() => void this.finishAuthorization(), 0);
    } catch (error) {
      this.handleError(error, '重新授权失败');
    }
  }

  private async disconnect(): Promise<void> {
    const confirmed = await confirmShareAction(this.options.app, {
      title: '断开飞书连接？',
      message: 'WeSight 将清除当前飞书用户授权，已发布的飞书文档会继续保留。',
      confirmText: '断开连接',
      dangerous: true,
    });
    if (!confirmed) return;
    await this.runOperation('正在断开飞书连接…', async () => {
      await this.options.cli.disconnect();
      this.connection = await this.options.cli.getConnectionState();
      new Notice('飞书连接已断开。');
    });
  }

  private async publish(asNew: boolean): Promise<void> {
    if (!this.snapshot || !this.connection?.connected) return;
    const titledSnapshot = withFeishuSnapshotTitle(this.snapshot, this.title);
    const existing = !asNew && this.updateSameDocument ? this.publishState : null;
    const confirmed = await confirmShareAction(this.options.app, {
      title: existing ? '更新飞书文档？' : '发布到飞书文档？',
      message: existing
        ? '当前笔记正文和本地图片会覆盖更新到已关联的飞书文档，并保持原链接。'
        : '当前笔记正文和本地图片会上传到你的飞书空间，并创建一篇新文档。',
      confirmText: existing ? '确认更新' : '确认发布',
    });
    if (!confirmed) return;

    await this.runOperation(existing ? '正在更新飞书文档…' : '正在发布飞书文档…', async () => {
      let documentId: string;
      let url: string;
      if (existing) {
        documentId = existing.documentId;
        url = existing.url;
        await this.options.cli.updateDocument(documentId, titledSnapshot.markdown);
      } else {
        let folderToken = this.options.getSettings().feishuFolderToken.trim();
        if (!folderToken) {
          const folder = await this.options.cli.findOrCreateDefaultFolder();
          folderToken = folder.folderToken;
          this.options.getSettings().feishuFolderToken = folderToken;
          await this.options.saveSettings();
        }
        const created = await this.options.cli.createDocument(
          titledSnapshot.markdown,
          folderToken,
        );
        documentId = created.documentId;
        url = created.url;
      }

      await this.options.cli.insertAssets(
        documentId,
        titledSnapshot.vaultBasePath,
        titledSnapshot.assets,
      );
      const state: FeishuPublishState = {
        documentId,
        url,
        contentHash: titledSnapshot.contentHash,
        updatedAt: new Date().toISOString(),
        title: titledSnapshot.title,
      };
      await this.setPublishState(state);
      this.publishState = state;
      this.duplicatePath = null;
      this.title = state.title;
      new Notice(existing ? '飞书文档已更新。' : '笔记已发布到飞书文档。');
    });
  }

  private async runOperation(label: string, operation: () => Promise<void>): Promise<void> {
    this.operationLabel = label;
    this.error = null;
    this.requestRender();
    try {
      await operation();
    } catch (error) {
      this.handleError(error, '飞书操作失败');
    } finally {
      this.operationLabel = null;
      this.requestRender();
    }
  }

  private async setPublishState(state: FeishuPublishState): Promise<void> {
    await this.options.app.fileManager.processFrontMatter(this.options.file, (frontmatter: Record<string, unknown>) => {
      frontmatter[FEISHU_DOC_ID_FRONTMATTER_KEY] = state.documentId;
      frontmatter[FEISHU_DOC_URL_FRONTMATTER_KEY] = state.url;
      frontmatter[FEISHU_CONTENT_HASH_FRONTMATTER_KEY] = state.contentHash;
      frontmatter[FEISHU_PUBLISHED_AT_FRONTMATTER_KEY] = state.updatedAt;
      frontmatter[FEISHU_TITLE_FRONTMATTER_KEY] = state.title;
    });
  }

  private findDuplicatePath(documentId: string): string | null {
    for (const candidate of this.options.app.vault.getMarkdownFiles()) {
      if (candidate.path === this.options.file.path) continue;
      const value = recordValue(
        this.options.app.metadataCache.getFileCache(candidate)?.frontmatter,
        FEISHU_DOC_ID_FRONTMATTER_KEY,
      );
      if (value === documentId) return candidate.path;
    }
    return null;
  }

  private handleError(error: unknown, fallback: string): void {
    const larkError = error instanceof LarkCliError ? error : null;
    this.error = error instanceof Error ? error.message : fallback;
    this.consoleUrl = larkError?.consoleUrl ?? null;
    this.authProgress = {
      phase: 'failed',
      message: this.error,
      ...(this.consoleUrl ? { consoleUrl: this.consoleUrl } : {}),
    };
    if (this.connection && this.consoleUrl) {
      this.connection = {
        ...this.connection,
        status: 'admin-action-required',
        connected: false,
        consoleUrl: this.consoleUrl,
        message: this.error,
      };
      this.authProgress = null;
    }
    this.requestRender();
  }

  private isAuthFlowVisible(): boolean {
    const phase = this.authProgress?.phase;
    if (!phase) return false;
    return !['idle', 'success'].includes(phase);
  }

  private openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.options.requestRender();
    window.requestAnimationFrame(() => this.options.requestPosition());
  }
}

const CAPABILITY_META_LABELS: Record<FeishuCapabilityId, string> = {
  im: '消息',
  docs: '文档',
  base: '多维表格',
  calendar: '日历',
  drive: '云盘',
};

const CAPABILITY_DESCRIPTIONS: Record<FeishuCapabilityId, string> = {
  im: '读取与发送消息',
  docs: '创建、更新文档并上传图片',
  base: '读取与管理多维表格',
  calendar: '查看与管理日程',
  drive: '查找文件并管理保存位置',
};
