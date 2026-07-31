import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';

import { DEFAULT_SETTINGS, type WeSightObsidianSettings } from './types';
import { ProviderStore } from './storage/providerStore';
import { VaultStore } from './storage/vaultStore';
import { RuntimeInstaller } from './runtime/installer';
import { RuntimeManager } from './runtime/runtimeManager';
import { runInlineEdit } from './ui/inlineEdit';
import { WeSightChatView, WESIGHT_VIEW_TYPE } from './ui/chatView';
import { WeSightSettingTab } from './ui/settingsTab';
import { CloudAuthService } from './share/cloudAuth';
import { ShareCloudApi } from './share/cloudApi';
import { LarkCliService } from './feishu/larkCli';
import { SharePopoverController } from './ui/sharePopover';
import { WeChatCloudApi } from './wechat/cloudApi';
import {
  WeChatPreviewView,
  WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
} from './ui/wechatPreviewView';

export default class WeSightPlugin extends Plugin {
  settings!: WeSightObsidianSettings;
  providerStore!: ProviderStore;
  vaultStore!: VaultStore;
  runtimeInstaller!: RuntimeInstaller;
  runtimeManager!: RuntimeManager;
  cloudAuth!: CloudAuthService;
  shareCloudApi!: ShareCloudApi;
  wechatCloudApi!: WeChatCloudApi;
  larkCli!: LarkCliService;
  sharePopover!: SharePopoverController;
  settingTab!: WeSightSettingTab;
  private shareActions = new WeakMap<MarkdownView, HTMLElement>();
  private shareActionElements = new Set<HTMLElement>();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.providerStore = new ProviderStore();
    this.vaultStore = new VaultStore(this.app.vault.adapter);
    this.runtimeInstaller = new RuntimeInstaller();
    this.runtimeManager = new RuntimeManager(this.providerStore, () => this.settings);
    this.cloudAuth = new CloudAuthService(this.app);
    this.shareCloudApi = new ShareCloudApi(this.cloudAuth);
    this.wechatCloudApi = new WeChatCloudApi(this.cloudAuth);
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
        runtimeInstaller: this.runtimeInstaller,
        runtimeManager: this.runtimeManager,
        openSettings: () => this.openSettings(),
      }),
    );
    this.registerView(
      WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new WeChatPreviewView(leaf, {
        auth: this.cloudAuth,
        api: this.wechatCloudApi,
        openSettings: () => this.openSettings('general'),
      }),
    );

    this.registerInstallerProgress();

    this.addRibbonIcon('sparkles', 'Open WeSight', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-wesight-chat',
      name: 'Open WeSight chat',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'w' }],
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
      id: 'wesight-inline-edit',
      name: 'Inline edit with WeSight',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'e' }],
      editorCallback: () => {
        void runInlineEdit(this, this.runtimeManager, () => this.settings);
      },
    });

    this.addCommand({
      id: 'wesight-stop-agent',
      name: 'Stop active WeSight agent',
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
      runtimeInstaller: this.runtimeInstaller,
      refreshViews: () => this.refreshViews(),
      cloudAuth: this.cloudAuth,
      wechatApi: this.wechatCloudApi,
    });
    this.addSettingTab(this.settingTab);
  }

  override onunload(): void {
    this.sharePopover?.close();
    for (const element of this.shareActionElements) element.remove();
    this.shareActionElements.clear();
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({
      type: WESIGHT_VIEW_TYPE,
      active: true,
    });
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
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
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<WeSightObsidianSettings> | null;
    this.settings = normalizeSettings(loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  private registerInstallerProgress(): void {
    const unsubscribe = this.runtimeInstaller.onProgress(progress => {
      for (const leaf of this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof WeSightChatView) {
          view.handleInstallProgress(progress);
        }
      }
      if (progress.phase === 'error' || progress.phase === 'unsupported') {
        new Notice(progress.message);
      }
      if (progress.phase === 'success') {
        new Notice(progress.message);
      }
    });
    this.register(unsubscribe);
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
    const setting = (this.app as any).setting;
    if (setting?.open && setting?.openTabById) {
      setting.open();
      setting.openTabById(this.manifest.id);
      if (tab) this.settingTab?.openTab(tab);
    } else {
      new Notice('Open Settings and choose WeSight.');
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
    },
  };
}
