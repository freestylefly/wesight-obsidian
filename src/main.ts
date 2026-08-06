import { type App, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';

import { DEFAULT_SETTINGS, type WeSightObsidianSettings } from './types';
import { ProviderStore } from './storage/providerStore';
import { VaultStore } from './storage/vaultStore';
import { RuntimeManager } from './runtime/runtimeManager';
import { runInlineEdit } from './ui/inlineEdit';
import { WeSightChatView, WESIGHT_VIEW_TYPE } from './ui/chatView';
import { WeSightSettingTab } from './ui/settingsTab';
import { CloudAuthService } from './share/cloudAuth';
import { ShareCloudApi } from './share/cloudApi';
import { LarkCliService } from './feishu/larkCli';
import { SharePopoverController } from './ui/sharePopover';
import { WeChatCloudApi } from './wechat/cloudApi';
import { WeChatThemeService } from './wechat/themeService';
import { DEFAULT_WECHAT_THEME_ID, isWeChatThemeId } from './wechat/themes';
import {
  WeChatPreviewView,
  WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
} from './ui/wechatPreviewView';

import {
  WeChatArticleStatsView,
  WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE,
} from './ui/wechatArticleStatsView';

interface AppWithSettings extends App {
  setting?: {
    open(): void;
    openTabById(id: string): void;
  };
}

export default class WeSightPlugin extends Plugin {
  settings!: WeSightObsidianSettings;
  providerStore!: ProviderStore;
  vaultStore!: VaultStore;
  runtimeManager!: RuntimeManager;
  cloudAuth!: CloudAuthService;
  shareCloudApi!: ShareCloudApi;
  wechatCloudApi!: WeChatCloudApi;
  wechatThemeService!: WeChatThemeService;
  larkCli!: LarkCliService;
  sharePopover!: SharePopoverController;
  settingTab!: WeSightSettingTab;
  private shareActions = new WeakMap<MarkdownView, HTMLElement>();
  private shareActionElements = new Set<HTMLElement>();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.providerStore = new ProviderStore(this.app.secretStorage);
    this.vaultStore = new VaultStore(this.app.vault.adapter);
    this.runtimeManager = new RuntimeManager(this.providerStore, () => this.settings);
    this.cloudAuth = new CloudAuthService(this.app);
    this.shareCloudApi = new ShareCloudApi(this.cloudAuth);
    this.wechatCloudApi = new WeChatCloudApi(this.cloudAuth);
    this.wechatThemeService = new WeChatThemeService({
      runtimeManager: this.runtimeManager,
      providerStore: this.providerStore,
      getSettings: () => this.settings,
    });
    this.larkCli = new LarkCliService();
    this.sharePopover = new SharePopoverController(
      this.app,
      this.cloudAuth,
      this.shareCloudApi,
      this.wechatCloudApi,
      this.larkCli,
      () => this.settings,
      () => this.saveSettings(),
      () => this.openSettings('general'),
      (file) => this.activateWeChatPreview(file),
      (file) => this.activateWeChatArticleStats(file),
    );

    this.registerObsidianProtocolHandler('wesight-auth', params => {
      void this.handleCloudAuthCallback(params.code ?? '');
    });

    this.registerView(
      WESIGHT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new WeSightChatView(leaf, {
        getSettings: () => this.settings,
        saveSettings: () => this.saveSettings(),
        providerStore: this.providerStore,
        vaultStore: this.vaultStore,
        runtimeManager: this.runtimeManager,
        auth: this.cloudAuth,
        openSettings: () => this.openSettings(),
        openWeChatPreview: (file?: TFile) => {
          if (!file) {
            new Notice('没有打开的笔记，无法预览公众号。');
            return Promise.resolve();
          }
          return this.activateWeChatPreview(file);
        },
      }),
    );
    this.registerView(
      WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new WeChatPreviewView(leaf, {
        auth: this.cloudAuth,
        api: this.wechatCloudApi,
        themeService: this.wechatThemeService,
        runtimeManager: this.runtimeManager,
        getSettings: () => this.settings,
        saveSettings: () => this.saveSettings(),
        openSettings: () => this.openSettings('general'),
      }),
    );
   this.registerView(
     WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE,
     (leaf: WorkspaceLeaf) => new WeChatArticleStatsView(leaf, {
        auth: this.cloudAuth,
        getSettings: () => this.settings,
       openSettings: () => this.openSettings('general'),
     }),
   );

    this.addRibbonIcon('sparkles', 'Open WeSight', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'sync-current-note-to-wechat-draft',
      name: '同步当前笔记到公众号草稿箱',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) void this.activateWeChatPreview(view.file);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem(item => item
        .setTitle('同步到公众号草稿箱')
        .setIcon('message-circle')
        .onClick(() => void this.activateWeChatPreview(file)));
    }));

    this.addCommand({
      id: 'inline-edit',
      name: 'Inline edit',
      editorCallback: () => {
        void runInlineEdit(this, this.runtimeManager, () => this.settings);
      },
    });

    this.addCommand({
      id: 'stop-agent',
      name: 'Stop active agent',
      callback: () => {
        this.runtimeManager.cancel();
        new Notice('WeSight stop signal sent.');
      },
    });

    this.addCommand({
      id: 'share-current-note-to-internet',
      name: 'Share current note to internet',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) this.sharePopover.open(view.file, this.shareActions.get(view));
        return true;
      },
    });

    this.addCommand({
      id: 'publish-current-note-to-feishu',
      name: 'Publish current note to Feishu document',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) {
          this.sharePopover.open(view.file, this.shareActions.get(view), 'feishu');
        }
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => this.installMarkdownShareActions());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.installMarkdownShareActions()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.installMarkdownShareActions()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.installMarkdownShareActions()));

    this.settingTab = new WeSightSettingTab(this.app, this, {
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      providerStore: this.providerStore,
      runtimeManager: this.runtimeManager,
      refreshViews: () => this.refreshViews(),
      cloudAuth: this.cloudAuth,
      wechatApi: this.wechatCloudApi,
    });
    this.addSettingTab(this.settingTab);
  }

  override onunload(): void {
    this.sharePopover?.close();
    void this.runtimeManager?.shutdown();
    this.larkCli?.cancelActiveOperation();
    for (const element of this.shareActionElements) element.remove();
    this.shareActionElements.clear();
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({
      type: WESIGHT_VIEW_TYPE,
      active: true,
    });
    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
    }
  }

  async activateWeChatPreview(file: TFile): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(WESIGHT_WECHAT_PREVIEW_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({
        type: WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
        active: true,
        state: { filePath: file.path },
      });
    }
    if (!leaf) {
      new Notice('无法打开公众号预览。');
      return;
    }
    if (leaf.view instanceof WeChatPreviewView) {
      await leaf.view.setFile(file);
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateWeChatArticleStats(file: TFile): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({
        type: WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE,
        active: true,
        state: { filePath: file.path },
      });
    }
    if (!leaf) {
      new Notice('无法打开公众号文章数据。');
      return;
    }
    if (leaf.view instanceof WeChatArticleStatsView) {
      await leaf.view.setFile(file);
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<WeSightObsidianSettings> | null;
    this.settings = normalizeSettings(loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WeSightChatView) {
        void view.onOpen();
      }
    }
  }

  private openSettings(tab?: 'general'): void {
    const setting = (this.app as AppWithSettings).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
      if (tab) this.settingTab?.openTab(tab);
    } else {
      new Notice('Open settings and choose WeSight.');
    }
  }

  private installMarkdownShareActions(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const existing = this.shareActions.get(view);
      if (existing?.isConnected) continue;
      const action = view.addAction('share-2', '分享当前笔记', event => {
        if (view.file) {
          this.sharePopover.open(view.file, event.currentTarget as HTMLElement);
        }
      });
      action.classList.add('wesight-note-share-action');
      this.shareActions.set(view, action);
      this.shareActionElements.add(action);
    }
  }

  private async handleCloudAuthCallback(code: string): Promise<void> {
    try {
      await this.cloudAuth.handleAuthCallback(code);
      new Notice('WeSight 登录成功。');
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'WeSight 登录失败。');
    }
  }
}

