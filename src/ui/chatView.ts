import { Editor, ItemView, MarkdownView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';

import { AGENT_IDS, getAgentDescriptor } from '../agents';
import wesightLogo from '../../assets/wesight-logo.png';
import type { CloudAuthService } from '../share/cloudAuth';
import type { CloudUser } from '../share/types';
import { ProviderStore } from '../storage/providerStore';
import { VaultStore } from '../storage/vaultStore';
import type {
  AgentId,
  ChatMessage,
  FileAttachment,
  ProviderProfile,
  RuntimeConfigSource,
  RuntimeTurnEvent,
  StoredConversation,
  WeSightObsidianSettings,
} from '../types';
import { createId } from '../utils/id';
import { resolveMentions, findMentionQuery, findSlashQuery } from '../utils/context';
import { filterSlashCommands } from '../utils/slashCommands';
import { getVaultBasePath, resolveVaultAbsolutePath, guessMimeType } from '../utils/vault';
import { RuntimeDiscovery } from '../runtime/discovery';
import { RuntimeManager } from '../runtime/runtimeManager';
import { getClaudeDetectedLocalModel, listLocalModels } from '../runtime/localModels';
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
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private accountSlotEl!: HTMLElement;
  private setupButtonEl!: HTMLButtonElement;
  private sendButtonEl!: HTMLButtonElement;
  private stopButtonEl!: HTMLButtonElement;
  private suggestEl: HTMLElement | null = null;
  private running = false;
  private viewInitialized = false;
  private dropdownCloseRegistered = false;
  private contextTrackingRegistered = false;
  private contextRowEl: HTMLElement | null = null;
  private activeEditorContext: ActiveEditorContext | null = null;
  private observedMarkdownView: MarkdownView | null = null;
  private dismissedContextSignature: string | null = null;
  private configSubmenuEl: HTMLElement | null = null;
  private modelSubmenuEl: HTMLElement | null = null;
  private submenuHideTimeout: number | null = null;
  private scrollScheduled = false;
  private authUnsubscribe: (() => void) | null = null;
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
    this.updateEditorContextFromWorkspace();
    this.render();
    this.ensureConversation();
    this.renderMessages();
    this.refreshStatus();
    void this.restoreAuthSession();
  }

  override async onClose(): Promise<void> {
    // Submenus live on document.body, so they outlive contentEl unless removed here.
    this.hideConfigSubmenu();
    this.accountMenu?.hide();
    this.accountMenu = null;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
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

  private render(): void {
    this.hideConfigSubmenu();
    this.hideModelSubmenu();
    const root = this.contentEl;
    // Keep whatever the user has typed across re-renders.
    const pendingInput = this.inputEl?.value ?? '';
    root.empty();
    root.addClass('wesight-view');
    root.setAttribute('data-agent', this.agentId);

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
    this.statusEl = headerActions.createSpan({ cls: 'wesight-runtime-status', text: 'Checking...' });

    const newChatButton = headerActions.createEl('button', { cls: 'clickable-icon wesight-header-btn' });
    setIcon(newChatButton, 'plus');
    newChatButton.ariaLabel = 'New WeSight chat';
    newChatButton.onclick = () => void this.startNewConversation();

    this.setupButtonEl = headerActions.createEl('button', { cls: 'clickable-icon wesight-header-btn' });
    setIcon(this.setupButtonEl, 'circle-help');
    this.setupButtonEl.ariaLabel = 'Set up current agent';
    this.setupButtonEl.onclick = () => this.openRuntimeSetup();

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

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'wesight-input',
      attr: {
        placeholder: 'Message WeSight...',
      },
    });
    this.inputEl.value = pendingInput;
    this.inputEl.oninput = () => this.updateSuggestions();
    this.inputEl.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
      if (event.key === 'Escape') {
        this.clearSuggestions();
      }
    };

    const toolbar = inputWrapper.createDiv({ cls: 'wesight-input-toolbar' });
    const toolbarLeft = toolbar.createDiv({ cls: 'wesight-toolbar-left' });
    this.renderAgentSelector(toolbarLeft);
    this.renderModelSelector(toolbarLeft);

    const toolbarRight = toolbar.createDiv({ cls: 'wesight-toolbar-right' });
    const planToggle = toolbarRight.createDiv({ cls: 'wesight-permission-toggle' });
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
    this.stopButtonEl.onclick = () => this.deps.runtimeManager.cancel();

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

    if (!user) {
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
    menu.addSeparator();
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
    const accountMenuWidth = 96;
    menu.showAtPosition({
      x: Math.max(8, bounds.right - accountMenuWidth),
      y: bounds.bottom + 4,
      width: accountMenuWidth,
    });
    this.accountMenu = menu;
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
      const hasSubmenu = agentId === 'claude';
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
  }): void {
    const option = parent.createDiv({ cls: 'wesight-model-option wesight-config-source-option' });
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
      void this.selectConfigSource(options.agentId, options.source);
    };
  }

  private getCurrentModelLabel(agentId: AgentId, source: RuntimeConfigSource): string {
    const settings = this.deps.getSettings();
    if (source === 'localCli') {
      if (agentId === 'claude') {
        return getClaudeDetectedLocalModel()?.label ?? '跟随 Claude Code';
      }
      const selectedModel = settings.localModelByAgent[agentId] ?? '';
      if (!selectedModel) return '默认';
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
    const settings = this.deps.getSettings();
    settings.configSources[agentId] = source;
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
    const settings = this.deps.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(this.agentId);
    this.statusEl.toggleClass('is-ready', status.found);
    this.statusEl.toggleClass('is-missing', !status.found);
    this.statusEl.toggleClass('is-error', false);
    this.statusEl.setAttribute('title', status.found ? status.binaryPath ?? '' : status.error ?? '');
    this.statusEl.setText(status.found
      ? `${status.descriptor.shortName} ready`
      : `${status.descriptor.shortName} missing`);
    this.setupButtonEl?.toggleClass('needs-setup', !status.found);
    this.setupButtonEl?.setAttribute('title', status.found
      ? `${status.descriptor.displayName} is available`
      : `Install ${status.descriptor.displayName}`);
    this.updateRunControls();
  }

  // Conversations start as in-memory drafts; they are only persisted once the
  // first message is sent, so open/close cycles never litter the store.
  private ensureConversation(forceNew = false): void {
    if (this.conversation && !forceNew) return;
    this.conversation = this.deps.vaultStore.createDraftConversation(this.agentId);
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
    item.createEl('pre', { cls: 'wesight-message-content', text: message.content });
  }

  private renderEmptyState(): void {
    const empty = this.messagesEl.createDiv({ cls: 'wesight-welcome' });
    empty.createDiv({ cls: 'wesight-welcome-greeting', text: 'How can I help?' });
  }

  private async sendMessage(): Promise<void> {
    if (this.running) return;
    const rawPrompt = this.inputEl.value.trim();
    if (!rawPrompt) return;
    this.ensureConversation();
    const conversation = this.conversation;
    if (!conversation) return;
    const vaultBasePath = getVaultBasePath(this.app);
    if (!vaultBasePath) {
      new Notice('WeSight needs a local desktop vault path.');
      return;
    }
    const settings = this.deps.getSettings();
    const resolved = await resolveMentions(this.app, rawPrompt, settings.maxContextFileChars);
    const activeContext = await this.resolveActiveEditorContext(settings.maxContextFileChars);
    const runtimePrompt = activeContext.prompt
      ? `${resolved.prompt}\n\n${activeContext.prompt}`
      : resolved.prompt;
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

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      agentId: this.agentId,
    };
    conversation.messages.push(assistantMessage);
    const assistantEl = this.messagesEl.createDiv({ cls: 'wesight-message is-assistant is-streaming' });
    assistantEl.createDiv({ cls: 'wesight-message-role', text: getAgentDescriptor(this.agentId).displayName });
    const contentEl = assistantEl.createEl('pre', { cls: 'wesight-message-content', text: 'Thinking...' });

    // Deltas are appended as text nodes instead of re-setting the whole message,
    // which keeps long streams O(n) instead of O(n²).
    let streamStarted = false;
    const appendDelta = (delta: string): void => {
      if (!streamStarted) {
        contentEl.setText('');
        streamStarted = true;
      }
      contentEl.appendText(delta);
    };
    const agentId = this.agentId;
    const onEvent = (event: RuntimeTurnEvent): void => {
      if (event.type === 'session') {
        conversation.sessionIds = {
          ...(conversation.sessionIds ?? {}),
          [agentId]: event.sessionId,
        };
      } else if (event.type === 'text') {
        assistantMessage.content += event.content;
        appendDelta(event.content);
        assistantEl.removeClass('is-streaming');
        this.scheduleScrollToBottom();
      } else if (event.type === 'tool') {
        const line = `\n\n• ${event.toolCall.name} ${event.toolCall.status}`;
        assistantMessage.content += line;
        appendDelta(line);
        this.scheduleScrollToBottom();
      } else if (event.type === 'error') {
        assistantMessage.role = 'error';
        assistantMessage.content += `\n${event.message}${event.detail ? `\n${event.detail}` : ''}`;
        assistantEl.addClass('is-error');
        assistantEl.removeClass('is-streaming');
        contentEl.setText(assistantMessage.content.trim());
        streamStarted = true;
      }
    };

    this.running = true;
    this.updateRunControls();
    try {
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
        sessionId: conversation.sessionIds?.[this.agentId],
        systemPrompt: settings.systemPrompt,
        planMode: this.planMode,
        attachments,
      }, onEvent);
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = 'Done.';
        contentEl.setText(assistantMessage.content);
      }
      assistantEl.removeClass('is-streaming');
    } finally {
      conversation.updatedAt = Date.now();
      await this.deps.vaultStore.replaceConversation(conversation);
      this.running = false;
      this.updateRunControls();
      this.refreshStatus();
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

  private async switchAgent(agentId: AgentId, promptInstallIfMissing = false): Promise<void> {
    this.agentId = agentId;
    this.render();
    this.renderMessages();
    this.refreshStatus();
    if (promptInstallIfMissing) {
      this.openRuntimeSetup();
    }
  }

  private async selectLocalCli(modelId = ''): Promise<void> {
    this.deps.getSettings().configSources[this.agentId] = 'localCli';
    this.deps.getSettings().localModelByAgent[this.agentId] = this.agentId === 'claude' ? '' : modelId;
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
      const selectedModel = settings.localModelByAgent[this.agentId] ?? '';
      const label = selectedModel
        ? listLocalModels(this.agentId).find(model => model.id === selectedModel)?.label ?? selectedModel
        : 'CLI 默认';
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

  private updateSuggestions(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const slashQuery = findSlashQuery(this.inputEl.value, cursor);
    if (slashQuery !== null) {
      const commands = filterSlashCommands(slashQuery);
      this.showSuggestions(commands.map(command => ({
        label: command.label,
        description: command.description,
        apply: () => this.replaceCurrentToken(`/${slashQuery}`, command.insertText),
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

  private replaceCurrentToken(token: string, replacement: string): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const rawStart = this.inputEl.value.lastIndexOf(token, cursor);
    if (rawStart < 0) return;
    const start = Math.max(0, rawStart);
    this.inputEl.value = `${this.inputEl.value.slice(0, start)}${replacement}${this.inputEl.value.slice(cursor)}`;
  }

  private updateRunControls(): void {
    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = this.running;
    }
    if (this.stopButtonEl) {
      this.stopButtonEl.disabled = !this.running;
    }
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
