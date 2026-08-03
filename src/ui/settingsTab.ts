import { App, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';

import { AGENT_IDS, getAgentDescriptor } from '../agents';
import { logsDir, providersPath, tmpDir, wesightHome } from '../paths';
import { ProviderStore } from '../storage/providerStore';
import type {
  AgentId,
  AnthropicAuthMode,
  ProviderProfile,
  ProviderWireApi,
  RuntimeBinarySource,
  RuntimeConfigSource,
  WeSightObsidianSettings,
} from '../types';
import { RuntimeDiscovery, invalidateRuntimeDiscoveryCache } from '../runtime/discovery';
import type { RuntimeManager } from '../runtime/runtimeManager';
import type { CloudAuthService } from '../share/cloudAuth';
import { inferAnthropicAuthMode, requiresProviderApiKey } from '../utils/providerAuth';
import { fetchProviderModels, resolveProviderModels, testProviderConnection } from '../utils/providerModels';
import type { WeChatCloudApi } from '../wechat/cloudApi';
import { promptForText } from './textPromptModal';
import { WeChatPublishingSettings } from './wechatPublishingSettings';
import { initializeStoredSecretInput, resolveSecretInput } from './secretInput';

interface SettingsTabDeps {
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  providerStore: ProviderStore;
  runtimeManager: RuntimeManager;
  refreshViews: () => void;
  cloudAuth: CloudAuthService;
  wechatApi: WeChatCloudApi;
}

type SettingsTabId = 'general' | AgentId;
type ProviderApiFormat = 'anthropic' | 'openai';

const RUNTIME_SOURCE_LABELS: Record<RuntimeBinarySource, string> = {
  configured: 'configured',
  desktopApp: '桌面应用内置',
  managed: 'managed',
  path: 'path',
};

function runtimeSourceLabel(source: RuntimeBinarySource): string {
  return RUNTIME_SOURCE_LABELS[source];
}

interface ProviderModelPreset {
  id: string;
  name: string;
}

interface ProviderPreset {
  key: string;
  label: string;
  iconText: string;
  accent: string;
  defaultApiFormat: ProviderApiFormat;
  baseUrls: Record<ProviderApiFormat, string>;
  models: ProviderModelPreset[];
  anthropicAuthMode?: AnthropicAuthMode;
  apiKeyUrl?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    iconText: 'OA',
    accent: '#111827',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: '',
      openai: 'https://api.openai.com/v1',
    },
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    ],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'anthropic',
    label: 'Claude',
    iconText: 'AI',
    accent: '#d97757',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.anthropic.com',
      openai: '',
    },
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
    anthropicAuthMode: 'apiKey',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'google',
    label: 'Google',
    iconText: 'G',
    accent: '#4285f4',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: '',
      openai: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
    ],
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    iconText: 'DS',
    accent: '#3b82f6',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.deepseek.com/anthropic',
      openai: 'https://api.deepseek.com',
    },
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    iconText: 'K',
    accent: '#1f2937',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: 'https://api.moonshot.cn/anthropic',
      openai: 'https://api.moonshot.cn/v1',
    },
    models: [
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    key: 'qwen',
    label: 'Qwen',
    iconText: 'Q',
    accent: '#7c3aed',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    models: [
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus' },
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    key: 'zhipu',
    label: 'Zhipu',
    iconText: 'Z',
    accent: '#2563eb',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
      openai: 'https://open.bigmodel.cn/api/paas/v4',
    },
    models: [
      { id: 'glm-5.1', name: 'GLM 5.1' },
      { id: 'glm-5', name: 'GLM 5' },
      { id: 'glm-4.7', name: 'GLM 4.7' },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    iconText: 'M',
    accent: '#ef4444',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.minimaxi.com/anthropic',
      openai: 'https://api.minimaxi.com/v1',
    },
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
];

export class WeSightSettingTab extends PluginSettingTab {
  private editingProfileId: string | null = null;
  private activeTab: SettingsTabId = 'general';
  private selectedProviderKey = 'deepseek';
  private readonly publishingSettings: WeChatPublishingSettings;

  constructor(app: App, plugin: Plugin, private readonly deps: SettingsTabDeps) {
    super(app, plugin);
    this.publishingSettings = new WeChatPublishingSettings({
      app,
      auth: deps.cloudAuth,
      api: deps.wechatApi,
      requestRender: () => this.display(),
      getSettings: () => deps.getSettings(),
      saveSettings: () => deps.saveSettings(),
    });
    plugin.register(deps.cloudAuth.onChange(() => {
      if (this.activeTab === 'general') this.display();
    }));
  }

  openTab(tab: SettingsTabId): void {
    this.activeTab = tab;
    this.editingProfileId = null;
    this.display();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderTabs(containerEl);
    const panel = containerEl.createDiv({ cls: 'wesight-settings-panel' });
    if (this.activeTab === 'general') {
      this.renderGeneral(panel);
      this.publishingSettings.render(panel);
      this.publishingSettings.activate();
      this.renderEnvironment(panel);
      this.renderPrivacy(panel);
      this.renderDiagnostics(panel);
      return;
    }
    this.renderAgentSettings(panel, this.activeTab);
    if (this.activeTab !== 'codex') this.renderProfiles(panel, this.activeTab);
    this.renderDiagnostics(panel, this.activeTab);
  }

