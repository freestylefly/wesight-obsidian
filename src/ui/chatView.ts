import { Editor, ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';

import { AGENT_IDS, getAgentDescriptor } from '../agents';
import wesightLogo from '../../assets/wesight-logo.png';
import type { CloudAuthService } from '../share/cloudAuth';
import type { CloudUser } from '../share/types';
import { ProviderStore } from '../storage/providerStore';
import { VaultStore } from '../storage/vaultStore';
import type {
  AgentId,
  ChatImageArtifact,
  ChatMessage,
  ChatMessageProcessItem,
  ConversationMode,
  FileAttachment,
  ProviderProfile,
  RuntimeConfigSource,
  RuntimeTurnEvent,
  StoredConversation,
  ToolCallEvent,
  WeSightObsidianSettings,
} from '../types';
import type { KnowledgeBrain } from '../knowledgeBrain/service';
import type { KnowledgeBrainEntitlementService } from '../knowledgeBrain/entitlement';
import type { KnowledgeBrainAccessStatus, KnowledgeRuntimeEvent } from '../knowledgeBrain/types';
import { KnowledgePreviewModal } from '../knowledgeBrain/previewModal';
import { KnowledgeBrainAccessModal } from '../knowledgeBrain/accessModal';
import { createId } from '../utils/id';
import { resolveMentions, findMentionQuery, findSlashQuery } from '../utils/context';
import { filterSlashCommands, loadChatSkills, type SlashCommand } from '../utils/slashCommands';
import { getVaultBasePath, resolveVaultAbsolutePath, guessMimeType } from '../utils/vault';
import { RuntimeDiscovery } from '../runtime/discovery';
import { RuntimeManager } from '../runtime/runtimeManager';
import { getClaudeDetectedLocalModel, listLocalModels } from '../runtime/localModels';
import type { UpdateService, UpdateState } from '../update/updateService';
import { RuntimeSetupModal } from './runtimeSetupModal';

export const WESIGHT_VIEW_TYPE = 'wesight-chat-view';

export interface ChatViewDeps {
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  providerStore: ProviderStore;
  vaultStore: VaultStore;
  runtimeManager: RuntimeManager;
  auth: CloudAuthService;
  openSettings: () => void;
  openWeChatPreview: (file?: TFile) => Promise<void>;
  openSharePopover: (file: TFile, anchor?: HTMLElement | null) => void;
  knowledgeBrain: KnowledgeBrain;
  knowledgeBrainEntitlement: KnowledgeBrainEntitlementService;
  updateService: UpdateService;
}

interface ActiveEditorContext {
  file: TFile;
  selection: string;
  currentLine: string;
  cursorLine: number;
  cursorCh: number;
  updatedAt: number;
}

export class WeSightChatView extends ItemView {
  private conversation: StoredConversation | null = null;
  private agentId: AgentId = 'claude';
  private planMode = false;
  private conversationMode: ConversationMode = 'chat';
  private selectedSkill: SlashCommand | null = null;
  private skillPillEl: HTMLElement | null = null;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private accountSlotEl!: HTMLElement;
  private historyButtonEl!: HTMLButtonElement;
  private historyPopoverEl: HTMLElement | null = null;
  private historyTriggerEl: HTMLElement | null = null;
  private sendButtonEl!: HTMLButtonElement;
  private stopButtonEl!: HTMLButtonElement;
  private suggestEl: HTMLElement | null = null;
  private running = false;
  private cancelledByUser = false;
  private viewInitialized = false;
  private dropdownCloseRegistered = false;
  private contextTrackingRegistered = false;
  private contextRowEl: HTMLElement | null = null;
  private cancelHintEl: HTMLElement | null = null;
  private activeEditorContext: ActiveEditorContext | null = null;
  private observedMarkdownView: MarkdownView | null = null;
  private dismissedContextSignature: string | null = null;
  private configSubmenuEl: HTMLElement | null = null;
  private modelSubmenuEl: HTMLElement | null = null;
  private submenuHideTimeout: number | null = null;
  private scrollScheduled = false;
  private authUnsubscribe: (() => void) | null = null;
  private updateUnsubscribe: (() => void) | null = null;
  private knowledgeAccessUnsubscribe: (() => void) | null = null;
  private codexStatusUnsubscribe: (() => void) | null = null;
  private accountMenu: Menu | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly deps: ChatViewDeps) {
    super(leaf);
  }

  override getViewType(): string {
    return WESIGHT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'WeSight';
  }

  override getIcon(): string {
    return 'sparkles';
  }

  async activateKnowledgeMode(): Promise<void> {
    await this.switchConversationMode('knowledge');
  }

  async saveLatestAnswerToKnowledgeBrain(): Promise<void> {
    const message = [...(this.conversation?.messages ?? [])].reverse().find(item => (
      item.role === 'assistant'
      && item.content.trim().length > 0
      && item.metadata?.cancelled !== true
    ));
    if (!message) {
      new Notice('当前对话没有可保存的成功回答。');
      return;
    }
    await this.openKnowledgeSavePreview(message);
  }

  override async onOpen(): Promise<void> {
    if (!this.viewInitialized) {
      this.agentId = this.deps.getSettings().defaultAgentId;
      this.planMode = this.deps.getSettings().planModeDefault;
      this.viewInitialized = true;
    }
    this.containerEl.addClass('wesight-view-container');
    if (!this.dropdownCloseRegistered) {
      this.registerDomEvent(document, 'click', event => this.closeDropdownsOutside(event));
      this.dropdownCloseRegistered = true;
    }
    if (!this.contextTrackingRegistered) {
      this.registerEditorContextTracking();
      this.contextTrackingRegistered = true;
    }
    if (!this.authUnsubscribe) {
      this.authUnsubscribe = this.deps.auth.onChange(() => {
        this.accountMenu?.hide();
        this.accountMenu = null;
        this.renderAccountControl();
      });
    }
    if (!this.updateUnsubscribe) {
      this.updateUnsubscribe = this.deps.updateService.onChange(() => {
        this.accountMenu?.hide();
        this.accountMenu = null;
        this.renderAccountControl();
      });
    }
    if (!this.knowledgeAccessUnsubscribe) {
      this.knowledgeAccessUnsubscribe = this.deps.knowledgeBrainEntitlement.onChange(() => {
        if (this.running) return;
        this.render();
        this.renderMessages();
        this.refreshStatus();
      });
    }
    if (!this.codexStatusUnsubscribe) {
      this.codexStatusUnsubscribe = this.deps.runtimeManager.onCodexStatusChange(() => {
        if (this.agentId !== 'codex' || this.running) return;
        this.render();
        this.renderMessages();
        this.refreshStatus();
      });
    }
    this.updateEditorContextFromWorkspace();
    this.render();
    this.ensureConversation();
    this.renderMessages();
    this.refreshStatus();
    if (this.agentId === 'codex') void this.deps.runtimeManager.refreshCodexStatus();
    void this.restoreAuthSession();
  }

  override async onClose(): Promise<void> {
    // Submenus live on document.body, so they outlive contentEl unless removed here.
    this.hideConfigSubmenu();
    this.hideHistoryPopover();
    this.accountMenu?.hide();
    this.accountMenu = null;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.updateUnsubscribe?.();
    this.updateUnsubscribe = null;
    this.knowledgeAccessUnsubscribe?.();
    this.knowledgeAccessUnsubscribe = null;
    this.codexStatusUnsubscribe?.();
    this.codexStatusUnsubscribe = null;
  }

  private closeAllDropdowns(): void {
    for (const open of Array.from(this.containerEl.querySelectorAll('.wesight-model-selector.is-open'))) {
      open.classList.remove('is-open');
    }
    this.hideConfigSubmenu();
  }

  private closeDropdownsOutside(event: MouseEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    for (const selector of Array.from(this.containerEl.querySelectorAll('.wesight-model-selector.is-open'))) {
      if (!target || !selector.contains(target)) {
        selector.classList.remove('is-open');
        // Close submenu when main dropdown closes
        this.hideConfigSubmenu();
        this.hideModelSubmenu();
      }
    }
    // Close config source submenu if clicking outside
    if (this.configSubmenuEl && this.configSubmenuEl.classList.contains('is-open')) {
      if (!target ||
          (!this.configSubmenuEl.contains(target) &&
           !this.modelSubmenuEl?.contains(target) &&
           !target.closest('.wesight-model-option.has-submenu'))) {
        this.hideConfigSubmenu();
        this.hideModelSubmenu();
      }
    }
    // Close model submenu if clicking outside
    if (this.modelSubmenuEl && this.modelSubmenuEl.classList.contains('is-open')) {
      if (!target ||
          (!this.modelSubmenuEl.contains(target) &&
           !target.closest('.wesight-model-option.has-submenu'))) {
        this.hideModelSubmenu();
      }
    }
    // Close history popover if clicking outside
    if (this.historyPopoverEl && (!target || (!this.historyPopoverEl.contains(target) && target !== this.historyButtonEl))) {
      this.hideHistoryPopover();
    }
  }

  private registerEditorContextTracking(): void {
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) {
        this.observedMarkdownView = leaf.view;
        this.captureMarkdownViewContext(leaf.view);
      }
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.observedMarkdownView = activeView;
        this.captureMarkdownViewContext(activeView);
        return;
      }
      if (file instanceof TFile && this.activeEditorContext?.file.path !== file.path) {
        this.captureFileOnlyContext(file);
      }
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info.file instanceof TFile) {
        this.captureEditorContext(editor, info.file);
      }
    }));
    // The workspace events above miss cursor/selection movement, so a light poll
    // remains — but only while this panel is actually visible.
    this.registerInterval(window.setInterval(() => {
      if (!this.containerEl.isShown()) return;
      this.updateEditorContextFromWorkspace();
    }, 600));
  }

  private updateEditorContextFromWorkspace(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.observedMarkdownView = activeView;
      this.captureMarkdownViewContext(activeView);
      return;
    }
    if (this.observedMarkdownView?.file instanceof TFile) {
      this.captureMarkdownViewContext(this.observedMarkdownView);
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && this.activeEditorContext?.file.path !== activeFile.path) {
      this.captureFileOnlyContext(activeFile);
    }
  }

  private captureMarkdownViewContext(view: MarkdownView): void {
    if (!(view.file instanceof TFile)) return;
    this.captureEditorContext(view.editor, view.file);
  }

  private captureFileOnlyContext(file: TFile): void {
    this.updateActiveEditorContext({
      file,
      selection: '',
      currentLine: '',
      cursorLine: 0,
      cursorCh: 0,
      updatedAt: Date.now(),
    });
  }

  private captureEditorContext(editor: Editor, file: TFile): void {
    const cursor = editor.getCursor();
    let currentLine = '';
    try {
      currentLine = editor.getLine(cursor.line);
    } catch {
      currentLine = '';
    }
    this.updateActiveEditorContext({
      file,
      selection: editor.getSelection(),
      currentLine,
      cursorLine: cursor.line,
      cursorCh: cursor.ch,
      updatedAt: Date.now(),
    });
  }

  private updateActiveEditorContext(context: ActiveEditorContext): void {
    const previousSignature = this.activeEditorContext ? contextSignature(this.activeEditorContext) : '';
    const nextSignature = contextSignature(context);
    this.activeEditorContext = context;
    if (previousSignature !== nextSignature) {
      this.renderActiveContextChip();
    }
  }

  private getVisibleEditorContext(): ActiveEditorContext | null {
    if (!this.activeEditorContext) return null;
    if (this.dismissedContextSignature === contextSignature(this.activeEditorContext)) return null;
    return this.activeEditorContext;
  }

  private renderActiveContextChip(): void {
    if (!this.contextRowEl) return;
    this.contextRowEl.empty();
    const context = this.getVisibleEditorContext();
    this.contextRowEl.toggleClass('has-content', Boolean(context));
    if (!context) return;

    const hasSelection = Boolean(context.selection.trim());
    const fileChip = this.contextRowEl.createDiv({ cls: 'wesight-file-chip' });
    fileChip.toggleClass('has-selection', hasSelection);
    fileChip.setAttribute('title', hasSelection
      ? `${context.file.path}\n\n${context.selection.trim()}`
      : context.file.path);
    const fileIcon = fileChip.createSpan({ cls: 'wesight-file-chip-icon' });
    setIcon(fileIcon, hasSelection ? 'text-select' : 'file-text');
    fileChip.createSpan({
      cls: 'wesight-file-chip-name',
      text: hasSelection
        ? `${context.file.basename} · 已选中 ${countTextChars(context.selection)} 字`
        : context.file.path,
    });
    const close = fileChip.createEl('button', {
      cls: 'wesight-file-chip-remove',
      attr: { type: 'button', 'aria-label': '忽略当前 Obsidian 上下文' },
    });
    setIcon(close, 'x');
    close.onclick = event => {
      event.stopPropagation();
      this.dismissedContextSignature = contextSignature(context);
      this.renderActiveContextChip();
    };
  }

  private knowledgeComposerPlaceholder(): string {
    if (this.conversationMode !== 'knowledge') return 'Message WeSight...';
    const access = this.deps.knowledgeBrainEntitlement.getCurrentStatus();
    return access.allowed ? '基于知识库提问…' : (access.reason ?? '会员内测功能暂不可用');
  }

  private openKnowledgeAccess(access: KnowledgeBrainAccessStatus): void {
    new KnowledgeBrainAccessModal(
      this.app,
      this.deps.auth,
      access,
      async () => { await this.deps.knowledgeBrainEntitlement.probe(true); },
    ).open();
  }

  private async requireKnowledgeAccess(): Promise<boolean> {
    const access = await this.deps.knowledgeBrainEntitlement.probe();
    if (access.allowed) return true;
    this.openKnowledgeAccess(access);
    return false;
  }

  private render(): void {
    this.hideConfigSubmenu();
    this.hideModelSubmenu();
    const root = this.contentEl;
    // Keep whatever the user has typed across re-renders.
    const pendingInput = this.inputEl?.value ?? '';
    root.empty();
    root.addClass('wesight-view');
    root.setAttribute('data-agent', this.agentId);
    root.setAttribute('data-chat-mode', this.conversationMode);

    const header = root.createDiv({ cls: 'wesight-header' });
    const brand = header.createDiv({ cls: 'wesight-title-slot' });
    brand.createEl('img', {
      cls: 'wesight-logo-image',
      attr: {
        src: wesightLogo,
        alt: '',
        'aria-hidden': 'true',
      },
    });
    brand.createEl('h4', { text: 'WeSight', cls: 'wesight-title-text' });

    const headerActions = header.createDiv({ cls: 'wesight-header-actions' });

    const shareButton = headerActions.createEl('button', { cls: 'wesight-share-btn' });
    const shareIcon = shareButton.createSpan({ cls: 'wesight-share-btn-icon' });
    setIcon(shareIcon, 'share');
    shareButton.createSpan({ cls: 'wesight-share-btn-label', text: '分享' });
    shareButton.ariaLabel = '打开分享面板';
    shareButton.onclick = () => void this.openSharePopover(shareButton);

    const wechatPublishButton = headerActions.createEl('button', { cls: 'wesight-wechat-publish-btn' });
    const wechatIcon = wechatPublishButton.createSpan({ cls: 'wesight-wechat-publish-icon' });
    setIcon(wechatIcon, 'message-circle');
    wechatPublishButton.createSpan({ cls: 'wesight-wechat-publish-label', text: '发公众号' });
    wechatPublishButton.ariaLabel = '打开公众号预览';
    wechatPublishButton.onclick = () => void this.openWeChatPreview();

    const newChatButton = headerActions.createEl('button', { cls: 'clickable-icon wesight-header-btn' });
    setIcon(newChatButton, 'plus');
    newChatButton.ariaLabel = 'New WeSight chat';
    newChatButton.onclick = () => void this.startNewConversation();

    this.historyButtonEl = headerActions.createEl('button', { cls: 'clickable-icon wesight-header-btn' });
    setIcon(this.historyButtonEl, 'history');
    this.historyButtonEl.ariaLabel = '历史对话记录';
    this.historyButtonEl.onclick = event => {
      event.stopPropagation();
      this.toggleHistoryPopover(this.historyButtonEl);
    };

    const settingsButton = headerActions.createEl('button', { cls: 'clickable-icon wesight-header-btn' });
    setIcon(settingsButton, 'settings');
    settingsButton.ariaLabel = 'Open WeSight settings';
    settingsButton.onclick = this.deps.openSettings;

    this.accountSlotEl = headerActions.createDiv({ cls: 'wesight-account-slot' });
    this.renderAccountControl();

    const messagesWrapper = root.createDiv({ cls: 'wesight-messages-wrapper' });
    this.messagesEl = messagesWrapper.createDiv({ cls: 'wesight-chat-log' });

    const composer = root.createDiv({ cls: 'wesight-input-container' });
    const inputWrapper = composer.createDiv({ cls: 'wesight-input-wrapper' });
    inputWrapper.toggleClass('wesight-input-plan-mode', this.planMode);

    this.contextRowEl = inputWrapper.createDiv({ cls: 'wesight-context-row' });
    this.renderActiveContextChip();

    this.cancelHintEl = inputWrapper.createDiv({ cls: 'wesight-cancel-hint', text: '按下ESC取消当前任务' });
    this.cancelHintEl.toggleClass('is-visible', false);

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'wesight-input',
      attr: {
        placeholder: this.knowledgeComposerPlaceholder(),
      },
    });
    const currentAccess = this.deps.knowledgeBrainEntitlement.getCurrentStatus();
    this.inputEl.disabled = this.conversationMode === 'knowledge' && !currentAccess.allowed;
    this.inputEl.value = pendingInput;
    this.renderSkillPill();
    this.inputEl.oninput = () => void this.updateSuggestions();
    this.inputEl.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
      if (event.key === 'Escape') {
        if (this.running) {
          event.preventDefault();
          event.stopPropagation();
          this.cancelledByUser = true;
          this.deps.runtimeManager.cancel();
          this.deps.knowledgeBrain.cancel();
        }
        this.clearSuggestions();
      }
    };

    const toolbar = inputWrapper.createDiv({ cls: 'wesight-input-toolbar' });
    const toolbarLeft = toolbar.createDiv({ cls: 'wesight-toolbar-left' });
    this.renderAgentSelector(toolbarLeft);
    this.renderModelSelector(toolbarLeft);

    const toolbarRight = toolbar.createDiv({ cls: 'wesight-toolbar-right' });
    const knowledgeActive = this.conversationMode === 'knowledge';
    const knowledgeToggle = toolbarRight.createEl('button', {
      cls: 'wesight-permission-toggle wesight-kb-mode-switch',
      attr: {
        type: 'button',
        'aria-label': '切换普通对话与知识库模式',
        'aria-pressed': String(knowledgeActive),
      },
    });
    knowledgeToggle.toggleClass('is-locked', !currentAccess.allowed);
    const knowledgeLabel = knowledgeToggle.createSpan({ cls: 'wesight-permission-label wesight-kb-mode-label', text: '知识库' });
    if (!currentAccess.allowed) {
      const lock = knowledgeToggle.createSpan({ cls: 'wesight-kb-mode-lock' });
      setIcon(lock, 'lock-keyhole');
    }
    knowledgeLabel.toggleClass('knowledge-active', knowledgeActive);
    const knowledgeSwitch = knowledgeToggle.createDiv({ cls: 'wesight-toggle-switch' });
    knowledgeSwitch.toggleClass('active', knowledgeActive);
    knowledgeToggle.onclick = () => {
      if (!currentAccess.allowed && !knowledgeActive) {
        this.openKnowledgeAccess(currentAccess);
        return;
      }
      void this.switchConversationMode(knowledgeActive ? 'chat' : 'knowledge');
    };

    const planToggle = toolbarRight.createDiv({ cls: 'wesight-permission-toggle' });
    planToggle.toggleClass('is-hidden', this.conversationMode === 'knowledge');
    const planLabel = planToggle.createSpan({ cls: 'wesight-permission-label', text: 'Plan' });
    planLabel.toggleClass('plan-active', this.planMode);
    const planSwitch = planToggle.createDiv({ cls: 'wesight-toggle-switch' });
    planSwitch.toggleClass('active', this.planMode);
    // Session-local toggle; the persistent default lives in the settings tab.
    planToggle.onclick = () => {
      this.planMode = !this.planMode;
      inputWrapper.toggleClass('wesight-input-plan-mode', this.planMode);
      planLabel.toggleClass('plan-active', this.planMode);
      planSwitch.toggleClass('active', this.planMode);
    };

    const attachButton = toolbarRight.createEl('button', { cls: 'clickable-icon wesight-toolbar-btn' });
    setIcon(attachButton, 'paperclip');
    attachButton.ariaLabel = 'Attach active note';
    attachButton.onclick = () => this.attachActiveNote();

    this.stopButtonEl = toolbarRight.createEl('button', { cls: 'clickable-icon wesight-toolbar-btn' });
    setIcon(this.stopButtonEl, 'square');
    this.stopButtonEl.ariaLabel = 'Stop active run';
    this.stopButtonEl.disabled = !this.running;
    this.stopButtonEl.onclick = () => {
      this.cancelledByUser = true;
      this.deps.runtimeManager.cancel();
      this.deps.knowledgeBrain.cancel();
    };

    this.sendButtonEl = toolbarRight.createEl('button', { cls: 'clickable-icon wesight-send-btn' });
    setIcon(this.sendButtonEl, 'arrow-up');
    this.sendButtonEl.ariaLabel = 'Send message';
    this.sendButtonEl.onclick = () => void this.sendMessage();
  }

  private async restoreAuthSession(): Promise<void> {
    await this.deps.auth.restoreSession();
    this.renderAccountControl();
  }

  private renderAccountControl(): void {
    if (!this.accountSlotEl) return;
    this.accountSlotEl.empty();
    const user = this.deps.auth.getCurrentUser();
    const updateState = this.deps.updateService.getState();

    if (!user) {
      if (hasPendingUpdate(updateState)) {
        const update = this.accountSlotEl.createEl('button', {
          cls: 'wesight-header-update-button',
          text: '更新',
          attr: {
            type: 'button',
            'aria-label': updateState.status === 'incompatible'
              ? `WeSight ${updateState.latestVersion ?? ''} 需要更高版本的 Obsidian`
              : `前往更新 WeSight ${updateState.latestVersion ?? ''}`,
          },
        });
        update.onclick = event => {
          event.stopPropagation();
          this.handleKnownUpdate(updateState);
        };
      }
      const login = this.accountSlotEl.createEl('button', {
        cls: 'wesight-login-button',
        text: '登录',
        attr: {
          type: 'button',
          'aria-label': '登录 WeSight',
        },
      });
      login.onclick = () => this.deps.auth.startLogin();
      return;
    }

    const account = this.accountSlotEl.createEl('button', {
      cls: 'clickable-icon wesight-account-button',
      attr: {
        type: 'button',
        'aria-label': `${user.nickname}，打开账户菜单`,
        title: user.nickname,
        'aria-haspopup': 'menu',
      },
    });
    const avatar = account.createSpan({ cls: 'wesight-account-avatar' });
    this.renderUserAvatar(avatar, user);
    if (hasPendingUpdate(updateState)) {
      account.addClass('has-update');
      account.createSpan({ cls: 'wesight-update-dot', attr: { 'aria-hidden': 'true' } });
      account.setAttribute(
        'aria-label',
        `${user.nickname}，发现 WeSight 新版本 ${updateState.latestVersion ?? ''}，打开账户菜单`,
      );
    }
    account.onclick = (event) => {
      event.stopPropagation();
      this.openAccountMenu(account, user);
    };
  }

  private renderUserAvatar(parent: HTMLElement, user: CloudUser): void {
    parent.empty();
    const renderFallback = () => {
      parent.empty();
      const icon = parent.createSpan({ cls: 'wesight-account-avatar-fallback' });
      setIcon(icon, 'user-round');
    };
    if (!user.avatarUrl) {
      renderFallback();
      return;
    }
    const image = parent.createEl('img', {
      cls: 'wesight-account-avatar-image',
      attr: {
        src: user.avatarUrl,
        alt: '',
      },
    });
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onerror = renderFallback;
  }

  private openAccountMenu(anchor: HTMLElement, user: CloudUser): void {
    this.accountMenu?.hide();
    const menu = new Menu();
    const profile = createFragment();
    const profileRow = createDiv();
    profileRow.className = 'wesight-account-menu-profile';
    const avatar = createSpan();
    avatar.className = 'wesight-account-avatar wesight-account-menu-avatar';
    this.renderUserAvatar(avatar, user);
    const nickname = createSpan();
    nickname.className = 'wesight-account-menu-nickname';
    nickname.textContent = user.nickname;
    profileRow.append(avatar, nickname);
    profile.append(profileRow);
    menu.addItem(item => item
      .setTitle(profile)
      .setIsLabel(true));
    const billing = this.deps.auth.getBillingSummary();
    menu.addItem(item => item
      .setTitle(billing
        ? `${billing.membership.active ? '创作者会员' : '免费用户'} · ${billing.totalCreditsRemaining} 积分`
        : '正在加载积分…')
      .setIcon('gem')
      .setIsLabel(true));
    menu.addSeparator();
    this.addUpdateMenuItem(menu);
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('账户详情')
      .setIcon('circle-user-round')
      .onClick(() => this.deps.auth.openAccount()));
    if (user.isAdmin) {
      menu.addItem(item => item
        .setTitle('管理后台')
        .setIcon('layout-dashboard')
        .onClick(() => this.deps.auth.openAdmin()));
    }
    menu.addItem(item => item
      .setTitle('会员与积分')
      .setIcon('wallet-cards')
      .onClick(() => this.deps.auth.openBilling()));
    menu.addItem(item => item
      .setTitle('退出登录')
      .setIcon('log-out')
      .onClick(() => {
        this.deps.auth.clearSession();
        new Notice('已退出 WeSight。');
      }));
    menu.onHide(() => {
      if (this.accountMenu === menu) this.accountMenu = null;
    });
    const bounds = anchor.getBoundingClientRect();
    const accountMenuWidth = 190;
    menu.showAtPosition({
      x: Math.max(8, bounds.right - accountMenuWidth),
      y: bounds.bottom + 4,
      width: accountMenuWidth,
    });
    this.accountMenu = menu;
  }

  private addUpdateMenuItem(menu: Menu): void {
    const state = this.deps.updateService.getState();
    if (state.status === 'checking') {
      menu.addItem(item => item
        .setTitle('正在检查更新…')
        .setIcon('refresh-cw')
        .setDisabled(true));
      return;
    }
    if (state.status === 'available') {
      menu.addItem(item => item
        .setTitle(`发现新版本 ${state.latestVersion ?? ''}`)
        .setIcon('download')
        .onClick(() => this.deps.updateService.openOfficialUpdatePage()));
      return;
    }
    if (state.status === 'incompatible') {
      menu.addItem(item => item
        .setTitle(`新版本 ${state.latestVersion ?? ''} 需要 Obsidian ${state.minAppVersion ?? '更高版本'}`)
        .setIcon('triangle-alert')
        .onClick(() => this.handleKnownUpdate(state)));
      return;
    }
    menu.addItem(item => item
      .setTitle('检查更新')
      .setIcon('refresh-cw')
      .onClick(() => void this.checkForUpdatesManually()));
  }

  private async checkForUpdatesManually(): Promise<void> {
    try {
      const state = await this.deps.updateService.checkForUpdates();
      if (state.status === 'available') {
        this.deps.updateService.openOfficialUpdatePage();
        return;
      }
      if (state.status === 'incompatible') {
        this.handleKnownUpdate(state);
        return;
      }
      new Notice(`当前已是最新版本 ${state.currentVersion}。`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : `检查更新失败：${String(error)}`);
    }
  }

  private handleKnownUpdate(state: Readonly<UpdateState>): void {
    if (state.status === 'incompatible') {
      new Notice(
        `WeSight ${state.latestVersion ?? '新版本'} 需要 Obsidian ${state.minAppVersion ?? '更高版本'} 或更高版本。`,
      );
      return;
    }
    this.deps.updateService.openOfficialUpdatePage();
  }

  private setupDropdown(selector: HTMLElement, button: HTMLElement): void {
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.onclick = event => {
      event.stopPropagation();
      const wasOpen = selector.classList.contains('is-open');
      this.closeAllDropdowns();
      if (!wasOpen) {
        selector.classList.add('is-open');
      }
    };
    button.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        button.click();
      }
      if (event.key === 'Escape') {
        selector.classList.remove('is-open');
      }
    };
  }

  private renderAgentSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({ cls: 'wesight-model-selector wesight-agent-selector' });
    const button = selector.createDiv({ cls: 'wesight-model-btn' });
    button.createSpan({ cls: 'wesight-model-label', text: getAgentDescriptor(this.agentId).displayName });
    const chevron = button.createSpan({ cls: 'wesight-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const dropdown = selector.createDiv({ cls: 'wesight-model-dropdown' });
    dropdown.createDiv({ cls: 'wesight-model-group', text: 'Agent' });
    const settings = this.deps.getSettings();
    const discovery = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    });
    for (const agentId of AGENT_IDS) {
      const descriptor = getAgentDescriptor(agentId);
      const status = discovery.resolve(agentId);
      const hasSubmenu = agentId === 'claude' || agentId === 'codex';
      const option = dropdown.createDiv({ cls: `wesight-model-option${hasSubmenu ? ' has-submenu' : ''}` });
      option.toggleClass('selected', agentId === this.agentId);
      option.tabIndex = 0;
      const icon = option.createSpan({ cls: 'wesight-option-icon' });
      setIcon(icon, status.found ? 'check' : 'circle-alert');
      option.createSpan({ text: descriptor.displayName });

      if (hasSubmenu) {
        option.createSpan({
          cls: 'wesight-option-note',
          text: configSourceLabel(settings.configSources[agentId]),
        });
        const submenuArrow = option.createSpan({ cls: 'wesight-submenu-arrow' });
        setIcon(submenuArrow, 'chevron-right');
        option.addEventListener('mouseenter', () => {
          this.showConfigSubmenu(agentId, option);
        });
        option.addEventListener('mouseleave', () => {
          this.scheduleHideSubmenu();
        });
        option.onfocus = () => this.showConfigSubmenu(agentId, option);
        option.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
            event.preventDefault();
            this.showConfigSubmenu(agentId, option);
          }
          if (event.key === 'Escape') {
            this.hideConfigSubmenu();
          }
        };
        option.onclick = event => {
          event.stopPropagation();
          this.showConfigSubmenu(agentId, option);
        };
      } else {
        option.createSpan({
          cls: status.found ? 'wesight-option-note' : 'wesight-option-note is-missing',
          text: status.found ? 'ready' : 'missing',
        });
        option.onclick = event => {
          event.stopPropagation();
          void this.switchAgent(agentId, !status.found);
        };
      }
    }
  }

  private showConfigSubmenu(agentId: AgentId, triggerEl: HTMLElement): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
      this.submenuHideTimeout = null;
    }

    this.hideConfigSubmenu();

    const settings = this.deps.getSettings();
    const currentSource = settings.configSources[agentId];

    const submenu = createDiv();
    submenu.className = 'wesight-config-submenu';

    submenu.createDiv({ cls: 'wesight-model-group', text: '配置来源' });

    this.renderConfigSourceOption(submenu, {
      agentId,
      source: 'localCli',
      currentSource,
      icon: 'hard-drive',
      label: '本机配置',
    });
    this.renderConfigSourceOption(submenu, {
      agentId,
      source: 'providerProfile',
      currentSource,
      icon: 'sparkles',
      label: 'WeSight 配置',
      disabled: agentId === 'codex',
    });

    document.body.appendChild(submenu);
    void submenu.offsetHeight;

    const triggerRect = triggerEl.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = triggerRect.top - 4;
    let left = triggerRect.right + 4;

    // 右边界检测：如果右侧放不下，就显示在选项左侧
    if (left + submenuRect.width > viewportWidth - 8) {
      left = triggerRect.left - submenuRect.width - 4;
    }

    // 下边界检测：如果下方放不下，就向上调整
    if (top + submenuRect.height > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - submenuRect.height - 8);
    }

    submenu.style.top = `${top}px`;
    submenu.style.left = `${left}px`;
    submenu.setCssProps({ zIndex: 'var(--layer-modal, 10000)' });
    submenu.addClass('is-open');

    submenu.addEventListener('mouseenter', () => {
      if (this.submenuHideTimeout) {
        window.clearTimeout(this.submenuHideTimeout);
        this.submenuHideTimeout = null;
      }
    });

    submenu.addEventListener('mouseleave', () => {
      this.scheduleHideSubmenu();
    });

    this.configSubmenuEl = submenu;
  }

  private renderConfigSourceOption(parent: HTMLElement, options: {
    agentId: AgentId;
    source: RuntimeConfigSource;
    currentSource: RuntimeConfigSource;
    icon: string;
    label: string;
    disabled?: boolean;
  }): void {
    const option = parent.createDiv({ cls: 'wesight-model-option wesight-config-source-option' });
    option.toggleClass('disabled', Boolean(options.disabled));
    option.toggleClass('selected', options.currentSource === options.source);
    const optionIcon = option.createSpan({ cls: 'wesight-option-icon' });
    setIcon(optionIcon, options.icon);
    option.createSpan({ text: options.label });
    const currentModelLabel = this.getCurrentModelLabel(options.agentId, options.source);
    if (currentModelLabel) {
      option.createSpan({ cls: 'wesight-option-note', text: currentModelLabel });
    }
    if (options.currentSource === options.source) {
      const checkIcon = option.createSpan({ cls: 'wesight-option-check' });
      setIcon(checkIcon, 'check');
    }
    option.onclick = event => {
      event.stopPropagation();
      if (options.disabled) return;
      void this.selectConfigSource(options.agentId, options.source);
    };
  }

  private getCurrentModelLabel(agentId: AgentId, source: RuntimeConfigSource): string {
    const settings = this.deps.getSettings();
    if (agentId === 'codex' && source === 'providerProfile') return '不可用';
    if (source === 'localCli') {
      if (agentId === 'claude') {
        return getClaudeDetectedLocalModel()?.label ?? '跟随 Claude Code';
      }
      if (agentId === 'codex') {
        const status = this.deps.runtimeManager.getCodexStatus();
        return status.currentModel?.displayName ?? status.currentModelId ?? '跟随 Codex App';
      }
      const selectedModel = settings.localModelByAgent[agentId] ?? '';
      if (!selectedModel) {
        const detected = listLocalModels(agentId).find(m => m.id);
        return detected?.label ?? '默认';
      }
      return listLocalModels(agentId).find(m => m.id === selectedModel)?.label ?? selectedModel;
    } else {
      const profileId = settings.providerProfileByAgent[agentId];
      const profiles = this.deps.providerStore.list(agentId);
      const profile = profileId ? profiles.find(p => p.id === profileId) : profiles.find(p => p.isDefault);
      if (profile) return profile.name;
      return '未配置';
    }
  }

  private showModelSubmenu(options: {
    triggerEl: HTMLElement;
    title: string;
    items: Array<{
      id: string;
      label: string;
      note?: string;
      icon: string;
      selected: boolean;
      onSelect: () => void | Promise<void>;
    }>;
  }): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
      this.submenuHideTimeout = null;
    }

    this.hideModelSubmenu();

    const submenu = createDiv();
    submenu.className = 'wesight-model-submenu';
    submenu.createDiv({ cls: 'wesight-model-group', text: options.title });
    if (options.items.length === 0) {
      const empty = submenu.createDiv({ cls: 'wesight-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'wesight-option-icon' });
      setIcon(emptyIcon, 'circle-alert');
      empty.createSpan({ text: '暂无可选模型' });
    }
    for (const item of options.items) {
      const option = submenu.createDiv({ cls: 'wesight-model-option' });
      option.toggleClass('selected', item.selected);
      const icon = option.createSpan({ cls: 'wesight-option-icon' });
      setIcon(icon, item.icon);
      option.createSpan({ text: item.label });
      if (item.note) {
        option.createSpan({ cls: 'wesight-option-note', text: item.note });
      }
      if (item.selected) {
        const checkIcon = option.createSpan({ cls: 'wesight-option-check' });
        setIcon(checkIcon, 'check');
      }
      option.onclick = event => {
        event.stopPropagation();
        void item.onSelect();
      };
    }

    document.body.appendChild(submenu);
    void submenu.offsetHeight;

    const triggerRect = options.triggerEl.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = triggerRect.top - 4;
    let left = triggerRect.right + 4;

    // 右边界检测：如果右侧放不下，就显示在选项左侧
    if (left + submenuRect.width > viewportWidth - 8) {
      left = triggerRect.left - submenuRect.width - 4;
    }

    // 下边界检测：如果下方放不下，就向上调整
    if (top + submenuRect.height > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - submenuRect.height - 8);
    }

    submenu.style.top = `${top}px`;
    submenu.style.left = `${left}px`;
    submenu.setCssProps({ zIndex: 'var(--layer-modal, 10001)' });
    submenu.addClass('is-open');

    submenu.addEventListener('mouseenter', () => {
      if (this.submenuHideTimeout) {
        window.clearTimeout(this.submenuHideTimeout);
        this.submenuHideTimeout = null;
      }
    });

    submenu.addEventListener('mouseleave', () => {
      this.scheduleHideSubmenu();
    });

    this.modelSubmenuEl = submenu;
  }

  private hideModelSubmenu(): void {
    if (this.modelSubmenuEl) {
      this.modelSubmenuEl.remove();
      this.modelSubmenuEl = null;
    }
  }

  private toggleHistoryPopover(triggerEl: HTMLElement): void {
    if (this.historyPopoverEl) {
      this.hideHistoryPopover();
      return;
    }
    this.historyTriggerEl = triggerEl;
    void this.showHistoryPopover();
  }

  private async showHistoryPopover(): Promise<void> {
    const triggerEl = this.historyTriggerEl;
    this.hideHistoryPopover();
    if (!triggerEl) return;
    const popover = createDiv({ cls: 'wesight-history-popover' });
    popover.createDiv({ cls: 'wesight-history-header', text: '历史对话' });
    const list = popover.createDiv({ cls: 'wesight-history-list' });
    const conversations = await this.deps.vaultStore.listConversations();
    if (conversations.length === 0) {
      list.createDiv({ cls: 'wesight-history-empty', text: '暂无历史对话' });
    } else {
      for (const conversation of conversations) {
        this.renderHistoryItem(list, conversation);
      }
    }
    document.body.appendChild(popover);
    void popover.offsetHeight;

    const triggerRect = triggerEl.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let top = triggerRect.bottom + 4;
    let left = triggerRect.left;
    if (left + popoverRect.width > viewportWidth - 8) {
      left = Math.max(8, viewportWidth - popoverRect.width - 8);
    }
    if (top + popoverRect.height > viewportHeight - 8) {
      top = Math.max(8, triggerRect.top - popoverRect.height - 4);
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.setCssProps({ zIndex: 'var(--layer-modal, 10000)' });
    popover.addClass('is-open');
    this.historyPopoverEl = popover;
  }

  private hideHistoryPopover(): void {
    this.historyTriggerEl = null;
    if (this.historyPopoverEl) {
      this.historyPopoverEl.remove();
      this.historyPopoverEl = null;
    }
  }

  private renderHistoryItem(parent: HTMLElement, conversation: StoredConversation): void {
    const isCurrent = this.conversation?.id === conversation.id;
    const item = parent.createDiv({ cls: `wesight-history-item${isCurrent ? ' is-current' : ''}` });
    const icon = item.createSpan({ cls: 'wesight-history-item-icon' });
    setIcon(icon, isCurrent ? 'check' : (HISTORY_AGENT_ICONS[conversation.agentId] ?? 'message-circle'));
    const body = item.createDiv({ cls: 'wesight-history-item-body' });
    body.createDiv({ cls: 'wesight-history-item-title', text: conversation.title || '未命名对话' });
    body.createDiv({
      cls: 'wesight-history-item-meta',
      text: `${conversation.mode === 'knowledge' ? '知识库 · ' : ''}${getAgentDescriptor(conversation.agentId).displayName} · ${formatRelativeTime(conversation.updatedAt)}`,
    });
    item.onclick = () => {
      void this.openHistoryConversation(conversation);
    };
    const deleteButton = item.createEl('button', { cls: 'clickable-icon wesight-history-item-delete' });
    setIcon(deleteButton, 'trash-2');
    deleteButton.ariaLabel = '删除对话';
    deleteButton.onclick = event => {
      event.stopPropagation();
      void this.deleteHistoryConversation(conversation.id);
    };
  }

  private async openHistoryConversation(conversation: StoredConversation): Promise<void> {
    this.hideHistoryPopover();
    this.conversation = conversation;
    this.conversationMode = conversation.mode ?? 'chat';
    if (this.agentId !== conversation.agentId) {
      this.agentId = conversation.agentId;
    }
    this.render();
    this.renderMessages();
    this.refreshStatus();
  }

  private async deleteHistoryConversation(id: string): Promise<void> {
    await this.deps.vaultStore.deleteConversation(id);
    if (this.conversation?.id === id) {
      this.ensureConversation(true);
      this.renderMessages();
    }
    this.hideHistoryPopover();
    if (this.historyButtonEl) {
      this.historyTriggerEl = this.historyButtonEl;
      void this.showHistoryPopover();
    }
  }

  private scheduleHideSubmenu(): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
    }
    this.submenuHideTimeout = window.setTimeout(() => {
      this.hideConfigSubmenu();
    }, 200);
  }

  private hideConfigSubmenu(): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
      this.submenuHideTimeout = null;
    }
    this.hideModelSubmenu();
    if (this.configSubmenuEl) {
      this.configSubmenuEl.remove();
      this.configSubmenuEl = null;
    }
  }

  private async selectConfigSource(agentId: AgentId, source: RuntimeConfigSource): Promise<void> {
    if (agentId === 'codex' && source === 'providerProfile') return;
    const settings = this.deps.getSettings();
    settings.configSources[agentId] = source;
    settings.defaultAgentId = agentId;
    if (agentId === 'claude' && source === 'localCli') {
      settings.localModelByAgent.claude = '';
    }
    if (source === 'providerProfile' && !settings.providerProfileByAgent[agentId]) {
      const profile = this.deps.providerStore.find(agentId);
      if (profile) {
        settings.providerProfileByAgent[agentId] = profile.id;
      }
    }
    this.agentId = agentId;
    this.hideConfigSubmenu();
    // saveSettings() triggers refreshViews() -> onOpen(), which re-renders this view.
    await this.deps.saveSettings();
    if (source === 'providerProfile' && !this.deps.providerStore.find(agentId, settings.providerProfileByAgent[agentId])) {
      new Notice('已切换到 WeSight 配置，请先在模型设置里添加 Claude Code 的模型配置。');
    }
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId);
    if (!status.found) {
      this.openRuntimeSetup();
    }
  }

  private renderModelSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({ cls: 'wesight-model-selector wesight-profile-selector' });
    const button = selector.createDiv({ cls: 'wesight-model-btn' });
    button.createSpan({ cls: 'wesight-model-label', text: this.getModelSelectorLabel() });
    const chevron = button.createSpan({ cls: 'wesight-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const settings = this.deps.getSettings();
    const dropdown = selector.createDiv({ cls: 'wesight-model-dropdown' });
    const isLocal = settings.configSources[this.agentId] === 'localCli';
    if (this.agentId === 'claude') {
      this.renderClaudeModelDropdown(dropdown, settings, isLocal);
      return;
    }
    if (this.agentId === 'codex') {
      this.renderCodexModelDropdown(dropdown);
      return;
    }

    const selectedLocalModel = settings.localModelByAgent[this.agentId] ?? '';
    const localModels = listLocalModels(this.agentId);
    if (selectedLocalModel && !localModels.some(model => model.id === selectedLocalModel)) {
      localModels.push({ id: selectedLocalModel, label: selectedLocalModel, note: 'selected' });
    }
    if (localModels.length > 0) {
      dropdown.createDiv({ cls: 'wesight-model-group', text: 'Local CLI models' });
      for (const model of localModels) {
        const option = dropdown.createDiv({ cls: 'wesight-model-option' });
        option.toggleClass('selected', isLocal && (settings.localModelByAgent[this.agentId] ?? '') === model.id);
        const icon = option.createSpan({ cls: 'wesight-option-icon' });
        setIcon(icon, 'terminal');
        option.createSpan({ text: model.label });
        if (model.note) {
          option.createSpan({ cls: 'wesight-option-note', text: model.note });
        }
        option.onclick = event => {
          event.stopPropagation();
          void this.selectLocalCli(model.id);
        };
      }
    } else {
      dropdown.createDiv({ cls: 'wesight-model-group', text: 'Runtime' });
      const localOption = dropdown.createDiv({ cls: 'wesight-model-option' });
      localOption.toggleClass('selected', isLocal);
      const terminalIcon = localOption.createSpan({ cls: 'wesight-option-icon' });
      setIcon(terminalIcon, 'terminal');
      localOption.createSpan({ text: 'Local CLI' });
      localOption.onclick = event => {
        event.stopPropagation();
        void this.selectLocalCli();
      };
    }

    const profiles = this.deps.providerStore.list(this.agentId);
    if (profiles.length === 0) {
      dropdown.createDiv({ cls: 'wesight-model-group', text: 'Provider Profiles' });
      const empty = dropdown.createDiv({ cls: 'wesight-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'wesight-option-icon' });
      setIcon(emptyIcon, 'key-round');
      empty.createSpan({ text: 'Add a profile to set model' });
    }
    for (const profile of profiles) {
      dropdown.createDiv({ cls: 'wesight-model-group', text: profile.name });
      const profileSelected = !isLocal && settings.providerProfileByAgent[this.agentId] === profile.id;
      const models = profile.models.length > 0 ? profile.models : [profile.model].filter(Boolean);
      if (models.length === 0) {
        const option = dropdown.createDiv({ cls: 'wesight-model-option' });
        option.toggleClass('selected', profileSelected);
        const keyIcon = option.createSpan({ cls: 'wesight-option-icon' });
        setIcon(keyIcon, 'key-round');
        option.createSpan({ text: profile.name });
        option.createSpan({ cls: 'wesight-option-note', text: 'model unset' });
        option.onclick = event => {
          event.stopPropagation();
          void this.selectProfile(profile.id);
        };
        continue;
      }
      for (const model of models) {
        const option = dropdown.createDiv({ cls: 'wesight-model-option' });
        option.toggleClass('selected', profileSelected && (profile.defaultModel || profile.model) === model);
        const keyIcon = option.createSpan({ cls: 'wesight-option-icon' });
        setIcon(keyIcon, 'key-round');
        option.createSpan({ text: model });
        option.onclick = event => {
          event.stopPropagation();
          void this.selectProfile(profile.id, model);
        };
      }
    }

    dropdown.createDiv({ cls: 'wesight-model-group', text: 'Setup' });
    const configure = dropdown.createDiv({ cls: 'wesight-model-option' });
    const settingsIcon = configure.createSpan({ cls: 'wesight-option-icon' });
    setIcon(settingsIcon, 'settings');
    configure.createSpan({ text: 'Configure models' });
    configure.onclick = event => {
      event.stopPropagation();
      this.deps.openSettings();
    };
  }

  private renderCodexModelDropdown(dropdown: HTMLElement): void {
    const status = this.deps.runtimeManager.getCodexStatus();
    dropdown.createDiv({ cls: 'wesight-model-group', text: '本机 Codex App' });
    const option = dropdown.createDiv({ cls: 'wesight-model-option disabled wesight-local-readonly-option selected' });
    const icon = option.createSpan({ cls: 'wesight-option-icon' });
    setIcon(icon, status.state === 'error' ? 'circle-alert' : 'hard-drive');
    const label = status.currentModel?.displayName
      ?? status.currentModelId
      ?? (status.state === 'connecting' ? '正在读取模型…' : '跟随 Codex App');
    option.createSpan({ text: label });
    option.createSpan({
      cls: 'wesight-option-note',
      text: status.state === 'error'
        ? '连接失败'
        : status.imageGeneration === false
          ? '聊天可用 · 图片生成不可用'
          : '只读',
    });
  }

  private renderClaudeModelDropdown(
    dropdown: HTMLElement,
    settings: WeSightObsidianSettings,
    isLocal: boolean,
  ): void {
    if (isLocal) {
      dropdown.createDiv({ cls: 'wesight-model-group', text: '本机配置' });
      const detected = getClaudeDetectedLocalModel();
      const option = dropdown.createDiv({ cls: 'wesight-model-option disabled wesight-local-readonly-option' });
      const icon = option.createSpan({ cls: 'wesight-option-icon' });
      setIcon(icon, 'hard-drive');
      option.createSpan({ text: detected ? detected.label : '跟随 Claude Code' });
      option.createSpan({ cls: 'wesight-option-note', text: detected?.note ?? '本机配置' });
      return;
    }

    const profiles = this.deps.providerStore.list('claude');
    dropdown.createDiv({ cls: 'wesight-model-group', text: '供应商' });
    if (profiles.length === 0) {
      const empty = dropdown.createDiv({ cls: 'wesight-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'wesight-option-icon' });
      setIcon(emptyIcon, 'key-round');
      empty.createSpan({ text: '请先添加 Claude 模型配置' });
    }

    const selectedProfileId = settings.providerProfileByAgent.claude;
    for (const profile of profiles) {
      const items = this.getProfileModelItems(profile, selectedProfileId);
      this.renderSupplierOption(dropdown, {
        label: profile.name,
        note: `${items.length} 个模型`,
        icon: 'key-round',
        selected: selectedProfileId === profile.id,
        onOpen: triggerEl => this.showModelSubmenu({
          triggerEl,
          title: profile.name,
          items,
        }),
      });
    }

    dropdown.createDiv({ cls: 'wesight-model-group', text: '设置' });
    const configure = dropdown.createDiv({ cls: 'wesight-model-option' });
    const settingsIcon = configure.createSpan({ cls: 'wesight-option-icon' });
    setIcon(settingsIcon, 'settings');
    configure.createSpan({ text: '管理模型配置' });
    configure.onclick = event => {
      event.stopPropagation();
      this.deps.openSettings();
    };
  }

  private renderSupplierOption(parent: HTMLElement, options: {
    label: string;
    note: string;
    icon: string;
    selected: boolean;
    onOpen: (triggerEl: HTMLElement) => void;
  }): void {
    const option = parent.createDiv({ cls: 'wesight-model-option has-submenu wesight-supplier-option' });
    option.toggleClass('selected', options.selected);
    option.tabIndex = 0;
    const icon = option.createSpan({ cls: 'wesight-option-icon' });
    setIcon(icon, options.icon);
    option.createSpan({ text: options.label });
    option.createSpan({ cls: 'wesight-option-note', text: options.note });
    if (options.selected) {
      const checkIcon = option.createSpan({ cls: 'wesight-option-check' });
      setIcon(checkIcon, 'check');
    }
    const arrow = option.createSpan({ cls: 'wesight-submenu-arrow' });
    setIcon(arrow, 'chevron-right');
    option.addEventListener('mouseenter', () => options.onOpen(option));
    option.addEventListener('mouseleave', () => this.scheduleHideSubmenu());
    option.onfocus = () => options.onOpen(option);
    option.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
        event.preventDefault();
        options.onOpen(option);
      }
      if (event.key === 'Escape') {
        this.hideModelSubmenu();
      }
    };
    option.onclick = event => {
      event.stopPropagation();
      options.onOpen(option);
    };
  }

  private getProfileModelItems(profile: ProviderProfile, selectedProfileId: string): Array<{
    id: string;
    label: string;
    note?: string;
    icon: string;
    selected: boolean;
    onSelect: () => void | Promise<void>;
  }> {
    const models = profile.models.length > 0 ? profile.models : [profile.model].filter(Boolean);
    if (models.length === 0) {
      return [{
        id: profile.id,
        label: profile.name,
        note: '未设置模型',
        icon: 'key-round',
        selected: selectedProfileId === profile.id,
        onSelect: () => this.selectProfile(profile.id),
      }];
    }
    const activeModel = profile.defaultModel || profile.model;
    return models.map(model => ({
      id: `${profile.id}:${model}`,
      label: model,
      note: profile.name,
      icon: 'key-round',
      selected: selectedProfileId === profile.id && activeModel === model,
      onSelect: () => this.selectProfile(profile.id, model),
    }));
  }

  private refreshStatus(): void {
    this.updateRunControls();
  }

  // Conversations start as in-memory drafts; they are only persisted once the
  // first message is sent, so open/close cycles never litter the store.
  private ensureConversation(forceNew = false): void {
    if (this.conversation && !forceNew) return;
    this.conversation = this.deps.vaultStore.createDraftConversation(this.agentId, this.conversationMode);
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    const messages = this.conversation?.messages ?? [];
    if (messages.length === 0) {
      this.renderEmptyState();
      return;
    }
    for (const message of messages) {
      this.renderMessage(message);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderMessage(message: ChatMessage): void {
    const item = this.messagesEl.createDiv({ cls: `wesight-message is-${message.role}` });
    const role = message.role === 'user'
      ? 'You'
      : message.role === 'assistant'
        ? getAgentDescriptor(message.agentId ?? this.agentId).displayName
        : message.role;
    item.createDiv({ cls: 'wesight-message-role', text: role });
    if (message.metadata?.knowledgeBased) item.createDiv({ cls: 'wesight-kb-answer-badge', text: '基于知识库' });
    if (message.role === 'assistant' || message.role === 'error') {
      if (message.role === 'assistant' && message.metadata?.process?.length) {
        const collapsed = message.metadata.processCollapsed !== false;
        this.renderProcessContainer(item, message, !collapsed);
      }
      void this.renderMessageMarkdown(item, message);
    } else {
      item.createEl('pre', { cls: 'wesight-message-content', text: message.content });
    }
    for (const artifact of message.metadata?.artifacts ?? []) {
      if (artifact.type === 'image') this.renderImageArtifact(item, artifact);
    }
    if (message.role === 'assistant' && typeof message.metadata?.durationMs === 'number') {
      this.renderTurnDuration(item, message.metadata.durationMs);
    }
    if (message.role === 'assistant') {
      this.renderKnowledgeCitations(item, message);
      this.renderKnowledgeBrainSaveButton(item, message);
    }
  }


  private renderProcessContainer(parent: HTMLElement, message: ChatMessage, expanded: boolean): {
    container: HTMLElement;
    body: HTMLElement;
    toggle: HTMLElement;
  } {
    parent.querySelector('.wesight-message-process')?.remove();
    const container = parent.createDiv({ cls: 'wesight-message-process' });
    if (!expanded) container.addClass('is-collapsed');
    const toggle = container.createEl('button', {
      cls: 'wesight-process-toggle',
      attr: { type: 'button' },
    });
    const body = container.createDiv({ cls: 'wesight-process-body' });
    const processItems = message.metadata?.process ?? [];
    this.updateProcessToggleLabel(toggle, processItems, expanded);
    for (const item of processItems) {
      this.renderProcessItem(body, item);
    }
    toggle.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      const collapsed = container.hasClass('is-collapsed');
      container.toggleClass('is-collapsed', !collapsed);
      message.metadata = { ...(message.metadata ?? {}), processCollapsed: !collapsed };
      this.updateProcessToggleLabel(toggle, message.metadata?.process ?? [], collapsed);
    };
    return { container, body, toggle };
  }

  private updateProcessToggleLabel(toggle: HTMLElement, processItems: ChatMessageProcessItem[], expanded: boolean): void {
    const thinkingCount = processItems.filter(item => item.type === 'thinking').length;
    const toolCount = processItems.filter(item => item.type === 'tool').length;
    const total = processItems.length;
    if (expanded) {
      toggle.setText('收起过程');
    } else {
      const parts: string[] = [];
      if (thinkingCount) parts.push(`${thinkingCount} 个思考`);
      if (toolCount) parts.push(`${toolCount} 个工具步骤`);
      toggle.setText(parts.length ? `展开过程（${parts.join('，')}）` : `展开过程（${total}）`);
    }
  }

  private ensureProcessItem(body: HTMLElement, id: string, type: 'thinking' | 'tool'): HTMLElement {
    let el: HTMLElement | null = body.querySelector(`.wesight-process-item[data-process-id="${id}"]`);
    if (!el) {
      el = body.createDiv({ cls: `wesight-process-item is-${type}` });
      el.dataset.processId = id;
    }
    return el;
  }

  private renderProcessItem(body: HTMLElement, item: ChatMessageProcessItem): HTMLElement {
    const el = this.ensureProcessItem(body, item.id, item.type);
    el.empty();
    el.addClass(`is-${item.type}`);
    if (item.type === 'thinking') {
      el.createDiv({ cls: 'wesight-process-item-title', text: item.title });
      const contentEl = el.createDiv({ cls: 'wesight-process-item-content' });
      contentEl.setText(item.content ?? '');
    } else {
      const header = el.createDiv({ cls: 'wesight-process-item-header' });
      header.createDiv({ cls: 'wesight-process-item-title', text: item.title });
      const statusEl = header.createDiv({ cls: 'wesight-process-item-status' });
      statusEl.setText(this.formatToolStatus(item.status));
      if (item.status === 'error' && item.error) {
        el.createDiv({ cls: 'wesight-process-item-error', text: item.error });
      }
    }
    return el;
  }

  private formatToolStatus(status?: 'started' | 'completed' | 'error'): string {
    if (status === 'started') return '执行中';
    if (status === 'error') return '失败';
    if (status === 'completed') return '已完成';
    return status ?? '运行中';
  }

  private renderKnowledgeBrainSaveButton(parent: HTMLElement, message: ChatMessage): void {
    if (!message.content.trim() || message.metadata?.cancelled) return;
    const saved = message.metadata?.knowledgeSave;
    if (saved) {
      const group = parent.createDiv({ cls: 'wesight-kb-saved-state' });
      group.createSpan({ text: '已保存到知识大脑' });
      for (const savedPath of saved.changedPaths.filter(item => item.startsWith('wiki/') && item.endsWith('.md')).slice(0, 3)) {
        const link = group.createEl('button', { text: savedPath, attr: { type: 'button' } });
        link.onclick = () => void this.app.workspace.openLinkText(savedPath, '', false);
      }
      return;
    }
    if (message.agentId !== 'claude' && message.agentId !== 'codex') return;
    const agentId = message.agentId;
    const access = this.deps.knowledgeBrainEntitlement.getCurrentStatus();
    const button = parent.createEl('button', {
      cls: 'wesight-kb-save-button',
      text: access.allowed ? '保存到知识大脑' : '保存到知识大脑 · 会员',
    });
    button.toggleClass('is-locked', !access.allowed);
    button.onclick = async () => {
      button.disabled = true;
      await this.openKnowledgeSavePreview(message, agentId);
      button.disabled = false;
    };
  }

  private renderKnowledgeCitations(parent: HTMLElement, message: ChatMessage): void {
    const citations = message.metadata?.knowledgeCitations ?? [];
    if (!citations.length) return;
    const group = parent.createDiv({ cls: 'wesight-kb-citations' });
    group.createDiv({ cls: 'wesight-kb-citations-title', text: '引用来源' });
    for (const citation of citations) {
      const button = group.createEl('button', { attr: { type: 'button' } });
      const icon = button.createSpan({ cls: 'wesight-kb-citation-icon' });
      setIcon(icon, citation.kind === 'source' ? 'file-archive' : 'book-open');
      const filename = citation.path.split('/').pop()?.replace(/\.md$/i, '') ?? citation.path;
      const label = citation.kind === 'source'
        ? filename.replace(/^[a-f0-9]{16}-/i, '')
        : filename;
      button.createSpan({ text: `${citation.kind === 'source' ? '原始资料' : '知识页'} · ${label}` });
      button.onclick = () => {
        const file = this.app.vault.getAbstractFileByPath(citation.path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        else if (citation.path.startsWith('.raw/captured/')) {
          new Notice(`原始笔记已移动或删除，归档快照保存在 ${citation.path}`);
        } else void this.app.workspace.openLinkText(citation.path, '', false);
      };
    }
  }

  private async openKnowledgeSavePreview(message: ChatMessage, knownAgentId?: 'claude' | 'codex'): Promise<void> {
    if (!(await this.requireKnowledgeAccess())) return;
    if (message.agentId !== 'claude' && message.agentId !== 'codex') {
      new Notice('知识大脑首版仅支持 Claude Code 与 Codex 回答。');
      return;
    }
    const agentId = knownAgentId ?? message.agentId;
    const sourceConversation = this.conversation;
    if (!sourceConversation) {
      new Notice('当前回答不再属于可用对话。');
      return;
    }
    const messages = sourceConversation.messages;
    const index = messages.findIndex(item => item.id === message.id);
    const question = messages.slice(0, index).reverse().find(item => item.role === 'user');
    if (!question) {
      new Notice('找不到对应的问题。');
      return;
    }
    try {
      const preview = await this.deps.knowledgeBrain.planSaveAnswer({
        conversationId: sourceConversation.id,
        messageId: message.id,
        question: question.content,
        answer: message.content,
        agentId,
      });
      new KnowledgePreviewModal(this.app, preview, async () => {
        const result = await this.deps.knowledgeBrain.applyPreview(preview.previewId);
        if (result.ok) {
          message.metadata = {
            ...(message.metadata ?? {}),
            knowledgeSave: { status: 'saved', changedPaths: result.changedPaths, savedAt: Date.now() },
          };
          await this.deps.vaultStore.replaceConversation(sourceConversation);
          if (this.conversation?.id === sourceConversation.id) this.renderMessages();
        }
        return result;
      }, async () => this.deps.knowledgeBrain.discardPreview(preview.previewId)).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : '保存失败。');
    }
  }

  private renderTurnDuration(parent: HTMLElement, durationMs: number): void {
    const seconds = Math.max(0, durationMs) / 1000;
    parent.createDiv({ cls: 'wesight-turn-duration', text: `总耗时 ${seconds.toFixed(1)}s` });
  }


  private async renderMessageMarkdown(parent: HTMLElement, message: ChatMessage): Promise<void> {
    parent.querySelector('.wesight-message-content')?.remove();
    if (!message.content.trim()) return;
    const container = parent.createDiv({ cls: 'wesight-message-content markdown-rendered' });
    await MarkdownRenderer.render(this.app, message.content, container, '', this);
  }

  private renderImageArtifact(parent: HTMLElement, artifact: ChatImageArtifact): void {
    const resourcePath = this.deps.vaultStore.getResourcePath(artifact.vaultPath);
    const link = parent.createEl('a', {
      cls: 'wesight-image-artifact',
      attr: { href: resourcePath, target: '_blank', rel: 'noopener' },
    });
    link.createEl('img', {
      attr: {
        src: resourcePath,
        alt: artifact.revisedPrompt ?? 'Codex generated image',
      },
    });
    if (artifact.revisedPrompt) {
      link.createDiv({ cls: 'wesight-image-artifact-caption', text: artifact.revisedPrompt });
    }
  }

  private renderEmptyState(): void {
    const empty = this.messagesEl.createDiv({ cls: 'wesight-welcome' });
    empty.createDiv({ cls: 'wesight-welcome-greeting', text: this.conversationMode === 'knowledge' ? '向你的知识库提问' : 'How can I help?' });
  }

  private async sendMessage(): Promise<void> {
    if (this.running) return;
    this.cancelledByUser = false;
    const rawPrompt = this.inputEl.value.trim();
    if (!rawPrompt && !this.selectedSkill) return;
    if (this.conversationMode === 'knowledge' && !(await this.requireKnowledgeAccess())) return;
    const skillPrompt = this.selectedSkill?.insertText ?? '';
    this.ensureConversation();
    const conversation = this.conversation;
    if (!conversation) return;
    conversation.mode = this.conversationMode;
    const vaultBasePath = getVaultBasePath(this.app);
    if (!vaultBasePath) {
      new Notice('WeSight needs a local desktop vault path.');
      return;
    }
    const settings = this.deps.getSettings();
    const knowledgeMode = this.conversationMode === 'knowledge';
    if (knowledgeMode && this.agentId !== 'claude' && this.agentId !== 'codex') {
      new Notice('知识大脑首版仅支持 Claude Code 与 Codex。');
      return;
    }
    const resolved = knowledgeMode
      ? { prompt: rawPrompt, attachments: [] as FileAttachment[] }
      : await resolveMentions(this.app, rawPrompt, settings.maxContextFileChars);
    const activeContext = knowledgeMode
      ? { prompt: '', attachments: [] as FileAttachment[] }
      : await this.resolveActiveEditorContext(settings.maxContextFileChars);
    const userPrompt = activeContext.prompt
      ? `${resolved.prompt}\n\n${activeContext.prompt}`
      : resolved.prompt;
    const runtimePrompt = skillPrompt
      ? `${skillPrompt}\n\n${userPrompt}`
      : userPrompt;
    const attachments = mergeAttachments([...resolved.attachments, ...activeContext.attachments]);
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: rawPrompt,
      createdAt: Date.now(),
      agentId: this.agentId,
    };
    if (conversation.messages.length === 0) {
      this.messagesEl.empty();
    }
    conversation.messages.push(userMessage);
    if (!conversation.title || conversation.title === 'New WeSight session') {
      conversation.title = rawPrompt.replace(/\s+/g, ' ').trim().slice(0, 60) || conversation.title;
    }
    this.renderMessage(userMessage);
    this.inputEl.value = '';
    this.clearSuggestions();
    this.removeSkill();

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      agentId: this.agentId,
      metadata: { process: [], knowledgeBased: knowledgeMode },
    };
    conversation.messages.push(assistantMessage);
    const assistantEl = this.messagesEl.createDiv({ cls: 'wesight-message is-assistant is-streaming' });
    assistantEl.createDiv({ cls: 'wesight-message-role', text: getAgentDescriptor(this.agentId).displayName });
    const process = this.renderProcessContainer(assistantEl, assistantMessage, true);
    process.container.hide();
    const contentEl = assistantEl.createEl('pre', { cls: 'wesight-message-content', text: 'Thinking...' });

    // Deltas are appended as text nodes instead of re-setting the whole message,
    // which keeps long streams O(n) instead of O(n²).
    let streamStarted = false;
    const artifactTasks: Promise<void>[] = [];
    const appendDelta = (delta: string): void => {
      if (!streamStarted) {
        contentEl.setText('');
        streamStarted = true;
      }
      contentEl.appendText(delta);
    };
    const processItems = assistantMessage.metadata!.process!;
    const processBody = process.body;
    const processToggle = process.toggle;
    let processVisible = false;
    const ensureProcessVisible = (): void => {
      if (!processVisible) {
        processVisible = true;
        process.container.show();
      }
    };
    const refreshProcessToggle = (): void => {
      this.updateProcessToggleLabel(processToggle, processItems, processVisible);
    };
    const appendReasoning = (content: string): void => {
      ensureProcessVisible();
      let item = processItems.find(p => p.type === 'thinking');
      if (!item) {
        item = { id: 'thinking', type: 'thinking', title: '思考', content: '', createdAt: Date.now() };
        processItems.push(item);
      }
      item.content += content;
      this.renderProcessItem(processBody, item);
      refreshProcessToggle();
    };
    const updateTool = (toolCall: ToolCallEvent): void => {
      ensureProcessVisible();
      let item = processItems.find(p => p.type === 'tool' && p.id === toolCall.id);
      if (!item) {
        item = { id: toolCall.id, type: 'tool', title: toolCall.name, status: toolCall.status, createdAt: Date.now() };
        processItems.push(item);
      } else {
        item.status = toolCall.status;
      }
      item.input = toolCall.input;
      item.output = toolCall.output;
      item.error = toolCall.error;
      this.renderProcessItem(processBody, item);
      refreshProcessToggle();
    };
    const agentId = this.agentId;
    const storeSession = (sessionId: string): void => {
      conversation.modeSessionIds = {
        ...(conversation.modeSessionIds ?? {}),
        [this.conversationMode]: {
          ...(conversation.modeSessionIds?.[this.conversationMode] ?? {}),
          [agentId]: sessionId,
        },
      };
      if (this.conversationMode === 'chat') {
        conversation.sessionIds = { ...(conversation.sessionIds ?? {}), [agentId]: sessionId };
      }
    };
    const onEvent = (event: RuntimeTurnEvent): void => {
      // A user-requested cancel must not surface runtime teardown output
      // (for example a JSON shutdown line) mid-stream; the turn ends with
      // the cancellation notice instead.
      if (this.cancelledByUser) return;
      if (event.type === 'session') {
        storeSession(event.sessionId);
      } else if (event.type === 'text') {
        assistantMessage.content += event.content;
        appendDelta(event.content);
        assistantEl.removeClass('is-streaming');
        this.scheduleScrollToBottom();
      } else if (event.type === 'reasoning') {
        appendReasoning(event.content);
        this.scheduleScrollToBottom();
      } else if (event.type === 'tool') {
        updateTool(event.toolCall);
        this.scheduleScrollToBottom();
      } else if (event.type === 'artifact') {
        const task = this.deps.vaultStore.importGeneratedImage(conversation.id, event.artifact).then(artifact => {
          assistantMessage.metadata = {
            ...(assistantMessage.metadata ?? {}),
            artifacts: [...(assistantMessage.metadata?.artifacts ?? []), artifact],
          };
          this.renderImageArtifact(assistantEl, artifact);
          assistantEl.removeClass('is-streaming');
          this.scheduleScrollToBottom();
        }).catch(error => {
          const detail = error instanceof Error ? error.message : String(error);
          const line = `\n图片保存失败：${detail}`;
          assistantMessage.role = 'error';
          assistantMessage.content += line;
          appendDelta(line);
          assistantEl.addClass('is-error');
        });
        artifactTasks.push(task);
      } else if (event.type === 'error') {
        assistantMessage.role = 'error';
        assistantMessage.content += `\n${event.message}${event.detail ? `\n${event.detail}` : ''}`;
        assistantEl.addClass('is-error');
        assistantEl.removeClass('is-streaming');
        contentEl.setText(assistantMessage.content.trim());
        streamStarted = true;
      }
    };
    const onKnowledgeEvent = (event: KnowledgeRuntimeEvent): void => {
      if (this.cancelledByUser) return;
      if (event.type === 'session') storeSession(event.sessionId);
      else if (event.type === 'status') contentEl.setText(event.message ?? '正在查询知识库…');
      else if (event.type === 'text') {
        assistantMessage.content += event.content;
        contentEl.setText(assistantMessage.content);
        streamStarted = true;
        assistantEl.removeClass('is-streaming');
      } else if (event.type === 'citation') {
        const citations = assistantMessage.metadata?.knowledgeCitations ?? [];
        if (!citations.some(item => item.path === event.path)) {
          assistantMessage.metadata = {
            ...(assistantMessage.metadata ?? {}),
            knowledgeCitations: [...citations, { path: event.path, kind: event.kind, line: event.line }],
          };
        }
      } else if (event.type === 'error') {
        assistantMessage.role = 'error';
        assistantMessage.content = event.message;
        assistantEl.addClass('is-error');
        contentEl.setText(event.message);
        streamStarted = true;
      }
    };

    const turnStartedAt = Date.now();
    this.running = true;
    this.updateRunControls();
    try {
      if (knowledgeMode && (this.agentId === 'claude' || this.agentId === 'codex')) {
        await this.deps.knowledgeBrain.query({
          conversationId: conversation.id,
          question: rawPrompt,
          agentId: this.agentId,
          sessionId: conversation.modeSessionIds?.knowledge?.[this.agentId],
        }, onKnowledgeEvent);
      } else {
        const modelOverride = this.agentId === 'claude' && settings.configSources.claude === 'localCli'
          ? ''
          : settings.localModelByAgent[this.agentId];
        await this.deps.runtimeManager.runTurn({
          conversationId: conversation.id,
          agentId: this.agentId,
          prompt: runtimePrompt,
          cwd: vaultBasePath,
          configSource: settings.configSources[this.agentId],
          providerProfileId: settings.providerProfileByAgent[this.agentId],
          model: modelOverride,
          sessionId: conversation.modeSessionIds?.chat?.[this.agentId] ?? conversation.sessionIds?.[this.agentId],
          systemPrompt: settings.systemPrompt,
          planMode: this.planMode,
          attachments,
          accessMode: 'workspace-write',
        }, onEvent);
      }
      await Promise.allSettled(artifactTasks);
      if (!assistantMessage.content.trim() && !(assistantMessage.metadata?.artifacts?.length)) {
        assistantMessage.content = 'Done.';
        contentEl.setText(assistantMessage.content);
      }
      assistantEl.removeClass('is-streaming');
    } finally {
      const durationMs = Date.now() - turnStartedAt;
      assistantMessage.metadata = {
        ...(assistantMessage.metadata ?? {}),
        durationMs,
      };
      this.running = false;
      this.updateRunControls();
      this.refreshStatus();
      if (this.cancelledByUser) {
        this.cancelledByUser = false;
        assistantMessage.role = 'assistant';
        assistantMessage.content = '当前任务已取消';
        assistantMessage.metadata = { ...(assistantMessage.metadata ?? {}), cancelled: true };
        assistantEl.removeClass('is-error');
      }
      if (processVisible) {
        process.container.addClass('is-collapsed');
        assistantMessage.metadata = { ...(assistantMessage.metadata ?? {}), processCollapsed: true };
        this.updateProcessToggleLabel(processToggle, processItems, false);
      }
      conversation.updatedAt = Date.now();
      await this.deps.vaultStore.replaceConversation(conversation);
      if (assistantEl.isConnected) {
        await this.renderMessageMarkdown(assistantEl, assistantMessage);
        if (assistantMessage.role === 'assistant') {
          this.renderTurnDuration(assistantEl, durationMs);
          this.renderKnowledgeCitations(assistantEl, assistantMessage);
          this.renderKnowledgeBrainSaveButton(assistantEl, assistantMessage);
        }
      }
    }
  }

  private scheduleScrollToBottom(): void {
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    window.requestAnimationFrame(() => {
      this.scrollScheduled = false;
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    });
  }

  private async startNewConversation(): Promise<void> {
    this.ensureConversation(true);
    this.renderMessages();
    this.inputEl.focus();
  }

  private async switchConversationMode(mode: ConversationMode): Promise<void> {
    if (this.running || mode === this.conversationMode) return;
    if (mode === 'knowledge' && !(await this.requireKnowledgeAccess())) return;
    this.conversationMode = mode;
    if (mode === 'knowledge' && this.agentId !== 'claude' && this.agentId !== 'codex') this.agentId = 'claude';
    if (this.conversation?.messages.length) {
      this.conversation = this.deps.vaultStore.createDraftConversation(this.agentId, mode);
    } else if (this.conversation) {
      this.conversation.mode = mode;
      this.conversation.agentId = this.agentId;
    }
    this.render();
    this.renderMessages();
    this.refreshStatus();
    this.inputEl.focus();
  }

  private async switchAgent(agentId: AgentId, promptInstallIfMissing = false): Promise<void> {
    if (this.conversationMode === 'knowledge' && agentId === 'opencode') {
      new Notice('知识大脑首版仅支持 Claude Code 与 Codex。');
      return;
    }
    this.agentId = agentId;
    this.render();
    this.renderMessages();
    this.refreshStatus();
    if (agentId === 'codex') void this.deps.runtimeManager.refreshCodexStatus();
    if (promptInstallIfMissing) {
      this.openRuntimeSetup();
    }
  }

  private async selectLocalCli(modelId = ''): Promise<void> {
    this.deps.getSettings().configSources[this.agentId] = 'localCli';
    this.deps.getSettings().localModelByAgent[this.agentId] = this.agentId === 'claude' || this.agentId === 'codex' ? '' : modelId;
    this.closeAllDropdowns();
    // saveSettings() triggers refreshViews() -> onOpen(), which re-renders this view.
    await this.deps.saveSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: this.deps.getSettings().configuredPaths,
      configSources: this.deps.getSettings().configSources,
    }).resolve(this.agentId);
    if (!status.found) {
      this.openRuntimeSetup();
    }
  }

  private async selectProfile(profileId: string, model?: string): Promise<void> {
    if (this.agentId === 'codex') return;
    this.deps.getSettings().configSources[this.agentId] = 'providerProfile';
    this.deps.getSettings().providerProfileByAgent[this.agentId] = profileId;
    if (model !== undefined) {
      this.deps.providerStore.setActiveModel(profileId, model);
    }
    this.closeAllDropdowns();
    // saveSettings() triggers refreshViews() -> onOpen(), which re-renders this view.
    await this.deps.saveSettings();
    if (!this.deps.providerStore.find(this.agentId, profileId)) {
      new Notice('已切换到 WeSight 配置，请先在模型设置里添加 Claude Code 的模型配置。');
    }
    const status = new RuntimeDiscovery({
      configuredPaths: this.deps.getSettings().configuredPaths,
      configSources: this.deps.getSettings().configSources,
    }).resolve(this.agentId);
    if (!status.found) {
      this.openRuntimeSetup();
    }
  }

  private getModelSelectorLabel(): string {
    const settings = this.deps.getSettings();
    if (settings.configSources[this.agentId] === 'localCli') {
      if (this.agentId === 'claude') {
        const detected = getClaudeDetectedLocalModel();
        return detected?.label ?? '跟随 Claude Code';
      }
      if (this.agentId === 'codex') {
        const status = this.deps.runtimeManager.getCodexStatus();
        return status.currentModel?.displayName
          ?? status.currentModelId
          ?? (status.state === 'connecting' ? '读取 Codex 模型…' : '跟随 Codex App');
      }
      const selectedModel = settings.localModelByAgent[this.agentId] ?? '';
      const localModels = listLocalModels(this.agentId);
      const label = selectedModel
        ? localModels.find(model => model.id === selectedModel)?.label ?? selectedModel
        : localModels.find(model => model.id)?.label ?? 'CLI 默认';
      return label;
    }
    const selectedProfileId = settings.providerProfileByAgent[this.agentId];
    const profiles = this.deps.providerStore.list(this.agentId);
    const selectedProfile = selectedProfileId
      ? profiles.find(profile => profile.id === selectedProfileId)
      : profiles.find(profile => profile.isDefault);
    if (selectedProfileId && !selectedProfile) {
      return 'Profile missing';
    }
    if (!selectedProfile) return 'Configure model';
    const model = selectedProfile.defaultModel || selectedProfile.model || '未设置模型';
    return model || selectedProfile.name;
  }

  private async updateSuggestions(): Promise<void> {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const slashQuery = findSlashQuery(this.inputEl.value, cursor);
    if (slashQuery !== null) {
      if (this.agentId !== 'claude' && this.agentId !== 'codex') {
        this.clearSuggestions();
        return;
      }
      const commands = filterSlashCommands(await loadChatSkills(this.agentId), slashQuery);
      this.showSuggestions(commands.map(command => ({
        label: command.label,
        description: command.description,
        apply: () => this.selectSkill(command, slashQuery),
      })));
      return;
    }
    const mentionQuery = findMentionQuery(this.inputEl.value, cursor);
    if (mentionQuery !== null) {
      const lower = mentionQuery.toLowerCase();
      const files = this.app.vault.getFiles()
        .filter(file => file.path.toLowerCase().includes(lower))
        .slice(0, 20);
      this.showSuggestions(files.map(file => ({
        label: file.path,
        description: file.extension,
        apply: () => this.replaceCurrentToken(`@${mentionQuery}`, `@"${file.path}"`),
      })));
      return;
    }
    this.clearSuggestions();
  }

  private showSuggestions(items: Array<{ label: string; description: string; apply: () => void }>): void {
    this.clearSuggestions();
    if (items.length === 0) return;
    this.suggestEl = this.inputEl.parentElement?.createDiv({ cls: 'wesight-suggest' }) ?? null;
    if (!this.suggestEl) return;
    for (const item of items) {
      const el = this.suggestEl.createDiv({ cls: 'wesight-suggest-item' });
      el.createDiv({ text: item.label });
      el.createEl('small', { text: item.description });
      el.onclick = () => {
        item.apply();
        this.clearSuggestions();
        this.inputEl.focus();
      };
    }
  }

  private clearSuggestions(): void {
    this.suggestEl?.remove();
    this.suggestEl = null;
  }

  private selectSkill(command: SlashCommand, slashQuery: string): void {
    this.selectedSkill = command;
    this.replaceCurrentToken(`${slashQuery}`, '');
    this.renderSkillPill();
    this.inputEl.focus();
  }

  private renderSkillPill(): void {
    this.skillPillEl?.remove();
    this.skillPillEl = null;
    if (!this.selectedSkill) return;
    const wrapper = this.inputEl.parentElement;
    if (!wrapper) return;
    const pill = wrapper.createDiv({ cls: 'wesight-skill-pill' });
    const icon = pill.createSpan({ cls: 'wesight-skill-pill-icon' });
    setIcon(icon, 'box');
    pill.createSpan({ cls: 'wesight-skill-pill-name', text: this.selectedSkill.label });
    const remove = pill.createEl('button', {
      cls: 'wesight-skill-pill-remove',
      attr: { type: 'button', 'aria-label': '移除 skill' },
    });
    setIcon(remove, 'x');
    remove.onclick = () => this.removeSkill();
    wrapper.insertBefore(pill, this.inputEl);
    this.skillPillEl = pill;
  }

  private removeSkill(): void {
    this.selectedSkill = null;
    this.skillPillEl?.remove();
    this.skillPillEl = null;
  }

  private replaceCurrentToken(token: string, replacement: string): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const rawStart = this.inputEl.value.lastIndexOf(token, cursor);
    if (rawStart < 0) return;
    const start = Math.max(0, rawStart);
    this.inputEl.value = `${this.inputEl.value.slice(0, start)}${replacement}${this.inputEl.value.slice(cursor)}`;
  }

  private updateRunControls(): void {
    const knowledgeLocked = this.conversationMode === 'knowledge'
      && !this.deps.knowledgeBrainEntitlement.getCurrentStatus().allowed;
    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = this.running || knowledgeLocked;
    }
    if (this.stopButtonEl) {
      this.stopButtonEl.disabled = !this.running;
    }
    this.cancelHintEl?.toggleClass('is-visible', this.running);
  }

  private attachActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('No active note to attach.');
      return;
    }
    const absolute = resolveVaultAbsolutePath(this.app, file.path);
    if (!absolute) {
      new Notice('Could not resolve the active note path.');
      return;
    }
    const prefix = this.inputEl.value.trim() ? `${this.inputEl.value.trim()}\n` : '';
    this.inputEl.value = `${prefix}@"${file.path}"`;
    const mimeType = guessMimeType(file);
    if (mimeType?.startsWith('image/')) {
      new Notice('Image attachment added.');
    } else {
      new Notice('Note attachment added.');
    }
  }

  private async openWeChatPreview(): Promise<void> {
    const file = this.activeEditorContext?.file ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('请先打开一篇笔记，再发送公众号预览。');
      return;
    }
    await this.deps.openWeChatPreview(file);
  }

  private async openSharePopover(anchor?: HTMLElement): Promise<void> {
    const file = this.activeEditorContext?.file ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('请先打开一篇笔记，再打开分享面板。');
      return;
    }
    this.deps.openSharePopover(file, anchor ?? null);
  }

  private async resolveActiveEditorContext(maxChars: number): Promise<{ prompt: string; attachments: FileAttachment[] }> {
    const context = this.getVisibleEditorContext();
    if (!context) {
      return { prompt: '', attachments: [] };
    }
    const absolutePath = resolveVaultAbsolutePath(this.app, context.file.path);
    const mimeType = guessMimeType(context.file);
    const attachments = absolutePath
      ? [{ vaultPath: context.file.path, absolutePath, mimeType }]
      : [];
    const lines = [
      'Current Obsidian context:',
      `File: ${context.file.path}`,
      `Cursor: line ${context.cursorLine + 1}, column ${context.cursorCh + 1}`,
    ];

    const selectedText = context.selection.trim();
    if (selectedText) {
      lines.push(
        'Selected text:',
        '```',
        truncateText(selectedText, maxChars),
        '```',
      );
      return { prompt: lines.join('\n'), attachments };
    }

    if (context.currentLine.trim()) {
      lines.push(
        'Current cursor line:',
        '```',
        context.currentLine,
        '```',
      );
    }

    if (mimeType?.startsWith('image/')) {
      lines.push('The active file is an image attachment.');
      return { prompt: lines.join('\n'), attachments };
    }

    try {
      const text = await this.app.vault.cachedRead(context.file);
      lines.push(
        'Active file content:',
        '```',
        truncateText(text, maxChars),
        '```',
      );
    } catch {
      lines.push('[Could not read active file content]');
    }

    return { prompt: lines.join('\n'), attachments };
  }

  private openRuntimeSetup(): void {
    const settings = this.deps.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(this.agentId);
    if (status.found) {
      new Notice(`${status.descriptor.displayName} is already available.`);
      return;
    }
    new RuntimeSetupModal(this.app, status, this.deps.openSettings).open();
  }
}

function hasPendingUpdate(state: Readonly<UpdateState>): boolean {
  return state.status === 'available' || state.status === 'incompatible';
}

function contextSignature(context: ActiveEditorContext): string {
  return [
    context.file.path,
    context.selection,
    context.currentLine,
    context.cursorLine,
    context.cursorCh,
  ].join('\n');
}

function countTextChars(value: string): number {
  return Array.from(value.trim()).length;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function mergeAttachments(attachments: FileAttachment[]): FileAttachment[] {
  const seen = new Set<string>();
  const merged: FileAttachment[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.vaultPath)) continue;
    seen.add(attachment.vaultPath);
    merged.push(attachment);
  }
  return merged;
}

function configSourceLabel(source: RuntimeConfigSource): string {
  return source === 'providerProfile' ? 'WeSight 配置' : '本机配置';
}


const HISTORY_AGENT_ICONS: Record<AgentId, string> = {
  claude: 'bot',
  codex: 'terminal',
  opencode: 'code',
};

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}
