import {
  type App,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

import { DEFAULT_SETTINGS, type WeSightObsidianSettings } from './types';
import { KnowledgeBrain } from './knowledgeBrain/service';
import { KnowledgeBrainEntitlementService } from './knowledgeBrain/entitlement';
import { KnowledgeBrainAccessModal } from './knowledgeBrain/accessModal';
import { ProviderStore } from './storage/providerStore';
import { getVaultBasePath } from './utils/vault';
import { KnowledgePreviewModal } from './knowledgeBrain/previewModal';
import { KnowledgeHealthModal } from './knowledgeBrain/healthModal';
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
 import { TemplateThemeService } from './wechat/templateThemeService';
import { obsidianTemplateThemeAdapter } from './wechat/templateThemeAdapter';
import { setTemplateThemeDefinitions } from './wechat/themes';
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
  wechatTemplateThemeService!: TemplateThemeService;
  larkCli!: LarkCliService;
  sharePopover!: SharePopoverController;
  settingTab!: WeSightSettingTab;
  knowledgeBrain!: KnowledgeBrain;
  knowledgeBrainEntitlement!: KnowledgeBrainEntitlementService;
  private shareActions = new WeakMap<MarkdownView, HTMLElement>();
  private knowledgeActions = new WeakMap<MarkdownView, HTMLElement>();
  private shareActionElements = new Set<HTMLElement>();
  private knowledgeActionElements = new Set<HTMLElement>();

  override async onload(): Promise<void> {
    const pluginDir = this.manifest.dir ?? vaultPluginDir(this.app.vault.configDir, this.manifest.id);
    this.wechatTemplateThemeService = new TemplateThemeService(
      obsidianTemplateThemeAdapter(this.app.vault.adapter),
      pluginDir,
    );
    await this.loadTemplateThemeDefinitions();
    await this.loadSettings();
    this.providerStore = new ProviderStore(this.app.secretStorage);
    this.vaultStore = new VaultStore(this.app.vault.adapter);
    this.runtimeManager = new RuntimeManager(this.providerStore, () => this.settings);
    this.cloudAuth = new CloudAuthService(this.app);
    this.knowledgeBrainEntitlement = new KnowledgeBrainEntitlementService(
      this.cloudAuth,
      this.app.secretStorage,
    );
    this.knowledgeBrainEntitlement.start();
    this.register(this.knowledgeBrainEntitlement.onChange(() => this.refreshKnowledgeActionAccess()));
    void this.cloudAuth.restoreSession();
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
    this.knowledgeBrain = new KnowledgeBrain({
      getVaultPath: () => getVaultBasePath(this.app),
      getMaxContextChars: () => this.settings.maxContextFileChars,
      runtimeManager: this.runtimeManager,
      entitlement: this.knowledgeBrainEntitlement,
    });
    await this.knowledgeBrain.cleanup();

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
        knowledgeBrain: this.knowledgeBrain,
        knowledgeBrainEntitlement: this.knowledgeBrainEntitlement,
        auth: this.cloudAuth,
        openSettings: () => this.openSettings(),
        openWeChatPreview: (file?: TFile) => {
          if (!file) {
            new Notice('没有打开的笔记，无法预览公众号。');
            return Promise.resolve();
          }
          return this.activateWeChatPreview(file);
        },
        openSharePopover: (file: TFile, anchor?: HTMLElement | null) => {
          this.sharePopover.open(file, anchor ?? null, 'internet');
        },
      }),
    );
    this.registerView(
      WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new WeChatPreviewView(leaf, {
        auth: this.cloudAuth,
        api: this.wechatCloudApi,
        themeService: this.wechatThemeService,
        templateThemeService: this.wechatTemplateThemeService,
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
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem(item => item
        .setTitle(this.knowledgeBrainEntitlement.getCurrentStatus().allowed
          ? '收录到知识大脑'
          : '收录到知识大脑（会员内测）')
        .setIcon(this.knowledgeBrainEntitlement.getCurrentStatus().allowed ? 'brain' : 'lock-keyhole')
        .onClick(() => void this.collectCurrentNote(file)));
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
      id: 'knowledge-brain-enable',
      name: '开启知识大脑',
      callback: () => void this.enableKnowledgeBrain(),
    });
    this.addCommand({
      id: 'knowledge-brain-health-check',
      name: '知识大脑健康检查',
      checkCallback: checking => {
        if (checking) return true;
        void this.runKnowledgeBrainHealthCheck();
        return true;
      },
    });
    this.addCommand({
      id: 'knowledge-brain-collect-current-note',
      name: '收录当前笔记到知识大脑',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.file.extension !== 'md') return false;
        if (!checking) void this.collectCurrentNote(view.file);
        return true;
      },
    });
    this.addCommand({
      id: 'knowledge-brain-query',
      name: '向知识大脑提问',
      callback: () => void this.knowledgeBrainQuery(),
    });
    this.addCommand({
      id: 'knowledge-brain-save-last-answer',
      name: '保存最近 AI 回答到知识大脑',
      callback: () => void this.saveLatestKnowledgeAnswer(),
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
      knowledgeBrain: this.knowledgeBrain,
      knowledgeBrainEntitlement: this.knowledgeBrainEntitlement,
    });
    this.addSettingTab(this.settingTab);
  }

  override onunload(): void {
    this.sharePopover?.close();
    void this.runtimeManager?.shutdown();
    this.larkCli?.cancelActiveOperation();
    this.knowledgeBrain?.cancel();
    this.knowledgeBrainEntitlement?.dispose();
    void this.knowledgeBrain?.cleanup();
    for (const element of this.shareActionElements) element.remove();
    this.shareActionElements.clear();
    this.knowledgeActionElements.clear();
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
      this.app.workspace.getLeavesOfType(WESIGHT_WECHAT_PREVIEW_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({
        type: WESIGHT_WECHAT_PREVIEW_VIEW_TYPE,
        active: true,
        state: { filePath: file.path, activeTab: 'monitoring' },
      });
    }
    if (!leaf) {
      new Notice('无法打开公众号文章数据。');
      return;
    }
    if (leaf.view instanceof WeChatPreviewView) {
      await leaf.view.showDataMonitoring(file);
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


  private async enableKnowledgeBrain(): Promise<void> {
    if (!(await this.requireKnowledgeBrainAccess())) return;
    const result = await this.knowledgeBrain.enable();
    if (result.ok) {
      this.app.workspace.trigger('layout-change');
      new Notice('知识大脑已开启。');
    } else {
      new Notice(result.error ?? '知识大脑开启失败。');
    }
  }

  private async runKnowledgeBrainHealthCheck(): Promise<void> {
    new Notice('正在运行知识大脑健康检查…');
    const report = await this.knowledgeBrain.runHealthCheck();
    new KnowledgeHealthModal(this.app, report).open();
  }

  private async knowledgeBrainQuery(): Promise<void> {
    if (!(await this.requireKnowledgeBrainAccess())) return;
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)[0];
    if (leaf?.view instanceof WeSightChatView) await leaf.view.activateKnowledgeMode();
  }

  private async collectCurrentNote(file: TFile): Promise<void> {
    if (!(await this.requireKnowledgeBrainAccess())) return;
    const progress = new Notice('正在生成知识大脑收录预览，通常需要 1–3 分钟…', 0);
    try {
      const agentId = await this.resolveKnowledgeAgent();
      const preview = await this.knowledgeBrain.planCollectCurrentNote(file, agentId);
      progress.hide();
      new KnowledgePreviewModal(this.app, preview, async () => {
        const result = await this.knowledgeBrain.applyPreview(preview.previewId);
        if (result.ok) this.app.workspace.trigger('layout-change');
        return result;
      }, async () => this.knowledgeBrain.discardPreview(preview.previewId)).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : '收录失败');
    } finally {
      progress.hide();
    }
  }

  private async saveLatestKnowledgeAnswer(): Promise<void> {
    if (!(await this.requireKnowledgeBrainAccess())) return;
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE)[0];
    if (leaf?.view instanceof WeSightChatView) await leaf.view.saveLatestAnswerToKnowledgeBrain();
  }

  private async resolveKnowledgeAgent(): Promise<'claude' | 'codex'> {
    if (this.settings.defaultAgentId === 'claude' || this.settings.defaultAgentId === 'codex') return this.settings.defaultAgentId;
    const status = await this.knowledgeBrain.probe();
    if (status.availableAgents.claude) return 'claude';
    if (status.availableAgents.codex) return 'codex';
    throw new Error('未检测到可用的 Claude Code 或 Codex。');
  }

  private async requireKnowledgeBrainAccess(): Promise<boolean> {
    const access = await this.knowledgeBrainEntitlement.probe();
    if (access.allowed) return true;
    new KnowledgeBrainAccessModal(
      this.app,
      this.cloudAuth,
      access,
      async () => { await this.knowledgeBrainEntitlement.probe(true); },
    ).open();
    return false;
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
      const existingShare = this.shareActions.get(view);
      if (!existingShare?.isConnected) {
        const action = view.addAction('share-2', '分享当前笔记', event => {
          if (view.file) this.sharePopover.open(view.file, event.currentTarget as HTMLElement);
        });
        action.classList.add('wesight-note-share-action');
        this.shareActions.set(view, action);
        this.shareActionElements.add(action);
      }
      const existingKnowledge = this.knowledgeActions.get(view);
      if (!existingKnowledge?.isConnected) {
        const action = view.addAction('brain', '收录到知识大脑', () => {
          if (view.file?.extension === 'md') void this.collectCurrentNote(view.file);
        });
        action.classList.add('wesight-note-knowledge-action');
        this.knowledgeActions.set(view, action);
        this.shareActionElements.add(action);
        this.knowledgeActionElements.add(action);
        this.refreshKnowledgeActionAccess();
      }
    }
  }

  private refreshKnowledgeActionAccess(): void {
    const allowed = this.knowledgeBrainEntitlement?.getCurrentStatus().allowed === true;
    for (const action of this.knowledgeActionElements) {
      action.toggleClass('is-locked', !allowed);
      action.setAttribute('aria-label', allowed ? '收录到知识大脑' : '收录到知识大脑（会员内测）');
      action.setAttribute('data-tooltip-position', 'bottom');
    }
  }

  private async loadTemplateThemeDefinitions(): Promise<void> {
    try {
      const themes = await this.wechatTemplateThemeService.loadTemplateThemes();
      setTemplateThemeDefinitions(themes.map(theme => theme.definition));
    } catch (error) {
      // 资源包加载失败不应阻塞插件启动；主题菜单会回退到内置主题。
      void error;
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
 import { vaultPluginDir } from './paths';