function normalizeSettings(value: Partial<WeSightObsidianSettings> | null | undefined): WeSightObsidianSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    configSources: {
      ...DEFAULT_SETTINGS.configSources,
      ...(value?.configSources ?? {}),
      // Codex 仅支持本机配置，旧供应商设置继续保留在存储中。
      codex: 'localCli',
    },
    configuredPaths: {
      ...DEFAULT_SETTINGS.configuredPaths,
      ...(value?.configuredPaths ?? {}),
    },
    providerProfileByAgent: {
      ...DEFAULT_SETTINGS.providerProfileByAgent,
      ...(value?.providerProfileByAgent ?? {}),
    },
    localModelByAgent: {
      ...DEFAULT_SETTINGS.localModelByAgent,
      ...(value?.localModelByAgent ?? {}),
      codex: '',
    },
    wechatThemeId: isWeChatThemeId(value?.wechatThemeId)
      ? value.wechatThemeId
      : DEFAULT_WECHAT_THEME_ID,
    wechatCustomThemeName: typeof value?.wechatCustomThemeName === 'string'
      ? value.wechatCustomThemeName
      : '',
    wechatCustomThemeDescription: typeof value?.wechatCustomThemeDescription === 'string'
      ? value.wechatCustomThemeDescription
      : '',
  };
}
