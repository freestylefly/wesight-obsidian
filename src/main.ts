import { CiyuanService } from './ciyuan/service';
import { GitSyncService } from './gitSync/service';
import { generateAiCommitMessage } from './gitSync/commitMessage';
import { runGitSyncAction, runGitSyncPush } from './ui/gitSyncSettings';
import {
  apiVersion,
  type App,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type TAbstractFile,
  WorkspaceLeaf,
} from 'obsidian';

import { DEFAULT_SETTINGS, type WeSightObsidianSettings } from './types';
import { KnowledgeBrain } from './knowledgeBrain/service';
import { KnowledgeBrainEntitlementService } from './knowledgeBrain/entitlement';
import { KnowledgeBrainAccessModal } from './knowledgeBrain/accessModal';
import { ProviderStore } from './storage/providerStore';
import { TokenDanceService } from './tokendance/service';
import { MemberAiService } from './memberAi/service';
import { ClaudeInstaller } from './memberAi/installer';
import { confirmMemberAiDisclosure } from './memberAi/disclosure';
import { memberAiConfigSources } from './memberAi/settings';
import { getVaultBasePath } from './utils/vault';
import { KnowledgePreviewModal } from './knowledgeBrain/previewModal';
import { KnowledgeHealthModal } from './knowledgeBrain/healthModal';
import { VaultStore } from './storage/vaultStore';
import { RuntimeManager } from './runtime/runtimeManager';
import { runInlineEdit } from './ui/inlineEdit';
import { WeSightChatView, WESIGHT_VIEW_TYPE } from './ui/chatView';
import { editorSelectionHighlightExtension } from './ui/editorSelectionHighlight';
import { WeSightSettingTab } from './ui/settingsTab';
import { CloudAuthService } from './share/cloudAuth';
import { ShareCloudApi } from './share/cloudApi';
import { LarkCliService } from './feishu/larkCli';
import { SharePopoverController } from './ui/sharePopover';
import { resolveMultiPublishAccess } from './multiPublish/access';
import { requireMemberFeature } from './ui/memberFeatureGate';
import { MultiPublishBridge } from './multiPublish/bridge';
import { MULTI_PLATFORM_IDS } from './multiPublish/types';
import { XiaohongshuGenerationService } from './xiaohongshu/generationService';
import { XiaohongshuDraftStore } from './xiaohongshu/store';
import { WeiboPostDraftStore } from './weiboPost/store';
import { JikePostDraftStore } from './jikePost/store';
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
  XiaohongshuWorkbenchView,
  WESIGHT_XIAOHONGSHU_VIEW_TYPE,
} from './ui/xiaohongshuWorkbenchView';

import {
  WeChatArticleStatsView,
  WESIGHT_WECHAT_ARTICLE_STATS_VIEW_TYPE,
} from './ui/wechatArticleStatsView';
import {
  shouldNotifyUpdate,
  startUpdatePolling,
  UpdateService,
  type UpdateState,
} from './update/updateService';

// 飞书 refresh token 有效期约 7 天，定期刷新可让授权持续顺延。
const FEISHU_KEEP_ALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface AppWithSettings extends App {
  setting?: {
    open(): void;
    openTabById(id: string): void;
  };
}

