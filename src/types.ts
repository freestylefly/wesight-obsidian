import type { WeChatThemeId } from './wechat/themes';

export type AgentId = 'claude' | 'codex' | 'opencode';

export type RuntimeConfigSource = 'localCli' | 'providerProfile';

export type RuntimeAccessMode = 'read-only' | 'workspace-write';

export type ConversationMode = 'chat' | 'knowledge';

export type RuntimeBinarySource = 'configured' | 'desktopApp' | 'managed' | 'path';

export type AgentStatusState = 'ready' | 'missing' | 'unsupported';

export type ProviderWireApi = 'responses' | 'chat';

export type AnthropicAuthMode = 'apiKey' | 'authToken';

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  shortName: string;
  packageName: string;
  binaryName: string;
  bestFor: string;
  supportsImages: boolean;
  supportsInlineEdit: boolean;
  supportsProviderProfiles: boolean;
  docsUrl: string;
}

export interface AgentStatus {
  agentId: AgentId;
  descriptor: AgentDescriptor;
  state: AgentStatusState;
  found: boolean;
  binaryPath: string | null;
  source: RuntimeBinarySource | null;
  version: string | null;
  configuredPath: string;
  managedDir: string;
  configSource: RuntimeConfigSource;
  localConfigFound: boolean;
  error: string | null;
}

export interface ProviderProfile {
  id: string;
  agentId: AgentId;
  name: string;
  apiKey: string;
  baseUrl: string;
  /** Backward-compatible alias for `defaultModel`. */
  model: string;
  /** Default model used for runs. Always present in `models` when set. */
  defaultModel: string;
  /** All models available on this provider (fetched or hand-entered). */
  models: string[];
  /** Codex provider protocol. Defaults to chat for OpenAI-compatible endpoints. */
  wireApi: ProviderWireApi;
  /** Authentication header used by Claude Code for Anthropic-compatible endpoints. */
  anthropicAuthMode?: AnthropicAuthMode;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ExportedProviderProfile = Omit<ProviderProfile, 'apiKey'> & {
  apiKey?: string;
  apiKeyRedacted?: boolean;
};

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  agentId?: AgentId;
  metadata?: ChatMessageMetadata;
}

export interface ChatImageArtifact {
  id: string;
  type: 'image';
  vaultPath: string;
  mimeType: string;
  createdAt: number;
  revisedPrompt?: string;
}

export interface ChatInputImage {
  id: string;
  vaultPath: string;
  mimeType: string;
  fileName: string;
  createdAt: number;
  /** Content digest used to avoid adding the same image more than once. */
  contentHash?: string;
}

export type ChatArtifact = ChatImageArtifact;

export interface ChatMessageProcessItem {
  id: string;
  type: 'thinking' | 'tool';
  title: string;
  content?: string;
  status?: 'started' | 'completed' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  createdAt: number;
}

export interface ChatMessageMetadata extends Record<string, unknown> {
  artifacts?: ChatArtifact[];
  /** Images supplied by the user with this message. */
  inputImages?: ChatInputImage[];
  /** Total elapsed time of the assistant turn in milliseconds. */
  durationMs?: number;
  /** Intermediate reasoning and tool-call progress shown while streaming and collapsed after completion. */
  process?: ChatMessageProcessItem[];
  /** Whether the process log is collapsed for a completed assistant message. */
  processCollapsed?: boolean;
  /** Marks an answer rendered from the local knowledge brain. */
  knowledgeBased?: boolean;
  /** Host-validated knowledge pages and immutable source snapshots used by the answer. */
  knowledgeCitations?: Array<{
    path: string;
    kind: 'knowledge' | 'source';
    line?: number;
  }>;
  /** Marks a user-cancelled turn so it cannot be saved as a successful answer. */
  cancelled?: boolean;
  /** Applied knowledge transaction paths for an explicitly saved answer. */
  knowledgeSave?: {
    status: 'saved';
    changedPaths: string[];
    savedAt: number;
  };
}