  private renderTabs(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: 'wesight-settings-tabs-wrap' });
    const tabs = wrap.createDiv({ cls: 'wesight-settings-tabs' });
    const entries: Array<{ id: SettingsTabId; label: string }> = [
      { id: 'general', label: '通用' },
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'opencode', label: 'OpenCode' },
    ];
    for (const entry of entries) {
      const tab = tabs.createEl('button', {
        cls: 'wesight-settings-tab',
        text: entry.label,
      });
      tab.toggleClass('is-active', this.activeTab === entry.id);
      tab.onclick = () => {
        this.activeTab = entry.id;
        this.editingProfileId = null;
        this.display();
      };
    }
  }

  private renderGeneral(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    const settings = this.deps.getSettings();

    new Setting(section)
      .setName('Default agent')
      .setDesc('The agent used for new chat tabs and inline edits.')
      .addDropdown(dropdown => {
        for (const agentId of AGENT_IDS) {
          dropdown.addOption(agentId, getAgentDescriptor(agentId).displayName);
        }
        dropdown
          .setValue(settings.defaultAgentId)
          .onChange(async value => {
            settings.defaultAgentId = value as AgentId;
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });
  }

  private renderAgentSettings(containerEl: HTMLElement, agentId: AgentId): void {
    const descriptor = getAgentDescriptor(agentId);
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    new Setting(section).setName(descriptor.displayName).setHeading();
    const settings = this.deps.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId, { withVersion: true });

    const row = section.createDiv({ cls: 'wesight-agent-row' });
    row.createDiv({ text: descriptor.displayName });
    const sourceLabel = status.source ? runtimeSourceLabel(status.source) : '';
    row.createDiv({ text: status.found ? `${sourceLabel}: ${status.version ?? status.binaryPath}` : 'Missing' });
    const actions = row.createDiv();
    const setup = actions.createEl('button', {
      text: status.found ? 'Detected' : 'Installation guide',
    });
    setup.disabled = status.found;
    setup.onclick = () => {
      window.open(descriptor.docsUrl, '_blank', 'noopener,noreferrer');
    };

    const configSourceSetting = new Setting(section)
      .setName('Config source')
      .addDropdown(dropdown => {
        dropdown.addOption('localCli', '本地模式');
        dropdown.addOption(
          'providerProfile',
          agentId === 'codex' ? 'WeSight 模式（不可用）' : 'WeSight 模式',
        );
        if (agentId === 'codex') {
          // Codex 暂时仅支持本机配置，保留 WeSight 模式入口但提示支持中。
          dropdown.selectEl.options[dropdown.selectEl.options.length - 1].disabled = true;
        }
        dropdown
          .setValue(agentId === 'codex' ? 'localCli' : settings.configSources[agentId])
          .onChange(async value => {
            if (agentId === 'codex') {
              settings.configSources[agentId] = 'localCli';
            } else {
              settings.configSources[agentId] = value as RuntimeConfigSource;
            }
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });
    if (agentId === 'codex') {
      configSourceSetting.setDesc(
        'Codex 当前仅支持本机模式，自动复用官方 ChatGPT / Codex 桌面应用内置的 Codex CLI；WeSight 模式不可用。',
      );
    }

    new Setting(section)
      .setName('CLI path')
      .setDesc('Optional per-device executable path. Empty searches the system path and compatible legacy WeSight runtime locations.')
      .addText(text => {
        text
          .setPlaceholder(descriptor.binaryName)
          .setValue(settings.configuredPaths[agentId])
          .onChange(async value => {
            settings.configuredPaths[agentId] = value.trim();
            invalidateRuntimeDiscoveryCache(agentId);
            await this.deps.saveSettings();
          });
      });

    if (agentId === 'codex') {
      const codexStatus = this.deps.runtimeManager.getCodexStatus();
      const modelLabel = codexStatus.currentModel?.displayName ?? codexStatus.currentModelId ?? '等待 Codex App 返回';
      const statusText = codexStatus.state === 'ready'
        ? codexStatus.authenticated === false
          ? '已连接，Codex 尚未登录。请在 Codex App 或 CLI 中完成登录。'
          : `已连接 · ${modelLabel}`
        : codexStatus.state === 'connecting'
          ? '正在连接 Codex App Server…'
          : codexStatus.state === 'error'
            ? `连接失败：${codexStatus.error ?? '未知错误'}`
            : '尚未连接';
      new Setting(section)
        .setName('Codex app server')
        .setDesc(statusText)
        .addButton(button => button
          .setButtonText('刷新状态')
          .onClick(async () => {
            button.setDisabled(true);
            await this.deps.runtimeManager.refreshCodexStatus();
            this.display();
          }));
      new Setting(section)
        .setName('当前模型')
        .setDesc('模型来自本机 Codex 配置，WeSight 仅展示读取结果。')
        .addText(text => {
          text.setValue(modelLabel);
          text.inputEl.disabled = true;
        });
      new Setting(section)
        .setName('图片生成')
        .setDesc(codexStatus.imageGeneration === false
          ? '当前模型或供应商未提供图片生成，普通聊天仍可使用。'
          : codexStatus.imageGeneration === true
            ? '可用，生成结果会保存到 Vault。'
            : '能力状态尚未返回。');
      if (codexStatus.state === 'idle') {
        void this.deps.runtimeManager.refreshCodexStatus().then(() => {
          if (this.activeTab === 'codex') this.display();
        });
      }
      return;
    }

    new Setting(section)
      .setName('Local model')
      .setDesc('Optional model override for local CLI runs. Empty follows the CLI config.')
      .addText(text => {
        text
          .setPlaceholder('CLI default')
          .setValue(settings.localModelByAgent[agentId])
          .onChange(async value => {
            settings.localModelByAgent[agentId] = value.trim();
            await this.deps.saveSettings();
          });
      });
  }

  private renderProfiles(containerEl: HTMLElement, agentFilter?: AgentId): void {
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    new Setting(section)
      .setName(agentFilter ? `${getAgentDescriptor(agentFilter).shortName} 模型配置` : '模型')
      .setHeading();
    this.renderProviderConsole(section, agentFilter);
  }

  private renderProviderConsole(section: HTMLElement, agentFilter?: AgentId): void {
    const visiblePresets = agentFilter
      ? PROVIDER_PRESETS.filter(preset => Boolean(preset.baseUrls[providerFormatForAgent(agentFilter)]))
      : [...PROVIDER_PRESETS];
    if (!visiblePresets.some(preset => preset.key === this.selectedProviderKey)) {
      this.selectedProviderKey = visiblePresets[0]?.key ?? PROVIDER_PRESETS[0].key;
    }

    const preset = visiblePresets.find(item => item.key === this.selectedProviderKey) ?? visiblePresets[0] ?? PROVIDER_PRESETS[0];
    const anyExistingProfile = this.findPresetProfile(preset, agentFilter) ?? this.findPresetProfile(preset);
    let format = this.resolveInitialProviderFormat(preset, anyExistingProfile, agentFilter);
    let modelItems = toModelItems(anyExistingProfile, preset);
    let selectedModelId = anyExistingProfile?.defaultModel || anyExistingProfile?.model || modelItems[0]?.id || '';
    let anthropicAuthMode = inferAnthropicAuthMode(
      'claude',
      preset.label,
      anyExistingProfile?.baseUrl || preset.baseUrls.anthropic,
      anyExistingProfile?.anthropicAuthMode ?? preset.anthropicAuthMode,
    ) ?? 'authToken';

    const consoleEl = section.createDiv({ cls: 'wesight-provider-console' });
    const sidebar = consoleEl.createDiv({ cls: 'wesight-provider-sidebar' });
    const sidebarHead = sidebar.createDiv({ cls: 'wesight-provider-sidebar-head' });
    sidebarHead.createSpan({ text: '模型提供商' });
    const sidebarActions = sidebarHead.createDiv({ cls: 'wesight-provider-sidebar-actions' });
    const importBtn = sidebarActions.createEl('button', { text: '导入', attr: { type: 'button' } });
    importBtn.onclick = () => void this.importProviderProfiles();
    const exportBtn = sidebarActions.createEl('button', { text: '导出', attr: { type: 'button' } });
    exportBtn.onclick = () => void this.exportProviderProfiles();

    const list = sidebar.createDiv({ cls: 'wesight-provider-list' });
    for (const item of visiblePresets) {
      const profile = this.findPresetProfile(item, agentFilter) ?? this.findPresetProfile(item);
      const enabled = Boolean(profile?.apiKey || profile?.baseUrl || profile?.models.length);
      const row = list.createEl('button', {
        cls: 'wesight-provider-list-item',
        attr: { type: 'button' },
      });
      row.toggleClass('is-selected', item.key === preset.key);
      row.toggleClass('is-enabled', enabled);
      row.onclick = () => {
        this.selectedProviderKey = item.key;
        this.display();
      };
      const icon = row.createSpan({ cls: 'wesight-provider-icon', text: item.iconText });
      icon.style.setProperty('--provider-accent', item.accent);
      row.createSpan({ cls: 'wesight-provider-name', text: item.label });
      const toggle = row.createSpan({ cls: 'wesight-provider-toggle' });
      toggle.createSpan();
    }

    const detail = consoleEl.createDiv({ cls: 'wesight-provider-detail' });
    const detailHead = detail.createDiv({ cls: 'wesight-provider-detail-head' });
    const titleWrap = detailHead.createDiv({ cls: 'wesight-provider-title-wrap' });
    const titleIcon = titleWrap.createSpan({ cls: 'wesight-provider-icon large', text: preset.iconText });
    titleIcon.style.setProperty('--provider-accent', preset.accent);
    const title = titleWrap.createDiv();
    const titleLine = title.createDiv({ cls: 'wesight-provider-title-line' });
    titleLine.createSpan({ text: `${preset.label} 提供商设置` });
    if (preset.apiKeyUrl) {
      const keyLink = titleLine.createEl('a', {
        cls: 'wesight-provider-link-icon',
        href: preset.apiKeyUrl,
        attr: { 'aria-label': `${preset.label} API Key` },
      });
      keyLink.setAttr('target', '_blank');
      keyLink.setAttr('rel', 'noopener');
      setIcon(keyLink, 'external-link');
    }
    const activeProfile = this.findPresetProfile(preset, agentFilter ?? providerAgentForFormat(format));
    const isEnabled = Boolean(activeProfile?.apiKey || activeProfile?.baseUrl || activeProfile?.models.length);
    detailHead.createSpan({
      cls: `wesight-provider-status ${isEnabled ? 'is-enabled' : ''}`,
      text: isEnabled ? '已开启' : '未开启',
    });

    const apiKeyField = detail.createDiv({ cls: 'wesight-provider-field' });
    const apiKeyHead = apiKeyField.createDiv({ cls: 'wesight-provider-field-head' });
    apiKeyHead.createSpan({ text: 'API key' });
    if (preset.apiKeyUrl) {
      const getKey = apiKeyHead.createEl('a', { text: '获取 API key ->', href: preset.apiKeyUrl });
      getKey.setAttr('target', '_blank');
      getKey.setAttr('rel', 'noopener');
    }
    const secretWrap = apiKeyField.createDiv({ cls: 'wesight-provider-secret' });
    const apiKeyInput = secretWrap.createEl('input', {
      attr: {
        type: 'password',
        placeholder: '输入你的 API key',
        'aria-label': anyExistingProfile?.apiKey
          ? 'API key 已安全保存，输入新值可替换'
          : '输入 API key',
      },
    });
    initializeStoredSecretInput(apiKeyInput, Boolean(anyExistingProfile?.apiKey));
    const reveal = secretWrap.createEl('button', {
      cls: 'wesight-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '显示 API key' },
    });
    setIcon(reveal, 'eye-off');
    reveal.onclick = () => {
      const visible = apiKeyInput.type === 'text';
      apiKeyInput.type = visible ? 'password' : 'text';
      reveal.setAttr('aria-label', visible ? '显示 API key' : '隐藏 API key');
      setIcon(reveal, visible ? 'eye-off' : 'eye');
    };

    const baseUrlField = detail.createDiv({ cls: 'wesight-provider-field' });
    baseUrlField.createDiv({ cls: 'wesight-provider-field-head' }).createSpan({ text: 'API Base URL' });
    const baseWrap = baseUrlField.createDiv({ cls: 'wesight-provider-input-wrap' });
    const baseUrlInput = baseWrap.createEl('input', {
      attr: {
        type: 'text',
        placeholder: 'https://api.example.com',
      },
    });
    baseUrlInput.value = anyExistingProfile?.baseUrl || preset.baseUrls[format] || '';
    const resetBaseUrl = baseWrap.createEl('button', {
      cls: 'wesight-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '恢复默认地址' },
    });
    setIcon(resetBaseUrl, 'x-circle');
    resetBaseUrl.onclick = () => {
      baseUrlInput.value = preset.baseUrls[format] || '';
    };

    const formatField = detail.createDiv({ cls: 'wesight-provider-field' });
    formatField.createDiv({ cls: 'wesight-provider-field-head' }).createSpan({ text: 'API 格式' });
    const formatOptions = formatField.createDiv({ cls: 'wesight-api-format-options' });
    const formatGroupName = `wesight-provider-format-${preset.key}-${agentFilter ?? 'all'}`;
    const formatHelp = formatField.createDiv({ cls: 'wesight-provider-help' });
    for (const option of [
      { value: 'anthropic' as const, label: 'Anthropic 兼容' },
      { value: 'openai' as const, label: 'OpenAI 兼容' },
    ]) {
      const optionEl = formatOptions.createEl('label');
      const radio = optionEl.createEl('input', {
        attr: {
          type: 'radio',
          name: formatGroupName,
          value: option.value,
        },
      });
      radio.checked = format === option.value;
      radio.disabled = Boolean(agentFilter) || !preset.baseUrls[option.value];
      radio.onchange = () => {
        if (!radio.checked) return;
        const oldBaseUrls = Object.values(preset.baseUrls).filter(Boolean);
        const currentBaseUrl = baseUrlInput.value.trim();
        format = option.value;
        if (!currentBaseUrl || oldBaseUrls.includes(currentBaseUrl)) {
          baseUrlInput.value = preset.baseUrls[format] || '';
        }
        formatHelp.setText(`请选择 API 协议格式：${providerFormatLabel(format)}`);
      };
      optionEl.createSpan({ text: option.label });
    }
    formatHelp.setText(`请选择 API 协议格式：${providerFormatLabel(format)}`);

    const authField = detail.createDiv({ cls: 'wesight-provider-field' });
    authField.createDiv({ cls: 'wesight-provider-field-head' }).createSpan({ text: 'Claude 鉴权方式' });
    const authOptions = authField.createDiv({ cls: 'wesight-api-format-options' });
    const authGroupName = `wesight-provider-auth-${preset.key}-${agentFilter ?? 'all'}`;
    for (const option of [
      { value: 'authToken' as const, label: 'Auth Token（兼容服务）' },
      { value: 'apiKey' as const, label: 'API Key（Anthropic 官方）' },
    ]) {
      const optionEl = authOptions.createEl('label');
      const radio = optionEl.createEl('input', {
        attr: { type: 'radio', name: authGroupName, value: option.value },
      });
      radio.checked = anthropicAuthMode === option.value;
      radio.disabled = (agentFilter ?? providerAgentForFormat(format)) !== 'claude';
      radio.onchange = () => {
        if (radio.checked) anthropicAuthMode = option.value;
      };
      optionEl.createSpan({ text: option.label });
    }
    authField.createDiv({
      cls: 'wesight-provider-help',
      text: 'Moonshot 等 Anthropic 兼容服务使用 Auth Token；api.anthropic.com 使用 API Key。',
    });

    const testRow = detail.createDiv({ cls: 'wesight-provider-test-row' });
    const testBtn = testRow.createEl('button', { text: '测试连接', attr: { type: 'button' } });
    testBtn.onclick = () => void this.testProviderConfiguration({
      preset,
      agentFilter,
      getFormat: () => format,
      getAnthropicAuthMode: () => anthropicAuthMode,
      getModel: () => selectedModelId || modelItems[0]?.id || '',
      baseUrlInput,
      apiKeyInput,
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      trigger: testBtn,
    });

    const modelHead = detail.createDiv({ cls: 'wesight-provider-model-head' });
    modelHead.createSpan({ text: '可用模型列表' });
    const modelActions = modelHead.createDiv({ cls: 'wesight-provider-model-actions' });
    const refreshModels = modelActions.createEl('button', { text: '获取模型列表', attr: { type: 'button' } });
    const refreshIcon = refreshModels.createSpan({ cls: 'wesight-provider-action-icon' });
    setIcon(refreshIcon, 'refresh-cw');
    refreshModels.onclick = () => void this.loadModelsIntoPanel({
      preset,
      agentFilter,
      getFormat: () => format,
      getAnthropicAuthMode: () => anthropicAuthMode,
      baseUrlInput,
      apiKeyInput,
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      setModels: next => {
        modelItems = mergeModelItems([...modelItems, ...next]);
        selectedModelId = modelItems.find(item => item.id === selectedModelId)?.id ?? modelItems[0]?.id ?? '';
      },
      renderModelCards,
      trigger: refreshModels,
      noticePrefix: '已获取',
    });
    const addModel = modelActions.createEl('button', { text: '添加模型', attr: { type: 'button' } });
    const addIcon = addModel.createSpan({ cls: 'wesight-provider-action-icon' });
    setIcon(addIcon, 'plus-circle');
    let editingModelId: string | null = null;

    const addPanel = detail.createDiv({ cls: 'wesight-provider-model-add is-hidden' });
    const addIdInput = addPanel.createEl('input', {
      attr: {
        type: 'text',
        placeholder: '模型 ID，例如 deepseek-chat',
      },
    });
    const addNameInput = addPanel.createEl('input', {
      attr: {
        type: 'text',
        placeholder: '显示名称，可选',
      },
    });
    const addConfirm = addPanel.createEl('button', { text: '添加', attr: { type: 'button' } });
    const addCancel = addPanel.createEl('button', {
      cls: 'wesight-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '取消添加模型' },
    });
    setIcon(addCancel, 'x');
    addModel.onclick = () => showModelAddPanel();
    addConfirm.onclick = () => upsertInlineModel();
    addCancel.onclick = () => hideModelAddPanel();
    const submitAddOnKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        upsertInlineModel();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideModelAddPanel();
      }
    };
    addIdInput.addEventListener('keydown', submitAddOnKey);
    addNameInput.addEventListener('keydown', submitAddOnKey);

    const modelList = detail.createDiv({ cls: 'wesight-provider-model-list' });
    function showModelAddPanel(model?: ProviderModelPreset): void {
      editingModelId = model?.id ?? null;
      addPanel.removeClass('is-hidden');
      addConfirm.setText(model ? '保存' : '添加');
      addIdInput.value = model?.id ?? '';
      addNameInput.value = model?.name ?? '';
      addIdInput.focus();
      addIdInput.select();
    }

    function hideModelAddPanel(): void {
      editingModelId = null;
      addConfirm.setText('添加');
      addPanel.addClass('is-hidden');
    }

    function upsertInlineModel(): void {
      const id = addIdInput.value.trim();
      if (!id) {
        new Notice('请输入模型 ID。');
        addIdInput.focus();
        return;
      }
      const existing = modelItems.find(model => model.id === id && model.id !== editingModelId);
      if (existing) {
        selectedModelId = existing.id;
        renderModelCards();
        hideModelAddPanel();
        new Notice('模型已存在，已选中该模型。');
        return;
      }
      const next = {
        id,
        name: addNameInput.value.trim() || modelNameFromId(id),
      };
      if (editingModelId) {
        modelItems = mergeModelItems(modelItems.map(model => model.id === editingModelId ? next : model));
        if (selectedModelId === editingModelId) {
          selectedModelId = next.id;
        }
      } else {
        modelItems = mergeModelItems([...modelItems, next]);
      }
      selectedModelId = next.id;
      renderModelCards();
      hideModelAddPanel();
    }

    function renderModelCards(): void {
      modelList.empty();
      if (modelItems.length === 0) {
        modelList.createDiv({ cls: 'wesight-provider-empty', text: '暂无模型，请手动添加或获取模型列表。' });
        return;
      }
      for (const model of modelItems) {
        const card = modelList.createDiv({ cls: 'wesight-provider-model-card' });
        card.toggleClass('is-selected', model.id === selectedModelId);
        card.onclick = () => {
          selectedModelId = model.id;
          renderModelCards();
        };
        card.createSpan({ cls: 'wesight-provider-model-dot' });
        const copy = card.createDiv();
        copy.createDiv({ cls: 'wesight-provider-model-name', text: model.name });
        copy.createDiv({ cls: 'wesight-provider-model-id', text: model.id });
        const actions = card.createDiv({ cls: 'wesight-provider-model-card-actions' });
        const edit = actions.createEl('button', {
          cls: 'wesight-provider-icon-btn',
          attr: { type: 'button', 'aria-label': '编辑模型' },
        });
        setIcon(edit, 'pencil');
        edit.onclick = event => {
          event.stopPropagation();
          selectedModelId = model.id;
          showModelAddPanel(model);
          renderModelCards();
        };
        const remove = actions.createEl('button', {
          cls: 'wesight-provider-icon-btn',
          attr: { type: 'button', 'aria-label': '删除模型' },
        });
        setIcon(remove, 'trash-2');
        remove.onclick = event => {
          event.stopPropagation();
          modelItems = modelItems.filter(item => item.id !== model.id);
          if (selectedModelId === model.id) {
            selectedModelId = modelItems[0]?.id ?? '';
          }
          if (editingModelId === model.id) {
            hideModelAddPanel();
          }
          renderModelCards();
        };
      }
    }
    renderModelCards();

    const footer = detail.createDiv({ cls: 'wesight-provider-footer' });
    const cancel = footer.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.onclick = () => this.display();
    const save = footer.createEl('button', {
      cls: 'mod-cta',
      text: '保存',
      attr: { type: 'button' },
    });
    save.onclick = () => void this.saveProviderPresetProfile({
      preset,
      agentFilter,
      format,
      baseUrl: baseUrlInput.value,
      apiKey: resolveSecretInput(apiKeyInput.value, anyExistingProfile?.apiKey ?? ''),
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      models: modelItems,
      defaultModel: selectedModelId || modelItems[0]?.id || '',
      anthropicAuthMode,
    });
  }

  private resolveInitialProviderFormat(
    preset: ProviderPreset,
    profile: ProviderProfile | null,
    agentFilter?: AgentId,
  ): ProviderApiFormat {
    if (agentFilter) {
      return supportedProviderFormat(preset, providerFormatForAgent(agentFilter));
    }
    if (profile) {
      return supportedProviderFormat(preset, providerFormatForAgent(profile.agentId));
    }
    return supportedProviderFormat(preset, preset.defaultApiFormat);
  }

  private findPresetProfile(preset: ProviderPreset, agentId?: AgentId): ProviderProfile | null {
    const profiles = this.deps.providerStore.list(agentId);
    const names = new Set([preset.key, preset.label, preset.label.toLowerCase()]);
    return profiles.find(profile => names.has(profile.name) || names.has(profile.name.toLowerCase())) ?? null;
  }

  private async exportProviderProfiles(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.deps.providerStore.exportProfiles(), null, 2));
      new Notice('已复制脱敏模型配置。');
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async importProviderProfiles(): Promise<void> {
    // Electron does not implement window.prompt; collect the JSON via a modal.
    const importText = await promptForText(this.app, {
      title: '导入模型配置',
      placeholder: '粘贴从 WeSight 导出的 Provider Profiles JSON',
      multiline: true,
      submitLabel: '导入',
      cancelLabel: '取消',
    });
    if (!importText?.trim()) return;
    try {
      const parsed: unknown = JSON.parse(importText);
      const imported = this.deps.providerStore.importProfiles(parsed);
      new Notice(`已导入 ${imported.length} 个模型配置。`);
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadModelsIntoPanel(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    getFormat: () => ProviderApiFormat;
    getAnthropicAuthMode: () => AnthropicAuthMode;
    baseUrlInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    existingApiKey: string;
    setModels: (models: ProviderModelPreset[]) => void;
    renderModelCards: () => void;
    trigger: HTMLButtonElement;
    noticePrefix: string;
  }): Promise<void> {
    options.trigger.disabled = true;
    try {
      const format = options.getFormat();
      const apiKey = resolveSecretInput(options.apiKeyInput.value, options.existingApiKey);
      const altFormat: ProviderApiFormat = format === 'anthropic' ? 'openai' : 'anthropic';
      const altBaseUrl = options.preset.baseUrls[altFormat];
      const { models: fetched, source } = await resolveProviderModels({
        primary: {
          agentId: options.agentFilter ?? providerAgentForFormat(format),
          baseUrl: options.baseUrlInput.value,
          apiKey,
          anthropicAuthMode: options.getAnthropicAuthMode(),
        },
        fallback: altBaseUrl
          ? { agentId: providerAgentForFormat(altFormat), baseUrl: altBaseUrl, apiKey }
          : undefined,
        presetModelIds: options.preset.models.map(model => model.id),
      });
      const modelItems = mergeModelItems(fetched.map(id => {
        const presetModel = options.preset.models.find(model => model.id === id);
        return {
          id,
          name: presetModel?.name ?? modelNameFromId(id),
        };
      }));
      options.setModels(modelItems);
      options.renderModelCards();
      const sourceNote = source === 'fallback'
        ? '（已从兼容端点获取）'
        : source === 'preset'
          ? '（该端点未提供模型列表，已载入内置模型，可手动添加）'
          : '';
      new Notice(`${options.noticePrefix} ${modelItems.length} 个模型。${sourceNote}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      options.trigger.disabled = false;
    }
  }

  private async testProviderConfiguration(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    getFormat: () => ProviderApiFormat;
    getAnthropicAuthMode: () => AnthropicAuthMode;
    getModel: () => string;
    baseUrlInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    existingApiKey: string;
    trigger: HTMLButtonElement;
  }): Promise<void> {
    options.trigger.disabled = true;
    try {
      const format = options.getFormat();
      const agentId = options.agentFilter ?? providerAgentForFormat(format);
      await testProviderConnection({
        agentId,
        baseUrl: options.baseUrlInput.value,
        apiKey: resolveSecretInput(options.apiKeyInput.value, options.existingApiKey),
        anthropicAuthMode: options.getAnthropicAuthMode(),
        model: options.getModel(),
        wireApi: providerWireApi(options.preset, format),
      });
      new Notice(`连接成功：${options.getModel()}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      options.trigger.disabled = false;
    }
  }

  private async saveProviderPresetProfile(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    format: ProviderApiFormat;
    baseUrl: string;
    apiKey: string;
    existingApiKey: string;
    models: ProviderModelPreset[];
    defaultModel: string;
    anthropicAuthMode: AnthropicAuthMode;
  }): Promise<void> {
    try {
      const targetAgent = options.agentFilter ?? providerAgentForFormat(options.format);
      if (targetAgent === 'codex') {
        throw new Error('Codex 的 WeSight 模式支持中，当前请使用本机模式。');
      }
      const existing = this.findPresetProfile(options.preset, targetAgent);
      const baseUrl = options.baseUrl.trim() || options.preset.baseUrls[options.format];
      const apiKey = options.apiKey || options.existingApiKey;
      if (requiresProviderApiKey(baseUrl) && !apiKey.trim()) {
        throw new Error('远程模型服务需要 API Key，请重新输入后保存。');
      }
      const profile = this.deps.providerStore.save({
        agentId: targetAgent,
        id: existing?.id,
        name: options.preset.label,
        defaultModel: options.defaultModel,
        models: options.models.map(model => model.id),
        baseUrl,
        apiKey,
        wireApi: providerWireApi(options.preset, options.format),
        anthropicAuthMode: targetAgent === 'claude' ? options.anthropicAuthMode : undefined,
        isDefault: true,
      });
      const settings = this.deps.getSettings();
      settings.providerProfileByAgent[targetAgent] = profile.id;
      settings.configSources[targetAgent] = 'providerProfile';
      await this.deps.saveSettings();
      this.deps.refreshViews();
      new Notice(`${options.preset.label} 模型配置已保存到 ${getAgentDescriptor(targetAgent).shortName}。`);
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async setProfileDefault(profile: ProviderProfile): Promise<void> {
    try {
      this.deps.providerStore.setDefault(profile.agentId, profile.id);
      const settings = this.deps.getSettings();
      settings.providerProfileByAgent[profile.agentId] = profile.id;
      await this.deps.saveSettings();
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async deleteProfile(id: string): Promise<void> {
    const removed = this.deps.providerStore.remove(id);
    if (!removed) return;
    const settings = this.deps.getSettings();
    if (settings.providerProfileByAgent[removed.agentId] === id) {
      settings.providerProfileByAgent[removed.agentId] = this.deps.providerStore.find(removed.agentId)?.id ?? '';
      await this.deps.saveSettings();
    }
    if (this.editingProfileId === id) {
      this.editingProfileId = null;
    }
    this.display();
  }

  private renderProfileForm(section: HTMLElement, agentFilter?: AgentId): void {
    const editing = this.editingProfileId
      ? this.deps.providerStore.list().find(profile => profile.id === this.editingProfileId) ?? null
      : null;
    const form = section.createDiv({ cls: 'wesight-provider-form' });
    new Setting(form).setName(editing ? 'Edit profile' : 'Add profile').setHeading();
    const agent = form.createEl('select');
    for (const agentId of AGENT_IDS) {
      agent.createEl('option', { text: getAgentDescriptor(agentId).displayName, value: agentId });
    }
    agent.value = editing?.agentId ?? agentFilter ?? 'claude';
    agent.disabled = Boolean(agentFilter);

    const name = form.createEl('input', { attr: { placeholder: 'Profile name' } });
    name.value = editing?.name ?? '';
    const defaultModel = form.createEl('input', { attr: { placeholder: 'Default model' } });
    defaultModel.value = editing?.defaultModel || editing?.model || '';
    const baseUrl = form.createEl('input', { attr: { placeholder: 'Base URL' } });
    baseUrl.value = editing?.baseUrl ?? '';
    const wireApi = form.createEl('select');
    wireApi.createEl('option', { text: 'Chat completions', value: 'chat' });
    wireApi.createEl('option', { text: 'Responses API', value: 'responses' });
    wireApi.value = editing?.wireApi ?? 'chat';

    const models = form.createEl('textarea', { cls: 'full', attr: { placeholder: 'Models, one per line' } });
    models.rows = 4;
    models.value = (editing?.models ?? []).join('\n');
    const apiKey = form.createEl('input', { attr: { placeholder: 'API key', type: 'password' } });
    apiKey.addClass('full');
    initializeStoredSecretInput(apiKey, Boolean(editing?.apiKey));

    const load = form.createEl('button', { text: 'Load models' });
    load.onclick = () => {
      void this.loadProviderModels({
        agent,
        baseUrl,
        apiKey,
        existingApiKey: editing?.apiKey ?? '',
        models,
        defaultModel,
      });
    };

    const save = form.createEl('button', { text: editing ? 'Save profile' : 'Add profile' });
    save.onclick = () => void this.saveProfileForm({
      editing,
      agent,
      name,
      defaultModel,
      models,
      baseUrl,
      apiKey,
      wireApi,
    });

    if (editing) {
      const cancel = form.createEl('button', { text: 'Cancel edit' });
      cancel.onclick = () => {
        this.editingProfileId = null;
        this.display();
      };
    }
  }

  private async loadProviderModels(elements: {
    agent: HTMLSelectElement;
    baseUrl: HTMLInputElement;
    apiKey: HTMLInputElement;
    existingApiKey: string;
    models: HTMLTextAreaElement;
    defaultModel: HTMLInputElement;
  }): Promise<void> {
    try {
      const fetched = await fetchProviderModels({
        agentId: elements.agent.value as AgentId,
        baseUrl: elements.baseUrl.value,
        apiKey: resolveSecretInput(elements.apiKey.value, elements.existingApiKey),
      });
      elements.models.value = fetched.join('\n');
      if (!elements.defaultModel.value && fetched[0]) {
        elements.defaultModel.value = fetched[0];
      }
      new Notice(`Loaded ${fetched.length} model${fetched.length === 1 ? '' : 's'}.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async saveProfileForm(elements: {
    editing: ProviderProfile | null;
    agent: HTMLSelectElement;
    name: HTMLInputElement;
    defaultModel: HTMLInputElement;
    models: HTMLTextAreaElement;
    baseUrl: HTMLInputElement;
    apiKey: HTMLInputElement;
    wireApi: HTMLSelectElement;
  }): Promise<void> {
    try {
      const modelList = parseModelList(elements.models.value);
      const profile = this.deps.providerStore.save({
        agentId: elements.agent.value as AgentId,
        id: elements.editing?.id,
        name: elements.name.value,
        defaultModel: elements.defaultModel.value,
        models: modelList,
        baseUrl: elements.baseUrl.value,
        apiKey: resolveSecretInput(elements.apiKey.value, elements.editing?.apiKey ?? ''),
        wireApi: elements.wireApi.value as ProviderWireApi,
        isDefault: elements.editing?.isDefault,
      });
      const settings = this.deps.getSettings();
      if (elements.editing && elements.editing.agentId !== profile.agentId
        && settings.providerProfileByAgent[elements.editing.agentId] === profile.id) {
        settings.providerProfileByAgent[elements.editing.agentId] = this.deps.providerStore.find(elements.editing.agentId)?.id ?? '';
      }
      settings.providerProfileByAgent[profile.agentId] = profile.id;
      await this.deps.saveSettings();
      this.editingProfileId = null;
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private renderImportExport(section: HTMLElement): void {
    new Setting(section)
      .setName('Export profiles')
      .setDesc('Copies redacted provider profiles to the clipboard.')
      .addButton(button => {
        button.setButtonText('Copy redacted JSON').onClick(async () => {
          await navigator.clipboard.writeText(JSON.stringify(this.deps.providerStore.exportProfiles(), null, 2));
          new Notice('Redacted provider profiles copied.');
        });
      });

    let importText = '';
    new Setting(section)
      .setName('Import profiles')
      .setDesc('Paste profile JSON exported from WeSight. Redacted API keys import as empty values.')
      .addTextArea(text => {
        text.inputEl.rows = 5;
        text.setPlaceholder('[{"agentId":"codex","name":"OpenAI","defaultModel":"gpt-5.4"}]')
          .onChange(value => {
            importText = value;
          });
      });
    new Setting(section)
      .addButton(button => {
        button.setButtonText('Import JSON').onClick(() => {
          try {
            const parsed: unknown = JSON.parse(importText);
            const imported = this.deps.providerStore.importProfiles(parsed);
            new Notice(`Imported ${imported.length} provider profile${imported.length === 1 ? '' : 's'}.`);
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        });
      });
  }

  private renderEnvironment(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    new Setting(section).setName('Environment').setHeading();
    const settings = this.deps.getSettings();
    new Setting(section)
      .setName('Shared environment variables')
      .setDesc('Key=value lines inherited by agent subprocesses.')
      .addTextArea(text => {
        text.inputEl.rows = 6;
        text
          .setValue(settings.sharedEnvironmentVariables)
          .onChange(async value => {
            settings.sharedEnvironmentVariables = value;
            await this.deps.saveSettings();
          });
      });
    new Setting(section)
      .setName('System prompt')
      .setDesc('Optional instruction prepended to chat and inline edit turns.')
      .addTextArea(text => {
        text.inputEl.rows = 4;
        text
          .setValue(settings.systemPrompt)
          .onChange(async value => {
            settings.systemPrompt = value;
            await this.deps.saveSettings();
          });
      });
  }

  private renderPrivacy(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    new Setting(section).setName('Privacy & storage').setHeading();
    section.createEl('p', { text: `Vault conversations: ${this.app.vault.getName()}/.wesight/` });
    section.createEl('p', { text: `Global home: ${wesightHome()}` });
    section.createEl('p', { text: `Provider profiles: ${providersPath()}` });
    section.createEl('p', { text: 'Runtime executables: detected only; WeSight does not install or update them.' });
    section.createEl('p', { text: `Temporary runtime config: ${tmpDir()}` });
    section.createEl('p', { text: `Logs: ${logsDir()}` });
  }

  private renderDiagnostics(containerEl: HTMLElement, agentFilter?: AgentId): void {
    const section = containerEl.createDiv({ cls: 'wesight-settings-section' });
    new Setting(section).setName('Diagnostics').setHeading();
    const settings = this.deps.getSettings();
    for (const agentId of agentFilter ? [agentFilter] : AGENT_IDS) {
      const status = new RuntimeDiscovery({
        configuredPaths: settings.configuredPaths,
        configSources: settings.configSources,
      }).resolve(agentId, { withVersion: true });
      section.createEl('pre', {
        text: JSON.stringify({
          agent: agentId,
          found: status.found,
          source: status.source,
          binaryPath: status.binaryPath,
          version: status.version,
          localConfigFound: status.localConfigFound,
          configSource: status.configSource,
          localModel: settings.localModelByAgent[agentId],
        }, null, 2),
      });
    }
    new Setting(section)
      .addButton(button => button.setButtonText('Refresh').onClick(() => {
        invalidateRuntimeDiscoveryCache();
        this.display();
      }));
  }
}

function parseModelList(value: string): string[] {
  return [...new Set(value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean))];
}

function supportedProviderFormat(preset: ProviderPreset, preferred: ProviderApiFormat): ProviderApiFormat {
  if (preset.baseUrls[preferred]) {
    return preferred;
  }
  if (preset.baseUrls[preset.defaultApiFormat]) {
    return preset.defaultApiFormat;
  }
  return preset.baseUrls.anthropic ? 'anthropic' : 'openai';
}

function providerAgentForFormat(format: ProviderApiFormat): AgentId {
  return format === 'anthropic' ? 'claude' : 'codex';
}

function providerFormatForAgent(agentId: AgentId): ProviderApiFormat {
  return agentId === 'claude' ? 'anthropic' : 'openai';
}

function providerFormatLabel(format: ProviderApiFormat): string {
  return format === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容';
}

function providerWireApi(preset: ProviderPreset, format: ProviderApiFormat): ProviderWireApi {
  if (preset.key === 'openai' && format === 'openai') {
    return 'responses';
  }
  return 'chat';
}

function toModelItems(profile: ProviderProfile | null, preset: ProviderPreset): ProviderModelPreset[] {
  const ids = profile
    ? [...profile.models, ...preset.models.map(model => model.id)]
    : preset.models.map(model => model.id);
  const items = ids.map(id => {
    const presetModel = preset.models.find(model => model.id === id);
    return {
      id,
      name: presetModel?.name ?? modelNameFromId(id),
    };
  });
  const activeModel = profile?.defaultModel || profile?.model || '';
  if (activeModel && !items.some(item => item.id === activeModel)) {
    items.unshift({ id: activeModel, name: modelNameFromId(activeModel) });
  }
  return mergeModelItems(items);
}

function mergeModelItems(items: ProviderModelPreset[]): ProviderModelPreset[] {
  const seen = new Set<string>();
  const merged: ProviderModelPreset[] = [];
  for (const item of items) {
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      id,
      name: item.name.trim() || modelNameFromId(id),
    });
  }
  return merged;
}

function modelNameFromId(id: string): string {
  return id
    .split(/[/:_-]/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}