export default class WeSightPlugin extends Plugin {
  settings!: WeSightObsidianSettings;
  providerStore!: ProviderStore;
  tokenDance!: TokenDanceService;
  ciyuan!: CiyuanService;
  memberAi!: MemberAiService;
  claudeInstaller!: ClaudeInstaller;
  vaultStore!: VaultStore;
  runtimeManager!: RuntimeManager;
  cloudAuth!: CloudAuthService;
  shareCloudApi!: ShareCloudApi;
  wechatCloudApi!: WeChatCloudApi;
  wechatThemeService!: WeChatThemeService;
  wechatTemplateThemeService!: TemplateThemeService;
  larkCli!: LarkCliService;
  sharePopover!: SharePopoverController;
  multiPublishBridge!: MultiPublishBridge;
  xiaohongshuGenerationService!: XiaohongshuGenerationService;
  xiaohongshuDraftStore!: XiaohongshuDraftStore;
  weiboPostDraftStore!: WeiboPostDraftStore;
  jikePostDraftStore!: JikePostDraftStore;
  settingTab!: WeSightSettingTab;
  knowledgeBrain!: KnowledgeBrain;
  knowledgeBrainEntitlement!: KnowledgeBrainEntitlementService;
  updateService!: UpdateService;
  gitSync!: GitSyncService;
  private shareActions = new WeakMap<MarkdownView, HTMLElement>();
  private xiaohongshuActions = new WeakMap<MarkdownView, HTMLElement>();
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
    this.gitSync = new GitSyncService({
      vaultPath: getVaultBasePath(this.app),
      configDir: this.app.vault.configDir,
      isOnline: () => navigator.onLine,
      notify: message => { new Notice(message, 10_000); },
      generateCommitMessage: (diffs, signal) => generateAiCommitMessage(this.runtimeManager, this.settings, diffs, signal),
    });
    await this.gitSync.initialize();
    this.updateService = new UpdateService({
      currentVersion: this.manifest.version,
      currentAppVersion: apiVersion,
    });
    this.register(this.updateService.onChange(state => this.handleUpdateStateChange(state)));
    this.providerStore = new ProviderStore(this.app.secretStorage);
    this.tokenDance = new TokenDanceService({
      secrets: this.app.secretStorage,
      openExternal: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
    });
    this.ciyuan = new CiyuanService();
    this.vaultStore = new VaultStore(this.app.vault.adapter);
    this.cloudAuth = new CloudAuthService(this.app);
    this.memberAi = new MemberAiService({auth:this.cloudAuth,confirmDisclosure:async userId=>{
      if(this.settings.memberAiConsentUserId===userId)return true;
      if(!(await confirmMemberAiDisclosure(this.app)))return false;
      this.settings.memberAiConsentUserId=userId;await this.saveData(this.settings);return true;
    }});
    this.claudeInstaller = new ClaudeInstaller(()=>this.settings,()=>this.saveSettings());
    this.runtimeManager = new RuntimeManager(this.providerStore, () => this.settings, this.tokenDance, this.memberAi, this.ciyuan);
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
    this.xiaohongshuDraftStore = new XiaohongshuDraftStore(this.app.vault.adapter);
    this.weiboPostDraftStore = new WeiboPostDraftStore(this.app.vault.adapter);
    this.jikePostDraftStore = new JikePostDraftStore(this.app.vault.adapter);
    this.xiaohongshuGenerationService = new XiaohongshuGenerationService({
      runtimeManager: this.runtimeManager,
      vaultStore: this.vaultStore,
      getSettings: () => this.settings,
    });
    this.multiPublishBridge = new MultiPublishBridge({
      getUser: () => this.cloudAuth.getCurrentUser(),
      getBilling: () => {
        const billing = this.cloudAuth.getCurrentUser() ? this.cloudAuth.getBillingSummary() : null;
        return billing ? {
          active: billing.membership.active,
          credits: billing.totalCreditsRemaining,
          planName: billing.membership.planName,
          expiresAt: billing.membership.expiresAt,
        } : null;
      },
      getAccess: async () => {
        const user = await this.cloudAuth.restoreSession();
        if (!user) return resolveMultiPublishAccess(null, null);
        try {
          const billing = await this.cloudAuth.refreshBillingSummary(false);
          if (this.cloudAuth.getCurrentUser()?.userId !== user.userId) {
            throw new Error('WeSight 账号已变更，请重试。');
          }
          return resolveMultiPublishAccess(user, billing);
        } catch (error) {
          if (!this.cloudAuth.getCurrentUser()) return resolveMultiPublishAccess(null, null);
          throw error;
        }
      },
      getPairing: () => this.settings.multiPublishPairing,
      savePairing: async (pairing) => {
        this.settings.multiPublishPairing = pairing;
        await this.saveData(this.settings);
      },
    });
    await this.multiPublishBridge.start();
    this.sharePopover = new SharePopoverController(
      this.app,
      this.cloudAuth,
      this.shareCloudApi,
      this.wechatCloudApi,
      this.larkCli,
      this.multiPublishBridge,
      () => this.settings,
      () => this.saveSettings(),
      () => this.openSettings('general'),
      (file) => this.activateWeChatPreview(file),
      (file) => this.activateWeChatArticleStats(file),
      () => this.openSettings('browserConnector'),
    );
    this.knowledgeBrain = new KnowledgeBrain({
      getRuntimeConfig: agentId => this.settings.configSources[agentId] === 'wesightManaged'
        ? { configSource: 'wesightManaged', model: this.settings.memberAiModel || undefined }
        : { configSource: 'localCli' },
      getVaultPath: () => getVaultBasePath(this.app),
      getMaxContextChars: () => this.settings.maxContextFileChars,
      runtimeManager: this.runtimeManager,
      entitlement: this.knowledgeBrainEntitlement,
    });
    await this.knowledgeBrain.cleanup();
    this.registerEditorExtension(editorSelectionHighlightExtension);

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
        updateService: this.updateService,
        gitSync: this.gitSync,
        openGitSyncSettings: () => this.openSettings('gitSync'),
        auth: this.cloudAuth,
        memberAi: this.memberAi,
        claudeInstaller: this.claudeInstaller,
        openSettings: () => this.openSettings(),
        openImageTextWorkbench: (file: TFile) => this.activateXiaohongshuWorkbench(file),
        openMultiPublish: (file: TFile, anchor?: HTMLElement | null) => {
          this.sharePopover.open(file, anchor ?? null, 'multi-platform');
        },
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
        memberAi: this.memberAi,
        api: this.wechatCloudApi,
        themeService: this.wechatThemeService,
        templateThemeService: this.wechatTemplateThemeService,
        runtimeManager: this.runtimeManager,
        updateService: this.updateService,
        getSettings: () => this.settings,
        saveSettings: () => this.saveSettings(),
        openSettings: () => this.openSettings('general'),
      }),
    );
    this.registerView(
      WESIGHT_XIAOHONGSHU_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new XiaohongshuWorkbenchView(leaf, {
        getSettings: () => this.settings,
        auth: this.cloudAuth,
        bridge: this.multiPublishBridge,
        generationService: this.xiaohongshuGenerationService,
        draftStore: this.xiaohongshuDraftStore,
        weiboPostDraftStore: this.weiboPostDraftStore,
        jikePostDraftStore: this.jikePostDraftStore,
        vaultStore: this.vaultStore,
        openSettings: () => this.openSettings('general'),
        openBrowserConnector: () => this.openSettings('browserConnector'),
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
      id: 'git-sync-pull',
      name: '立即拉取当前仓库',
      callback: () => void runGitSyncAction(() => this.gitSync.pull()),
    });
    this.addCommand({
      id: 'git-sync-push',
      name: '推送当前仓库提交',
      callback: () => void runGitSyncPush(this.app, this.gitSync),
    });
    this.addCommand({
      id: 'git-sync-check',
      name: '检查当前仓库远程更新',
      callback: () => void runGitSyncAction(() => this.gitSync.check()),
    });
    this.addCommand({
      id: 'git-sync-settings',
      name: '打开仓库同步设置',
      callback: () => this.openSettings('gitSync'),
    });
    const markGitActivity = (file: TAbstractFile): void => this.gitSync.markActivity(file.path);
    this.registerEvent(this.app.vault.on('create', markGitActivity));
    this.registerEvent(this.app.vault.on('modify', markGitActivity));
    this.registerEvent(this.app.vault.on('delete', markGitActivity));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.gitSync.markActivity(oldPath);
      this.gitSync.markActivity(file.path);
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.gitSync.onVaultOpened();
      this.registerInterval(window.setInterval(() => void this.gitSync.tick(), 15_000));
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
        .setTitle('WeSight：转为图文动态')
        .setIcon('notebook-pen')
        .onClick(() => void this.activateXiaohongshuWorkbench(file)));
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
        const file = view?.file ?? this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) this.sharePopover.open(file, view ? this.shareActions.get(view) : null);
        return true;
      },
    });

    this.addCommand({
      id: 'publish-current-note-to-feishu',
      name: 'Publish current note to Feishu document',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file ?? this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) {
          this.sharePopover.open(file, view ? this.shareActions.get(view) : null, 'feishu');
        }
        return true;
      },
    });

    this.addCommand({
      id: 'prepare-current-note-for-multiple-platforms',
      name: 'Prepare current note for multiple platforms',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file ?? this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) {
          this.sharePopover.open(file, view ? this.shareActions.get(view) : null, 'multi-platform');
        }
        return true;
      },
    });

    this.addCommand({
      id: 'transform-current-note-to-xiaohongshu',
      name: '将当前文章转为图文动态',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file ?? this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.activateXiaohongshuWorkbench(file);
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => this.installMarkdownShareActions());
    this.app.workspace.onLayoutReady(() => void this.openChatViewOnFirstRun());
    this.app.workspace.onLayoutReady(() => {
      const intervalId = startUpdatePolling(
        () => this.updateService.checkForUpdates(),
        (handler, timeout) => window.setInterval(handler, timeout),
      );
      this.registerInterval(intervalId);
    });
    this.app.workspace.onLayoutReady(() => {
      const keepFeishuAlive = () => { void this.larkCli.keepAlive().catch(() => undefined); };
      keepFeishuAlive();
      this.registerInterval(window.setInterval(keepFeishuAlive, FEISHU_KEEP_ALIVE_INTERVAL_MS));
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.installMarkdownShareActions()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.installMarkdownShareActions()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.installMarkdownShareActions()));

    this.settingTab = new WeSightSettingTab(this.app, this, {
      tokenDance: this.tokenDance,
      ciyuan: this.ciyuan,
      memberAi: this.memberAi,
      claudeInstaller: this.claudeInstaller,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      providerStore: this.providerStore,
      runtimeManager: this.runtimeManager,
      refreshViews: () => this.refreshViews(),
      cloudAuth: this.cloudAuth,
      wechatApi: this.wechatCloudApi,
      knowledgeBrain: this.knowledgeBrain,
      knowledgeBrainEntitlement: this.knowledgeBrainEntitlement,
      larkCli: this.larkCli,
      gitSync: this.gitSync,
      multiPublishBridge: this.multiPublishBridge,
    });
    this.addSettingTab(this.settingTab);
  }

  override onunload(): void {
    this.gitSync?.dispose();
    this.memberAi?.close();
    this.claudeInstaller?.cancel();
    this.tokenDance?.close();
    this.ciyuan?.close();
    this.sharePopover?.close();
    void this.multiPublishBridge?.stop();
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
    const leaf = this.app.workspace.getRightLeaf(false)
      ?? this.app.workspace.getRightLeaf(true);
    await leaf?.setViewState({
      type: WESIGHT_VIEW_TYPE,
      active: true,
    });
    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
    }
  }

  private async openChatViewOnFirstRun(): Promise<void> {
    if (this.settings.chatViewAutoOpened) return;
    if (!this.app.workspace.getLeavesOfType(WESIGHT_VIEW_TYPE).length) {
      await this.activateView();
    }
    this.settings.chatViewAutoOpened = true;
    await this.saveData(this.settings);
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

  async activateXiaohongshuWorkbench(file: TFile): Promise<void> {
    if (!await requireMemberFeature(this.app, this.cloudAuth, '转为图文')) return;
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(WESIGHT_XIAOHONGSHU_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({
        type: WESIGHT_XIAOHONGSHU_VIEW_TYPE,
        active: true,
        state: { filePath: file.path, activeSection: 'copy', activePlatform: 'quick' },
      });
    }
    if (!leaf) {
      new Notice('无法打开图文动态工作台。');
      return;
    }
    if (leaf.view instanceof XiaohongshuWorkbenchView) await leaf.view.showQuick(file);
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
  private openSettings(tab?: 'general' | 'gitSync' | 'browserConnector'): void {
    const setting = (this.app as AppWithSettings).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
      if (tab === 'browserConnector') this.settingTab?.openBrowserConnector();
      else if (tab) this.settingTab?.openTab(tab);
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
      const existingXiaohongshu = this.xiaohongshuActions.get(view);
      if (!existingXiaohongshu?.isConnected) {
        const action = view.addAction('notebook-pen', '转为图文', () => {
          if (view.file?.extension === 'md') void this.activateXiaohongshuWorkbench(view.file);
        });
        action.classList.add('wesight-note-transform-action');
        action.setAttribute('aria-label', '转为图文');
        action.setAttribute('data-tooltip-position', 'bottom');
        this.xiaohongshuActions.set(view, action);
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

  private handleUpdateStateChange(state: Readonly<UpdateState>): void {
    if (!shouldNotifyUpdate(state, this.settings.lastNotifiedUpdateVersion)) return;

    if (!state.latestVersion) return;
    this.settings.lastNotifiedUpdateVersion = state.latestVersion;
    void this.saveData(this.settings).catch(() => undefined);
    if (state.status === 'incompatible') {
      new Notice(
        `发现 WeSight 新版本 ${state.latestVersion}，需要 Obsidian ${state.minAppVersion ?? '更高版本'} 或更高版本。`,
      );
      return;
    }
    new Notice(`发现 WeSight 新版本 ${state.latestVersion}，点击右上角更新入口即可前往更新。`);
  }
}

function normalizeSettings(value: Partial<WeSightObsidianSettings> | null | undefined): WeSightObsidianSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    lastNotifiedUpdateVersion: typeof value?.lastNotifiedUpdateVersion === 'string'
      ? value.lastNotifiedUpdateVersion
      : '',
    // 已有设置数据的老用户视为已打开过，升级后不会被突然弹出侧边栏。
    chatViewAutoOpened: typeof value?.chatViewAutoOpened === 'boolean'
      ? value.chatViewAutoOpened
      : Boolean(value),
    configSources: memberAiConfigSources(value),
    memberAiModel: typeof value?.memberAiModel === 'string' ? value.memberAiModel : '',
    memberAiConsentUserId: typeof value?.memberAiConsentUserId === 'string' ? value.memberAiConsentUserId : '',
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
    multiPublishPlatforms: Array.isArray(value?.multiPublishPlatforms)
      ? MULTI_PLATFORM_IDS.filter(platformId => value.multiPublishPlatforms?.includes(platformId))
      : [...DEFAULT_SETTINGS.multiPublishPlatforms],
    multiPublishPairing: value?.multiPublishPairing
      && typeof value.multiPublishPairing.clientId === 'string'
      && typeof value.multiPublishPairing.secret === 'string'
      && typeof value.multiPublishPairing.pairedAt === 'string'
      ? value.multiPublishPairing
      : null,
  };
}
 import { vaultPluginDir } from './paths';