export interface ToolCallEvent {
  id: string;
  name: string;
  status: 'started' | 'completed' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface FileAttachment {
  vaultPath: string;
  absolutePath: string;
  mimeType?: string;
}

export interface ChatTurnRequest {
  conversationId: string;
  agentId: AgentId;
  prompt: string;
  cwd: string;
  configSource: RuntimeConfigSource;
  providerProfileId?: string;
  /** Model override for localCli runs (for example a Claude alias such as "sonnet"). */
  model?: string;
  /** Runtime session to resume, captured from a previous turn's session event. */
  sessionId?: string;
  systemPrompt?: string;
  planMode?: boolean;
  attachments?: FileAttachment[];
  /** Runs generation without tools, project customizations, or session persistence. */
  textOnly?: boolean;
  /** Hard filesystem access boundary requested from the agent runtime. */
  accessMode?: RuntimeAccessMode;
  /** Suppresses prompt-adjacent runtime diagnostics for privacy-sensitive knowledge turns. */
  logPolicy?: 'standard' | 'metadata-only';
  /** Cancels only this runtime turn without stopping other active agents. */
  signal?: AbortSignal;
}

export type RuntimeTurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string; id?: string }
  | { type: 'tool'; toolCall: ToolCallEvent }
  | {
    type: 'artifact';
    artifact: {
      itemId: string;
      kind: 'image';
      sourcePath: string;
      mimeType?: string;
      revisedPrompt?: string;
    };
  }
  | {
    type: 'error';
    message: string;
    detail?: string;
    statusCode?: number;
    retryAfterSeconds?: number;
    requestId?: string;
    providerProfileId?: string;
    /** Diagnostic-only context that should not be rendered in chat. */
    diagnostic?: string;
  }
  | { type: 'done'; sessionId?: string | null };

export interface CodexModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  inputModalities: string[];
}

export interface CodexRuntimeStatus {
  state: 'idle' | 'connecting' | 'ready' | 'error';
  binaryPath: string | null;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  connected: boolean;
  authenticated: boolean | null;
  authMode: string | null;
  currentModelId: string | null;
  currentModel: CodexModelDescriptor | null;
  models: CodexModelDescriptor[];
  imageGeneration: boolean | null;
  webSearch: boolean | null;
  error: string | null;
}

export interface StoredConversation {
  id: string;
  title: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Missing on legacy conversations, which are read as ordinary chat. */
  mode?: ConversationMode;
  /** Last runtime session id per agent, used to resume multi-turn context. */
  sessionIds?: Partial<Record<AgentId, string>>;
  /** Session IDs isolated by chat mode. Legacy sessionIds belong to chat mode. */
  modeSessionIds?: Partial<Record<ConversationMode, Partial<Record<AgentId, string>>>>;
}

export type ConfigSourcesByAgent = Record<AgentId, RuntimeConfigSource>;
export type ConfiguredPathsByAgent = Record<AgentId, string>;
export type ProfileSelectionByAgent = Record<AgentId, string>;
export type LocalModelByAgent = Record<AgentId, string>;

export interface WeSightObsidianSettings {
  defaultAgentId: AgentId;
  /** Latest plugin version already announced in this vault. */
  lastNotifiedUpdateVersion?: string;
  configSources: ConfigSourcesByAgent;
  configuredPaths: ConfiguredPathsByAgent;
  providerProfileByAgent: ProfileSelectionByAgent;
  /** Model override per agent when running through the local CLI. Empty = CLI default. */
  localModelByAgent: LocalModelByAgent;
  sharedEnvironmentVariables: string;
  systemPrompt: string;
  planModeDefault: boolean;
  maxContextFileChars: number;
  /** Shared Feishu folder created in the current user's Drive root. */
  feishuFolderToken: string;
  /** Theme used by the WeChat preview and draft publisher. */
 wechatThemeId: WeChatThemeId;
 /** User-facing name of the reusable AI-generated WeChat theme. */
wechatCustomThemeName: string;
/** Style brief used to regenerate the reusable AI-generated WeChat theme. */
wechatCustomThemeDescription: string;
}

export const DEFAULT_CONFIG_SOURCES: ConfigSourcesByAgent = {
  claude: 'localCli',
  codex: 'localCli',
  opencode: 'localCli',
};

export const DEFAULT_CONFIGURED_PATHS: ConfiguredPathsByAgent = {
  claude: '',
  codex: '',
  opencode: '',
};

export const DEFAULT_PROFILE_SELECTION: ProfileSelectionByAgent = {
  claude: '',
  codex: '',
  opencode: '',
};

export const DEFAULT_LOCAL_MODELS: LocalModelByAgent = {
  claude: '',
  codex: '',
  opencode: '',
};

export const DEFAULT_SETTINGS: WeSightObsidianSettings = {
  defaultAgentId: 'claude',
  lastNotifiedUpdateVersion: '',
  configSources: DEFAULT_CONFIG_SOURCES,
  configuredPaths: DEFAULT_CONFIGURED_PATHS,
  providerProfileByAgent: DEFAULT_PROFILE_SELECTION,
  localModelByAgent: DEFAULT_LOCAL_MODELS,
  sharedEnvironmentVariables: '',
  systemPrompt: '',
  planModeDefault: false,
  maxContextFileChars: 40_000,
 feishuFolderToken: '',
  wechatThemeId: 'canghe-style-tes',
wechatCustomThemeName: '',
wechatCustomThemeDescription: '',
};
