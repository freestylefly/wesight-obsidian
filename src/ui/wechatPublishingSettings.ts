import { App, Notice, Setting, setIcon } from 'obsidian';

import { CloudAuthService } from '../share/cloudAuth';
import { WeChatCloudApi } from '../wechat/cloudApi';
import type {
  WeChatAssetDraft,
  WeChatConnectionState,
  WeChatServiceInfo,
} from '../wechat/types';
import { confirmShareAction } from './shareConfirm';
import type { WeSightObsidianSettings } from '../types';

interface WeChatPublishingSettingsOptions {
  app: App;
  auth: CloudAuthService;
  api: WeChatCloudApi;
  requestRender: () => void;
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
}

export class WeChatPublishingSettings {
  private connection: WeChatConnectionState | null | undefined;
  private serviceInfo: WeChatServiceInfo | null = null;
  private loading = false;
  private loaded = false;
  private operation: string | null = null;
  private error: string | null = null;
  private displayName = '';
  private appId = '';
  private appSecret = '';

  constructor(private readonly options: WeChatPublishingSettingsOptions) {}

  activate(force = false): void {
    if (this.loading || (this.loaded && !force)) return;
    void this.load();
  }

  render(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'wesight-settings-section wesight-wechat-settings' });
    section.createEl('h3', { text: '微信公众号' });
    section.createEl('p', {
      cls: 'wesight-settings-section-intro',
      text: '连接后可将当前笔记按 Canghe Style 同步到公众号后台草稿箱。',
    });
    if (this.loading || this.operation) {
      const loading = section.createDiv({ cls: 'wesight-wechat-settings-loading' });
      const icon = loading.createSpan();
      setIcon(icon, 'loader-circle');
      loading.createSpan({ text: this.operation ?? '正在读取公众号连接…' });
      return;
    }
    if (!this.options.auth.getCurrentUser()) {
      const row = new Setting(section)
        .setName('登录 WeSight')
        .setDesc('公众号凭据与草稿状态跟随 WeSight 账号安全保存。');
      row.addButton(button => button
        .setCta()
        .setButtonText('登录')
        .onClick(() => this.options.auth.startLogin()));
      return;
    }
    if (this.error) {
      const error = section.createDiv({ cls: 'wesight-wechat-settings-error' });
      error.createEl('strong', { text: '连接检查失败' });
      error.createSpan({ text: this.error });
      const retry = error.createEl('button', { text: '重新检测' });
      retry.onclick = () => this.activate(true);
    }
    this.renderEgress(section);
    this.renderConnectionForm(section);
   if (this.connection) this.renderConnectedTools(section);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.options.requestRender();
    try {
      const user = await this.options.auth.restoreSession();
      if (!user) {
        this.connection = null;
        return;
      }
      [this.connection, this.serviceInfo] = await Promise.all([
        this.options.api.getConnection(),
        this.options.api.getServiceInfo(),
      ]);
      this.displayName = this.connection?.displayName ?? '';
      this.appId = this.connection?.appId ?? '';
    } catch (error) {
      this.connection = null;
      this.error = error instanceof Error ? error.message : '无法读取公众号连接';
    } finally {
      this.loading = false;
      this.loaded = true;
      this.options.requestRender();
    }
  }

  private renderConnectionForm(section: HTMLElement): void {
    new Setting(section)
      .setName('公众号名称')
      .setDesc('仅用于 WeSight 内显示，不会修改微信后台名称。')
      .addText(text => text
        .setPlaceholder('例如：苍何')
        .setValue(this.displayName)
        .onChange(value => {
          this.displayName = value;
        }));

    new Setting(section)
      .setName('AppID')
      .setDesc('在微信公众平台“开发 → 基本配置”中获取。')
      .addText(text => text
        .setPlaceholder('Wx...')
        .setValue(this.appId)
        .onChange(value => {
          this.appId = value.trim();
        }));

    new Setting(section)
      .setName('AppSecret')
      .setDesc(this.connection ? '留空将继续使用云端已加密保存的密钥。' : '提交后只保存加密值，插件不会保留明文。')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder(this.connection ? '已安全保存' : '请输入 AppSecret')
          .onChange(value => {
            this.appSecret = value.trim();
          });
      });

    new Setting(section)
      .addButton(button => button
        .setCta()
        .setButtonText(this.connection ? '更新并验证' : '连接并验证')
        .onClick(() => void this.saveConnection()));
  }

  private renderEgress(section: HTMLElement): void {
    const ip = this.connection?.egressIp || this.serviceInfo?.egressIp;
    new Setting(section)
      .setName('先配置微信 IP 白名单')
      .setDesc(ip
        ? `请先把 ${ip} 加入微信公众平台“开发 → 基本配置 → IP 白名单”。`
        : 'Cloud 尚未配置固定出口 IP，公众号连接暂不可用。')
      .addButton(button => button
        .setButtonText('复制 IP')
        .setDisabled(!ip)
        .onClick(async () => {
          if (!ip) return;
          await navigator.clipboard.writeText(ip);
          new Notice('固定出口 IP 已复制。');
        }));
  }

  private renderConnectedTools(section: HTMLElement): void {
    const status = section.createDiv({ cls: 'wesight-wechat-connection-status' });
    const icon = status.createSpan();
    setIcon(icon, this.connection?.verified ? 'circle-check' : 'circle-alert');
    const copy = status.createDiv();
    copy.createEl('strong', {
      text: this.connection?.verified ? '公众号连接正常' : '公众号连接需要验证',
    });
    copy.createSpan({
      text: this.connection?.lastVerifiedAt
        ? `上次验证：${new Date(this.connection.lastVerifiedAt).toLocaleString('zh-CN')}`
        : '尚未完成验证',
    });

    new Setting(section)
      .setName('默认封面')
      .setDesc(this.connection?.defaultCoverMediaId
        ? '已上传默认封面。文章未指定封面且没有正文图片时使用。'
        : '可上传一张默认封面，文章也可优先使用 Frontmatter 或正文首图。')
      .addButton(button => button
        .setButtonText(this.connection?.defaultCoverMediaId ? '更换封面' : '上传封面')
        .onClick(() => this.chooseDefaultCover()));

    new Setting(section)
      .addButton(button => button
        .setButtonText('重新验证')
        .onClick(() => void this.verify()))
      .addButton(button => button
        .setWarning()
        .setButtonText('断开连接')
        .onClick(() => void this.disconnect()));
  }

  private async saveConnection(): Promise<void> {
    if (!this.displayName.trim() || !this.appId.trim()) {
      new Notice('请填写公众号名称和 AppID。');
      return;
    }
    if (!this.connection && !this.appSecret) {
      new Notice('首次连接需要填写 AppSecret。');
      return;
    }
    await this.run('正在通过固定出口验证公众号…', async () => {
      this.connection = await this.options.api.saveConnection({
        displayName: this.displayName.trim(),
        appId: this.appId.trim(),
        ...(this.appSecret ? { appSecret: this.appSecret } : {}),
      });
      this.appSecret = '';
      new Notice('微信公众号连接成功。');
    });
  }

  private async verify(): Promise<void> {
    await this.run('正在重新验证公众号…', async () => {
      this.connection = await this.options.api.verifyConnection();
      new Notice('微信公众号验证成功。');
    });
  }


  private async disconnect(): Promise<void> {
    const confirmed = await confirmShareAction(this.options.app, {
      title: '断开微信公众号？',
      message: '云端保存的公众号密钥和草稿关联将被清除，微信后台已有草稿会继续保留。',
      confirmText: '断开连接',
      dangerous: true,
    });
    if (!confirmed) return;
    await this.run('正在断开公众号连接…', async () => {
      await this.options.api.deleteConnection();
      this.connection = null;
      this.displayName = '';
      this.appId = '';
      this.appSecret = '';
      new Notice('微信公众号连接已断开。');
    });
  }

  private chooseDefaultCover(): void {
    const input = createEl('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void this.uploadDefaultCover(file);
    };
    input.click();
  }

  private async uploadDefaultCover(file: File): Promise<void> {
    const previewUrl = URL.createObjectURL(file);
    try {
      await this.run('正在上传默认封面…', async () => {
        const body = await file.arrayBuffer();
        const asset: WeChatAssetDraft = {
          token: '',
          source: file.name,
          fileName: file.name,
          mimeType: file.type,
          contentHash: '',
          body,
          previewUrl,
        };
        const uploaded = await this.options.api.uploadAsset('cover', asset);
        if (uploaded.connection) this.connection = uploaded.connection;
        new Notice('默认封面已更新。');
      });
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
  }

  private async run(label: string, operation: () => Promise<void>): Promise<void> {
    this.operation = label;
    this.error = null;
    this.options.requestRender();
    try {
      await operation();
    } catch (error) {
      this.error = error instanceof Error ? error.message : '公众号操作失败';
      new Notice(this.error);
    } finally {
      this.operation = null;
      this.options.requestRender();
    }
  }
}
