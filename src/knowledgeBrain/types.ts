export type KnowledgeBrainState =
  | 'disabled'
  | 'installing'
  | 'needs-python'
  | 'needs-agent'
  | 'ready'
  | 'busy'
  | 'recovery-required'
  | 'unsupported'
  | 'error';

export type KnowledgeBrainAgentId = 'codex' | 'claude';

export type KnowledgeBrainAccessState =
  | 'checking'
  | 'eligible'
  | 'offline-grace'
  | 'login-required'
  | 'membership-required'
  | 'expired'
  | 'beta-paused'
  | 'unavailable';

export interface KnowledgeBrainAccessStatus {
  state: KnowledgeBrainAccessState;
  allowed: boolean;
  verifiedOnline: boolean;
  expiresAt: string | null;
  reason: string | null;
}

export interface KnowledgeBrainStatus {
  state: KnowledgeBrainState;
  access: KnowledgeBrainAccessStatus;
  pythonVersion: string | null;
  pythonPath: string | null;
  runtimeVersion: string | null;
  runtimePath: string | null;
  vaultAdopted: boolean;
  vaultPath: string | null;
  recoveryPending: boolean;
  availableAgents: Record<KnowledgeBrainAgentId, boolean>;
  doctorOk: boolean | null;
  retrieveCapability: 'verified' | 'degraded' | 'unavailable' | null;
  error: string | null;
}

export interface KnowledgeActionPreview {
  previewId: string;
  createdAt: number;
  newPages: { path: string; title: string }[];
  updatedPages: { path: string; title: string }[];
  archivedSources: { path: string; title: string }[];
  ledgerChanges: { source: number; claim: number };
  indexChanges: { hotCache: number; index: number; log: number };
  riskWarnings: string[];
}

export interface KnowledgeApplyResult {
  ok: boolean;
  changedPaths: string[];
  error: string | null;
}

export interface KnowledgeHealthFinding {
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  path: string;
  line: number | null;
  target: string | null;
  message: string;
}

export interface KnowledgeHealthReport {
  ok: boolean;
  pages: number;
  links: number;
  findings: KnowledgeHealthFinding[];
  summary: Record<string, number>;
  recoveryPending: boolean;
  error: string | null;
}

export interface SaveAnswerInput {
  conversationId: string;
  messageId: string;
  question: string;
  answer: string;
  agentId: KnowledgeBrainAgentId;
}

export interface KnowledgeQueryInput {
  conversationId: string;
  question: string;
  agentId: KnowledgeBrainAgentId;
  sessionId?: string;
}

export interface KnowledgeEnableResult {
  ok: boolean;
  status: KnowledgeBrainStatus;
  error: string | null;
}

export interface KnowledgeCollectResult {
  ok: boolean;
  preview: KnowledgeActionPreview | null;
  error: string | null;
}

export type KnowledgeRuntimeEventListener = (event: KnowledgeRuntimeEvent) => void;

export type KnowledgeRuntimeEvent =
  | { type: 'status'; state: KnowledgeBrainState; message?: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'citation'; path: string; kind: 'knowledge' | 'source'; line?: number }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'done' };

export interface KnowledgeBrainService {
  probe(): Promise<KnowledgeBrainStatus>;
  enable(): Promise<KnowledgeEnableResult>;
  planCollectCurrentNote(file: unknown, agentId: KnowledgeBrainAgentId): Promise<KnowledgeActionPreview>;
  query(input: KnowledgeQueryInput, onEvent: KnowledgeRuntimeEventListener): Promise<void>;
  planSaveAnswer(input: SaveAnswerInput): Promise<KnowledgeActionPreview>;
  applyPreview(previewId: string): Promise<KnowledgeApplyResult>;
  runHealthCheck(): Promise<KnowledgeHealthReport>;
  recover(): Promise<KnowledgeHealthReport>;
  discardPreview(previewId: string): Promise<void>;
  cleanup(): Promise<void>;
  cancel(): void;
}

export interface KnowledgeBrainEntitlementServiceContract {
  probe(forceRefresh?: boolean): Promise<KnowledgeBrainAccessStatus>;
  requireCoreAccess(): Promise<KnowledgeBrainAccessStatus>;
  clear(): void;
  onChange(listener: () => void): () => void;
}

export interface KnowledgeBrainSettings {
  /** Deprecated: state is derived from environment, not persisted. */
  enabled?: boolean;
}
