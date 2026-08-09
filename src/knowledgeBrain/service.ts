import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import fsp from 'fs/promises';
import type { TFile } from 'obsidian';
import type {
  KnowledgeActionPreview,
  KnowledgeApplyResult,
  KnowledgeBrainAgentId,
  KnowledgeBrainEntitlementServiceContract,
  KnowledgeBrainService,
  KnowledgeBrainState,
  KnowledgeBrainStatus,
  KnowledgeEnableResult,
  KnowledgeHealthFinding,
  KnowledgeHealthReport,
  KnowledgeQueryInput,
  KnowledgeRuntimeEventListener,
  SaveAnswerInput,
} from './types';
import { CLAUDE_OBSIDIAN_MANIFEST } from './manifest';
import { detectPython } from './python';
import { installKnowledgeRuntime, readInstallRecord, runtimeInstallDir, type InstallRecord } from './installer';
import {
  commandAdoptApply,
  commandAdoptDryRun,
  commandContracts,
  commandDoctor,
  commandLint,
  commandTransactionApply,
  commandTransactionInspect,
  commandTransactionRecover,
  runRuntimeScript,
} from './cli';
import { runPlanningTurn, runQueryTurn } from './agent';
import {
  collectSystemPrompt,
  collectUserPrompt,
  loadCollectSkill,
  loadQuerySkill,
  loadSaveSkill,
  querySystemPrompt,
  queryUserPrompt,
  saveAnswerSystemPrompt,
  saveAnswerUserPrompt,
} from './prompts';
import {
  buildTransactionFromDraft,
  normalizeIngestRawSnapshot,
  parseKnowledgeDraft,
  type KnowledgeDraftV1,
} from './transactionBuilder';
import type { RuntimeManager } from '../runtime/runtimeManager';
import { appendLocalLog } from '../storage/localLog';
import { wesightHome } from '../paths';

interface ServiceDeps {
  getVaultPath: () => string | null;
  getMaxContextChars?: () => number;
  runtimeManager: RuntimeManager;
  entitlement: KnowledgeBrainEntitlementServiceContract;
}

interface PendingPreview {
  preview: KnowledgeActionPreview;
  bundlePath: string;
  approvalHash: string;
  vaultPath: string;
}

const FOUNDATION_PATHS = [
  'wiki/hot.md',
  'wiki/index.md',
  'wiki/overview.md',
  'wiki/log.md',
  'wiki/meta/ledgers/source-ledger.json',
  'wiki/meta/ledgers/claim-ledger.json',
];
const LINT_CATEGORIES = [
  'configuration_errors',
  'read_errors',
  'provenance_errors',
  'dead_links',
  'ambiguous_targets',
  'duplicate_basenames',
  'missing_frontmatter',
  'stale_index_entries',
  'orphans',
  'empty_sections',
] as const;

export class KnowledgeBrain extends EventEmitter implements KnowledgeBrainService {
  private state: KnowledgeBrainState = 'disabled';
  private pendingPreviews = new Map<string, PendingPreview>();
  private activeAbort: AbortController | null = null;
  private queryAborts = new Set<AbortController>();
  private mutationActive = false;
  private enablePromise: Promise<KnowledgeEnableResult> | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: ServiceDeps) {
    super();
  }

  private log(action: string, details: Record<string, unknown> = {}): void {
    appendLocalLog('knowledge_brain', { action, ...sanitizeKnowledgeLogDetails(details) });
  }

  private vaultPath(): string | null {
    return this.deps.getVaultPath();
  }

  private async currentInstallRecord(): Promise<InstallRecord | null> {
    const record = await readInstallRecord();
    if (!record) return null;
    if (
      record.id !== CLAUDE_OBSIDIAN_MANIFEST.id
      || record.version !== CLAUDE_OBSIDIAN_MANIFEST.version
      || record.commit !== CLAUDE_OBSIDIAN_MANIFEST.commit
      || record.sha256 !== CLAUDE_OBSIDIAN_MANIFEST.sha256
      || path.resolve(record.runtimePath) !== path.resolve(runtimeInstallDir(CLAUDE_OBSIDIAN_MANIFEST))
    ) return null;
    return record;
  }

  private async isRuntimeIntact(record: InstallRecord): Promise<boolean> {
    const required = [
      'claude_obsidian/__main__.py',
      'scripts/retrieve.py',
      'skills/wiki-ingest/SKILL.md',
      'skills/wiki-query/SKILL.md',
      'skills/save/SKILL.md',
    ];
    return (await Promise.all(required.map(relative => fsp.lstat(path.join(record.runtimePath, relative))
      .then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false)))).every(Boolean);
  }

  private async recoveryState(): Promise<{ pending: boolean; corrupt: boolean }> {
    return scanKnowledgeRecovery(this.vaultPath());
  }

  private agentAvailability(vault: string | null): Record<KnowledgeBrainAgentId, boolean> {
    const resolve = (agentId: KnowledgeBrainAgentId): boolean => this.deps.runtimeManager.resolveStatus({
      agentId,
      conversationId: 'knowledge-brain-probe',
      prompt: '',
      cwd: vault ?? process.cwd(),
      configSource: 'localCli',
    }).found;
    return { claude: resolve('claude'), codex: resolve('codex') };
  }

  private async isVaultAdopted(vault: string): Promise<boolean> {
    const required = [
      '.claude-obsidian.json',
      '.raw/.manifest.json',
      'wiki/hot.md',
      'wiki/index.md',
      'wiki/log.md',
      'wiki/meta/ledgers/source-ledger.json',
      'wiki/meta/ledgers/claim-ledger.json',
    ];
    return (await Promise.all(required.map(relative => fsp.lstat(path.join(vault, relative))
      .then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false)))).every(Boolean);
  }

  private async readiness(record: InstallRecord, vault: string, signal?: AbortSignal): Promise<{
    doctorOk: boolean;
    retrieveCapability: KnowledgeBrainStatus['retrieveCapability'];
  }> {
    const options = {
      pythonPath: record.pythonPath,
      runtimePath: record.runtimePath,
      vaultPath: vault,
      timeoutMs: 60_000,
      signal,
    };
    const [doctor, contracts] = await Promise.all([
      commandDoctor(options),
      commandContracts(options, 'wiki-retrieve', true),
    ]);
    const doctorParsed = asRecord(doctor.parsed);
    const contractParsed = asRecord(contracts.parsed);
    const capabilities = Array.isArray(contractParsed?.capabilities) ? contractParsed.capabilities : [];
    const capability: unknown = capabilities.find((item: unknown) => asRecord(item)?.id === 'wiki-retrieve');
    const capabilityRecord = asRecord(capability);
    const rawStatus = capabilityRecord?.status ?? capabilityRecord?.state;
    const status = typeof rawStatus === 'string' ? rawStatus : '';
    return {
      doctorOk: doctor.ok && doctorParsed?.ok === true,
      retrieveCapability: contracts.ok && contractParsed?.ok === true
        ? status === 'verified' ? 'verified' : 'degraded'
        : 'unavailable',
    };
  }

  async probe(): Promise<KnowledgeBrainStatus> {
    const access = await this.deps.entitlement.probe();
    const vault = this.vaultPath();
    const python = await detectPython(CLAUDE_OBSIDIAN_MANIFEST.minPythonVersion);
    const record = await this.currentInstallRecord();
    const runtimeIntact = record ? await this.isRuntimeIntact(record) : false;
    const vaultAdopted = Boolean(vault && runtimeIntact && await this.isVaultAdopted(vault));
    const recovery = await this.recoveryState();
    const availableAgents = this.agentAvailability(vault);
    let doctorOk: boolean | null = null;
    let retrieveCapability: KnowledgeBrainStatus['retrieveCapability'] = null;
    if (record && vault && runtimeIntact && vaultAdopted) {
      const result = await this.readiness(record, vault);
      doctorOk = result.doctorOk;
      retrieveCapability = result.retrieveCapability;
    }
    let state: KnowledgeBrainState;
    if (process.platform !== 'darwin') state = 'unsupported';
    else if (this.state === 'installing' || this.state === 'busy') state = this.state;
    else if (!record || !runtimeIntact || !vaultAdopted) state = 'disabled';
    else if (!python.ok) state = 'needs-python';
    else if (recovery.pending) state = 'recovery-required';
    else if (!availableAgents.claude && !availableAgents.codex) state = 'needs-agent';
    else if (doctorOk !== true) state = 'error';
    else state = 'ready';
    this.state = state;
    return {
      state,
      access,
      pythonVersion: python.version,
      pythonPath: python.path,
      runtimeVersion: record?.version ?? null,
      runtimePath: record?.runtimePath ?? null,
      vaultAdopted,
      vaultPath: vault,
      recoveryPending: recovery.pending,
      availableAgents,
      doctorOk,
      retrieveCapability,
      error: recovery.corrupt ? '检测到损坏或未知状态的事务日志。' : this.lastError,
    };
  }

  async enable(): Promise<KnowledgeEnableResult> {
    if (this.enablePromise) return this.enablePromise;
    this.enablePromise = this.performEnable().finally(() => { this.enablePromise = null; });
    return this.enablePromise;
  }

  private async performEnable(): Promise<KnowledgeEnableResult> {
    try {
      await this.deps.entitlement.requireCoreAccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : '知识大脑会员权益不可用。';
      return { ok: false, status: await this.probe(), error: message };
    }
    if (this.mutationActive) return { ok: false, status: await this.probe(), error: '知识大脑正在执行其他写入操作。' };
    this.mutationActive = true;
    this.state = 'installing';
    this.lastError = null;
    this.activeAbort = new AbortController();
    const startedAt = Date.now();
    try {
      if (process.platform !== 'darwin') return this.enableFailure('首版仅支持 macOS。', 'unsupported');
      this.emitStatus('正在检查 Python…');
      const python = await detectPython(CLAUDE_OBSIDIAN_MANIFEST.minPythonVersion);
      if (!python.ok || !python.path || !python.version) return this.enableFailure(python.hint ?? '需要 Python 3.11+。', 'needs-python');
      const vault = this.vaultPath();
      if (!vault) return this.enableFailure('无法获取当前 Vault 路径。', 'vault-unavailable');
      this.emitStatus('正在安装知识大脑运行包…');
      const install = await installKnowledgeRuntime(
        python.path,
        python.version,
        CLAUDE_OBSIDIAN_MANIFEST,
        message => this.emitStatus(message),
        this.activeAbort.signal,
      );
      if (!install.ok || !install.record) return this.enableFailure(install.error ?? '运行包安装失败。', 'install');
      this.emitStatus('正在演练 Vault 接入…');
      const options = {
        pythonPath: install.record.pythonPath,
        runtimePath: install.record.runtimePath,
        vaultPath: vault,
        timeoutMs: 300_000,
        signal: this.activeAbort.signal,
      };
      const dryRun = await commandAdoptDryRun(options);
      if (!dryRun.ok) return this.enableFailure(dryRun.error ?? 'Vault 接入演练失败。', errorCode(dryRun.error));
      const plan = asRecord(dryRun.parsed) ?? {};
      if (plan.status !== 'noop') {
        const approvalHash = typeof plan.approved_plan_sha256 === 'string' ? plan.approved_plan_sha256 : null;
        const generatedAt = typeof plan.generated_at === 'string' ? plan.generated_at : null;
        const operationId = typeof asRecord(plan.operation)?.operation_id === 'string'
          ? String(asRecord(plan.operation)?.operation_id)
          : null;
        if (!approvalHash || !generatedAt || !operationId) return this.enableFailure('接入演练缺少固定校验参数。', 'invalid-adopt-plan');
        this.emitStatus('正在应用 Vault 接入…');
        await this.deps.entitlement.requireCoreAccess();
        const apply = await commandAdoptApply(options, approvalHash, generatedAt, operationId);
        if (!apply.ok) return this.enableFailure(apply.error ?? 'Vault 接入失败。', errorCode(apply.error));
      }
      this.emitStatus('正在运行健康与能力检查…');
      const readiness = await this.readiness(install.record, vault, this.activeAbort.signal);
      if (!readiness.doctorOk) return this.enableFailure('doctor 检查未通过。', 'doctor');
      this.state = 'ready';
      this.log('enable_success', { durationMs: Date.now() - startedAt, runtimeVersion: install.record.version });
      return { ok: true, status: await this.probe(), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.enableFailure(message, errorCode(message));
    } finally {
      this.activeAbort = null;
      this.mutationActive = false;
    }
  }

  private async enableFailure(message: string, code: string): Promise<KnowledgeEnableResult> {
    this.lastError = message;
    this.state = code === 'needs-python' ? 'needs-python' : code === 'unsupported' ? 'unsupported' : 'error';
    this.log('enable_failed', { errorCode: code });
    const status = await this.probe();
    status.state = this.state;
    status.error = message;
    return { ok: false, status, error: message };
  }

  private emitStatus(message: string): void {
    this.emit('status', { state: this.state, message });
  }

  async runHealthCheck(): Promise<KnowledgeHealthReport> {
    if (this.mutationActive) return emptyHealth('知识大脑正在执行写入操作，请稍后检查。', (await this.recoveryState()).pending);
    const previous = this.state;
    let environmentReady = false;
    this.mutationActive = true;
    this.state = 'busy';
    try {
      const record = await this.currentInstallRecord();
      const vault = this.vaultPath();
      if (!record || !vault || !(await this.isRuntimeIntact(record))) {
        return emptyHealth('知识大脑未就绪。', (await this.recoveryState()).pending);
      }
      environmentReady = true;
      const result = await commandLint({ pythonPath: record.pythonPath, runtimePath: record.runtimePath, vaultPath: vault, timeoutMs: 300_000 });
      const recoveryPending = (await this.recoveryState()).pending;
      const report = parseKnowledgeHealthReport(result.parsed, result.ok, result.error, recoveryPending);
      this.log('health_check', { pages: report.pages, links: report.links, issues: report.findings.length, ok: report.ok });
      return report;
    } finally {
      this.mutationActive = false;
      this.state = environmentReady ? 'ready' : previous;
    }
  }

  async recover(): Promise<KnowledgeHealthReport> {
    if (this.mutationActive) return emptyHealth('知识大脑正在执行其他写入操作。', true);
    const previous = this.state;
    let failure: KnowledgeHealthReport | null = null;
    let environmentReady = false;
    this.mutationActive = true;
    this.state = 'busy';
    this.activeAbort = new AbortController();
    try {
      const recovery = await this.recoveryState();
      const record = await this.currentInstallRecord();
      const vault = this.vaultPath();
      if (!record || !vault) {
        failure = emptyHealth('知识大脑未就绪，无法恢复。', recovery.pending);
      } else {
        environmentReady = true;
        if (recovery.pending) {
          const result = await commandTransactionRecover({
            pythonPath: record.pythonPath,
            runtimePath: record.runtimePath,
            vaultPath: vault,
            timeoutMs: 120_000,
            signal: this.activeAbort.signal,
          });
          this.log('recovery', { ok: result.ok, errorCode: result.ok ? null : errorCode(result.error) });
          if (!result.ok) failure = emptyHealth(result.error ?? '事务恢复失败。', true);
        }
      }
    } finally {
      this.mutationActive = false;
      this.activeAbort = null;
      this.state = environmentReady ? 'ready' : previous;
    }
    if (failure) return failure;
    return this.runHealthCheck();
  }

  async planCollectCurrentNote(file: unknown, agentId: KnowledgeBrainAgentId): Promise<KnowledgeActionPreview> {
    this.assertAgent(agentId);
    const tfile = file as TFile | undefined;
    if (!tfile || tfile.extension !== 'md') throw new Error('仅支持 Markdown 笔记。');
    return this.withPlanning(async (record, vault, signal) => {
      const sourcePath = await resolveReadableVaultFile(vault, tfile.path);
      const noteContent = await fsp.readFile(sourcePath, 'utf8');
      const maxChars = this.deps.getMaxContextChars?.() ?? 200_000;
      if (noteContent.length > maxChars) throw new Error(`当前笔记超过 ${maxChars.toLocaleString()} 字符上下文上限，请拆分后收录。`);
      const sourceSha256 = crypto.createHash('sha256').update(noteContent).digest('hex');
      const safeName = path.basename(tfile.path, '.md').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'note';
      const rawSnapshotPath = `.raw/captured/${sourceSha256.slice(0, 16)}-${safeName}.md`;
      const sourceId = stableFileSourceId(rawSnapshotPath, sourceSha256);
      const ingestedDate = new Date().toISOString().slice(0, 10);
      const refreshDate = new Date(`${ingestedDate}T00:00:00Z`);
      refreshDate.setUTCFullYear(refreshDate.getUTCFullYear() + 1);
      const refreshDue = refreshDate.toISOString().slice(0, 10);
      const existingSnapshot = await fsp.readFile(path.join(vault, rawSnapshotPath), 'utf8').catch(() => null);
      if (existingSnapshot !== null && existingSnapshot !== noteContent) throw new Error('同一来源哈希对应的原始资料快照已被修改，请先运行健康检查。');
      const context = await this.loadKnowledgeContext(vault);
      const skill = await loadCollectSkill(record.runtimePath);
      const systemPrompt = collectSystemPrompt(skill);
      const prompt = collectUserPrompt({
        vaultPath: vault,
        notePath: tfile.path,
        noteContent,
        sourceSha256,
        sourceId,
        rawSnapshotPath,
        sourceTitle: path.basename(tfile.path, '.md'),
        ingestedDate,
        refreshDue,
        knowledgeContext: context,
      });
      const preview = await this.planWithRetry(record, vault, agentId, 'ingest', systemPrompt, prompt, signal, draft => {
        normalizeIngestRawSnapshot(draft, rawSnapshotPath, noteContent, existingSnapshot !== null, sourceSha256);
      });
      this.log('collect_planned', { writes: preview.newPages.length + preview.updatedPages.length, sourceBytes: Buffer.byteLength(noteContent) });
      return preview;
    });
  }

  async query(input: KnowledgeQueryInput, onEvent: KnowledgeRuntimeEventListener): Promise<void> {
    this.assertAgent(input.agentId);
    try {
      await this.deps.entitlement.requireCoreAccess();
    } catch (error) {
      onEvent({ type: 'error', message: error instanceof Error ? error.message : '知识大脑会员权益不可用。' });
      onEvent({ type: 'done' });
      return;
    }
    if (!input.question.trim()) {
      onEvent({ type: 'error', message: '问题为空。' });
      onEvent({ type: 'done' });
      return;
    }
    const inputLimit = Math.min(this.deps.getMaxContextChars?.() ?? 200_000, 8_000);
    if (input.question.length > inputLimit) {
      onEvent({ type: 'error', message: `问题超过 ${inputLimit.toLocaleString()} 字符上下文上限。` });
      onEvent({ type: 'done' });
      return;
    }
    const record = await this.currentInstallRecord();
    const vault = this.vaultPath();
    if (!record || !vault || !(await this.isRuntimeIntact(record))) {
      onEvent({ type: 'error', message: '知识大脑未就绪。' });
      onEvent({ type: 'done' });
      return;
    }
    const recovery = await this.recoveryState();
    if (recovery.pending) {
      onEvent({ type: 'error', message: '存在未恢复事务，请先完成恢复。' });
      onEvent({ type: 'done' });
      return;
    }
    const queryAbort = new AbortController();
    this.queryAborts.add(queryAbort);
    const startedAt = Date.now();
    try {
      const skill = await loadQuerySkill(record.runtimePath);
      const evidence = await this.retrieveEvidence(record, vault, input.question);
      onEvent({ type: 'status', state: 'busy', message: `检索方式：${evidence.mode}` });
      const chunks: string[] = [];
      let runtimeError: string | null = null;
      await runQueryTurn(this.deps.runtimeManager, {
        agentId: input.agentId,
        conversationId: `kb:${input.conversationId}`,
        systemPrompt: querySystemPrompt(skill),
        prompt: queryUserPrompt(input.question, evidence.text, evidence.mode),
        cwd: vault,
        sessionId: input.sessionId,
        signal: queryAbort.signal,
      }, event => {
        if (event.type === 'session') onEvent({ type: 'session', sessionId: event.sessionId });
        else if (event.type === 'text') chunks.push(event.content);
        else if (event.type === 'error') runtimeError = event.message;
      });
      if (queryAbort.signal.aborted) onEvent({ type: 'error', message: '知识库查询已取消。' });
      else if (runtimeError) onEvent({ type: 'error', message: runtimeError });
      else {
        const answer = normalizeKnowledgeCitationLinks(chunks.join('').trim());
        const citations = await this.validateCitations(vault, answer);
        if (!citations.ok) onEvent({ type: 'error', message: citations.error ?? '知识库引用校验失败。' });
        else {
          onEvent({ type: 'text', content: answer });
          const expandedCitations = await expandKnowledgeCitationPaths(vault, citations.paths);
          for (const citation of expandedCitations) onEvent({ type: 'citation', ...citation });
        }
      }
      this.log('query', { durationMs: Date.now() - startedAt, inputChars: input.question.length });
    } catch (error) {
      onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.queryAborts.delete(queryAbort);
      onEvent({ type: 'done' });
    }
  }

  async planSaveAnswer(input: SaveAnswerInput): Promise<KnowledgeActionPreview> {
    this.assertAgent(input.agentId);
    if (!input.question.trim() || !input.answer.trim()) throw new Error('问题或回答为空，无法保存。');
    const inputLimit = this.deps.getMaxContextChars?.() ?? 200_000;
    if (input.question.length + input.answer.length > inputLimit) {
      throw new Error(`所选问题与回答超过 ${inputLimit.toLocaleString()} 字符上下文上限。`);
    }
    return this.withPlanning(async (record, vault, signal) => {
      const context = await this.loadKnowledgeContext(vault);
      const skill = await loadSaveSkill(record.runtimePath);
      const preview = await this.planWithRetry(
        record,
        vault,
        input.agentId,
        'save',
        saveAnswerSystemPrompt(skill),
        saveAnswerUserPrompt(input.question, input.answer, context),
        signal,
      );
      this.log('save_answer_planned', { writes: preview.newPages.length + preview.updatedPages.length, answerChars: input.answer.length });
      return preview;
    });
  }

  private async withPlanning<T>(work: (record: InstallRecord, vault: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.deps.entitlement.requireCoreAccess();
    if (this.mutationActive) throw new Error('知识大脑正在执行其他写入操作。');
    const previous = this.state;
    let environmentReady = false;
    this.mutationActive = true;
    this.state = 'busy';
    this.activeAbort = new AbortController();
    try {
      const record = await this.currentInstallRecord();
      const vault = this.vaultPath();
      if (!record || !vault || !(await this.isRuntimeIntact(record)) || !(await this.isVaultAdopted(vault))) throw new Error('知识大脑未就绪。');
      if ((await this.recoveryState()).pending) throw new Error('存在未恢复事务，请先运行恢复操作。');
      environmentReady = true;
      return await work(record, vault, this.activeAbort.signal);
    } finally {
      this.activeAbort = null;
      this.mutationActive = false;
      this.state = environmentReady ? 'ready' : previous;
    }
  }

  private async planWithRetry(
    record: InstallRecord,
    vault: string,
    agentId: KnowledgeBrainAgentId,
    operationType: 'ingest' | 'save',
    systemPrompt: string,
    prompt: string,
    signal: AbortSignal,
    normalize?: (draft: KnowledgeDraftV1) => void,
  ): Promise<KnowledgeActionPreview> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const validationDetail = lastError instanceof Error ? lastError.message.slice(0, 8_000) : 'unknown validation error';
        const retryPrompt = attempt === 0
          ? prompt
          : `${prompt}\n\nPrevious draft failed host validation:\n${validationDetail}\nReturn one corrected bounded draft and preserve the exact requested scope.`;
        const result = await runPlanningTurn(this.deps.runtimeManager, agentId, systemPrompt, retryPrompt, vault, signal);
        const draft = parseKnowledgeDraft(result.text, operationType);
        normalize?.(draft);
        return await this.createPreview(record, vault, draft, signal);
      } catch (error) {
        if (signal.aborted) throw new Error('知识大脑操作已取消。');
        if (error instanceof Error && error.message.includes('Agent 规划超过 3 分钟')) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Agent 草稿校验失败。');
  }

  private async createPreview(record: InstallRecord, vault: string, draft: KnowledgeDraftV1, signal: AbortSignal): Promise<KnowledgeActionPreview> {
    const { bundlePath } = await buildTransactionFromDraft(vault, draft);
    try {
      const inspect = await commandTransactionInspect({
        pythonPath: record.pythonPath,
        runtimePath: record.runtimePath,
        vaultPath: vault,
        timeoutMs: 60_000,
        signal,
      }, bundlePath);
      if (!inspect.ok) throw new Error(inspect.error ?? '事务检查失败。');
      const plan = asRecord(inspect.parsed) ?? {};
      const approvalHash = typeof plan.approval_sha256 === 'string' ? plan.approval_sha256 : null;
      if (!approvalHash) throw new Error('事务检查未返回校验哈希。');
      const changedPaths = Array.isArray(plan.changed_paths) ? plan.changed_paths.filter((item): item is string => typeof item === 'string') : [];
      const writeModes = new Map(draft.writes.map(write => [write.path, write.mode]));
      const page = (relative: string) => ({ path: relative, title: extractTitle(draft.writes.find(write => write.path === relative)?.content ?? relative) });
      const isKnowledgePage = (relative: string) => relative.startsWith('wiki/') && !relative.startsWith('wiki/meta/') && !['wiki/hot.md', 'wiki/index.md', 'wiki/log.md', 'wiki/overview.md'].includes(relative);
      const previewId = `${draft.operationType}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const sourceLedgerChanges = await countLedgerEntryChanges(vault, draft, 'wiki/meta/ledgers/source-ledger.json', 'sources');
      const claimLedgerChanges = await countLedgerEntryChanges(vault, draft, 'wiki/meta/ledgers/claim-ledger.json', 'claims');
      const preview: KnowledgeActionPreview = {
        previewId,
        createdAt: Date.now(),
        newPages: changedPaths.filter(relative => writeModes.get(relative) === 'create' && isKnowledgePage(relative)).map(page),
        updatedPages: changedPaths.filter(relative => writeModes.get(relative) === 'replace' && isKnowledgePage(relative)).map(page),
        archivedSources: changedPaths.filter(relative => relative.startsWith('.raw/')).map(relative => ({ path: relative, title: path.basename(relative) })),
        ledgerChanges: {
          source: sourceLedgerChanges,
          claim: claimLedgerChanges,
        },
        indexChanges: {
          hotCache: changedPaths.includes('wiki/hot.md') ? 1 : 0,
          index: changedPaths.includes('wiki/index.md') ? 1 : 0,
          log: changedPaths.includes('wiki/log.md') ? 1 : 0,
        },
        riskWarnings: [
          ...(draft.riskWarnings ?? []),
          ...changedPaths.filter(relative => writeModes.get(relative) === 'replace' && isKnowledgePage(relative)).map(relative => `将更新已有知识页：${relative}`),
        ],
      };
      this.pendingPreviews.set(previewId, { preview, bundlePath, approvalHash, vaultPath: vault });
      return preview;
    } catch (error) {
      await fsp.unlink(bundlePath).catch(() => undefined);
      throw error;
    }
  }

  async applyPreview(previewId: string): Promise<KnowledgeApplyResult> {
    const pending = this.pendingPreviews.get(previewId);
    if (!pending) return { ok: false, changedPaths: [], error: '预览已过期或不存在。' };
    try {
      await this.deps.entitlement.requireCoreAccess();
    } catch (error) {
      await this.discardPreview(previewId);
      return {
        ok: false,
        changedPaths: [],
        error: error instanceof Error ? error.message : '知识大脑会员权益不可用。',
      };
    }
    if (this.mutationActive) return { ok: false, changedPaths: [], error: '知识大脑正在执行其他写入操作。' };
    const previous = this.state;
    let environmentReady = false;
    this.mutationActive = true;
    this.state = 'busy';
    this.activeAbort = new AbortController();
    try {
      const record = await this.currentInstallRecord();
      const vault = this.vaultPath();
      if (!record || !vault) return { ok: false, changedPaths: [], error: '知识大脑未就绪。' };
      if (path.resolve(vault) !== path.resolve(pending.vaultPath)) {
        return { ok: false, changedPaths: [], error: '当前 Vault 已切换，请重新生成预览。' };
      }
      if ((await this.recoveryState()).pending) return { ok: false, changedPaths: [], error: '存在未恢复事务，请先完成恢复。' };
      environmentReady = true;
      const options = {
        pythonPath: record.pythonPath,
        runtimePath: record.runtimePath,
        vaultPath: vault,
        timeoutMs: 120_000,
        signal: this.activeAbort.signal,
      };
      const inspect = await commandTransactionInspect(options, pending.bundlePath);
      const actualHash = typeof asRecord(inspect.parsed)?.approval_sha256 === 'string' ? String(asRecord(inspect.parsed)?.approval_sha256) : null;
      if (!inspect.ok || actualHash !== pending.approvalHash) return { ok: false, changedPaths: [], error: 'Vault 或事务在预览后发生变化，请重新生成预览。' };
      try {
        await this.deps.entitlement.requireCoreAccess();
      } catch (error) {
        return {
          ok: false,
          changedPaths: [],
          error: error instanceof Error ? error.message : '知识大脑会员权益不可用。',
        };
      }
      const apply = await commandTransactionApply(options, pending.bundlePath, pending.approvalHash);
      if (!apply.ok) return { ok: false, changedPaths: [], error: apply.error ?? '事务应用失败。' };
      const changedPaths = Array.isArray(asRecord(apply.parsed)?.changed_paths)
        ? (asRecord(apply.parsed)?.changed_paths as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      this.log('preview_applied', { changedCount: changedPaths.length });
      return { ok: true, changedPaths, error: null };
    } finally {
      await this.discardPreview(previewId);
      this.mutationActive = false;
      this.activeAbort = null;
      this.state = environmentReady ? 'ready' : previous;
    }
  }

  async discardPreview(previewId: string): Promise<void> {
    const pending = this.pendingPreviews.get(previewId);
    this.pendingPreviews.delete(previewId);
    if (pending) await fsp.unlink(pending.bundlePath).catch(() => undefined);
  }

  async cleanup(): Promise<void> {
    for (const previewId of [...this.pendingPreviews.keys()]) await this.discardPreview(previewId);
    const transactionDir = path.join(wesightHome(), 'tmp', 'knowledge-brain', 'transactions');
    await fsp.rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
    const tempRoot = path.join(wesightHome(), 'tmp', 'knowledge-brain');
    const entries = await fsp.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('download-claude-obsidian-')) {
        await fsp.rm(path.join(tempRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  cancel(): void {
    this.activeAbort?.abort();
    for (const controller of this.queryAborts) controller.abort();
    this.queryAborts.clear();
  }

  private async loadKnowledgeContext(vault: string): Promise<string> {
    const sections: string[] = [];
    let used = 0;
    const limit = Math.max(50_000, this.deps.getMaxContextChars?.() ?? 200_000);
    for (const relative of FOUNDATION_PATHS) {
      const content = await fsp.readFile(path.join(vault, relative), 'utf8').catch(() => '');
      if (!content) continue;
      if (used + content.length > limit) throw new Error('知识库基础上下文超过配置上限，请先运行健康检查并精简索引。');
      sections.push(`FILE ${relative}\n${content}`);
      used += content.length;
    }
    return sections.join('\n\n');
  }

  private async retrieveEvidence(record: InstallRecord, vault: string, question: string): Promise<{ mode: string; text: string }> {
    const options = { pythonPath: record.pythonPath, runtimePath: record.runtimePath, vaultPath: vault, timeoutMs: 60_000 };
    const capability = await commandContracts(options, 'wiki-retrieve', true);
    if (capability.ok && asRecord(capability.parsed)?.ok === true) {
      const retrieved = await runRuntimeScript(options, 'scripts/retrieve.py', [
        '--vault', vault, '--top', '5', '--no-rerank', '--explain', '--', question,
      ]);
      if (retrieved.ok && retrieved.stdout.trim()) {
        const sanitized = sanitizeRetrievedEvidence(retrieved.parsed);
        if (sanitized) return { mode: 'verified BM25', text: sanitized };
      }
    }
    const localMatches = await searchKnowledgePages(vault, question, 5);
    const foundation = await this.loadKnowledgeContext(vault);
    return {
      mode: 'index + local read-only search',
      text: [foundation, ...localMatches.map(match => `FILE ${match.path}\n${match.content}`)].join('\n\n').slice(0, 500_000),
    };
  }

  private async validateCitations(vault: string, answer: string): Promise<{ ok: boolean; paths: string[]; error: string | null }> {
    return validateKnowledgeCitations(vault, answer);
  }

  private assertAgent(agentId: string): asserts agentId is KnowledgeBrainAgentId {
    if (agentId !== 'claude' && agentId !== 'codex') throw new Error('知识大脑首版仅支持 Claude Code 与 Codex。');
  }
}

function stableFileSourceId(locator: string, contentSha256: string): string {
  const identity = `file\0${locator}\0${contentSha256}`;
  return `src-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

export async function scanKnowledgeRecovery(vault: string | null): Promise<{ pending: boolean; corrupt: boolean }> {
  if (!vault) return { pending: false, corrupt: false };
  const directory = path.join(vault, '.vault-meta', 'transactions');
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { pending: false, corrupt: false }
      : { pending: true, corrupt: true };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const journalPath = path.join(directory, entry.name, 'journal.json');
    try {
      const stat = await fsp.lstat(journalPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return { pending: true, corrupt: true };
      const journal = JSON.parse(await fsp.readFile(journalPath, 'utf8')) as { state?: unknown };
      if (['prepared', 'applying', 'rollback-failed'].includes(String(journal.state))) {
        return { pending: true, corrupt: false };
      }
      if (!['complete', 'rolled-back'].includes(String(journal.state))) return { pending: true, corrupt: true };
    } catch {
      return { pending: true, corrupt: true };
    }
  }
  return { pending: false, corrupt: false };
}

const KNOWLEDGE_LOG_NUMBER_KEYS = new Set([
  'durationMs',
  'writes',
  'sourceBytes',
  'inputChars',
  'answerChars',
  'changedCount',
  'pages',
  'links',
  'issues',
]);

export function sanitizeKnowledgeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (KNOWLEDGE_LOG_NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (key === 'ok' && typeof value === 'boolean') output[key] = value;
    else if (key === 'runtimeVersion' && typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) output[key] = value;
    else if (key === 'errorCode' && (value === null || (typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value)))) output[key] = value;
  }
  return output;
}

export async function validateKnowledgeCitations(
  vault: string,
  answer: string,
): Promise<{ ok: boolean; paths: string[]; error: string | null }> {
  const matches = [...answer.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(match => match[1].trim());
  if (matches.length === 0) {
    const gap = /缺少|不足|无法|没有足够|no sufficient|insufficient/i.test(answer);
    return gap ? { ok: true, paths: [], error: null } : { ok: false, paths: [], error: '回答缺少可验证的知识库引用。' };
  }
  const pages = await listMarkdownFiles(path.join(vault, 'wiki'));
  const byName = new Map<string, string | null>();
  const addTarget = (key: string, relative: string): void => {
    const current = byName.get(key);
    if (current && current !== relative) byName.set(key, null);
    else if (current === undefined) byName.set(key, relative);
  };
  for (const full of pages) {
    const relative = path.relative(vault, full).split(path.sep).join('/');
    addTarget(path.basename(relative, '.md').toLowerCase(), relative);
    addTarget(relative.replace(/\.md$/i, '').toLowerCase(), relative);
    addTarget(relative.replace(/^wiki\//, '').replace(/\.md$/i, '').toLowerCase(), relative);
  }
  const resolved: string[] = [];
  for (const citation of matches) {
    const rawTarget = canonicalRawCitationTarget(citation);
    if (rawTarget) {
      if (!(await isSafeRawSnapshot(vault, rawTarget))) {
        return { ok: false, paths: [], error: `引用目标不存在：[[${citation}]]` };
      }
      if (!resolved.includes(rawTarget)) resolved.push(rawTarget);
      continue;
    }
    const target = byName.get(citation.replace(/\.md$/i, '').toLowerCase());
    if (target === undefined) return { ok: false, paths: [], error: `引用目标不存在：[[${citation}]]` };
    if (target === null) return { ok: false, paths: [], error: `引用目标不明确：[[${citation}]]` };
    if (!resolved.includes(target)) resolved.push(target);
  }
  return { ok: true, paths: resolved, error: null };
}

export function normalizeKnowledgeCitationLinks(answer: string): string {
  return answer.replace(
    /\[\[([^\]|#]+)((?:#[^\]|]+)?(?:\|[^\]]+)?)\]\]/g,
    (full, target: string, suffix: string) => {
      const canonical = canonicalRawCitationTarget(target);
      return canonical ? `[[${canonical}${suffix}]]` : full;
    },
  );
}

export async function expandKnowledgeCitationPaths(
  vault: string,
  citedPaths: string[],
): Promise<Array<{ path: string; kind: 'knowledge' | 'source' }>> {
  const expanded: Array<{ path: string; kind: 'knowledge' | 'source' }> = [];
  const add = (citationPath: string, kind: 'knowledge' | 'source'): void => {
    if (!expanded.some(item => item.path === citationPath)) expanded.push({ path: citationPath, kind });
  };
  for (const citedPath of citedPaths) {
    if (!citedPath.startsWith('.raw/captured/')) add(citedPath, 'knowledge');
  }

  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = asRecord(JSON.parse(await fsp.readFile(path.join(vault, '.raw', '.manifest.json'), 'utf8')));
  } catch {
    for (const citedPath of citedPaths.filter(item => item.startsWith('.raw/captured/'))) add(citedPath, 'source');
    return expanded;
  }
  const sources = asRecord(manifest?.sources);
  if (!sources) {
    for (const citedPath of citedPaths.filter(item => item.startsWith('.raw/captured/'))) add(citedPath, 'source');
    return expanded;
  }
  for (const [sourcePath, rawEntry] of Object.entries(sources)) {
    if (!canonicalRawCitationTarget(sourcePath) || !(await isSafeRawSnapshot(vault, sourcePath))) continue;
    const entry = asRecord(rawEntry);
    const pages = Array.isArray(entry?.pages_created)
      ? entry.pages_created.filter((item): item is string => typeof item === 'string')
      : [];
    if (!pages.some(page => citedPaths.includes(page)) && !citedPaths.includes(sourcePath)) continue;
    const expectedHash = typeof entry?.hash === 'string' ? entry.hash : '';
    const originalPath = await findVisibleOriginalSource(vault, sourcePath, expectedHash);
    add(originalPath ?? sourcePath, 'source');
  }
  for (const citedPath of citedPaths.filter(item => item.startsWith('.raw/captured/'))) {
    if (!expanded.some(item => item.kind === 'source')) add(citedPath, 'source');
  }
  return expanded;
}

async function findVisibleOriginalSource(
  vault: string,
  snapshotPath: string,
  expectedHash: string,
): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return null;
  let snapshotSize: number;
  try {
    snapshotSize = (await fsp.stat(path.join(vault, ...snapshotPath.split('/')))).size;
  } catch {
    return null;
  }
  const candidates: string[] = [];
  let scanned = 0;
  let limitReached = false;
  const ignoredRoots = new Set(['node_modules', 'wiki']);
  const walk = async (directory: string): Promise<void> => {
    if (limitReached) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (limitReached) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(vault, full);
      const rootName = relative.split(path.sep)[0];
      if (entry.isDirectory()) {
        if (!ignoredRoots.has(rootName) && !entry.name.startsWith('.')) await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      scanned += 1;
      if (scanned > 5000) {
        limitReached = true;
        return;
      }
      const stat = await fsp.stat(full).catch(() => null);
      if (stat?.size === snapshotSize) candidates.push(full);
    }
  };
  await walk(vault);
  candidates.sort((left, right) => {
    const leftPath = path.relative(vault, left);
    const rightPath = path.relative(vault, right);
    return leftPath.length - rightPath.length || leftPath.localeCompare(rightPath);
  });
  for (const candidate of candidates) {
    const digest = crypto.createHash('sha256').update(await fsp.readFile(candidate)).digest('hex');
    if (digest === expectedHash.toLowerCase()) return path.relative(vault, candidate).split(path.sep).join('/');
  }
  return null;
}

function canonicalRawCitationTarget(target: string): string | null {
  let candidate = target.trim().replace(/\\/g, '/');
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) return null;
  while (candidate.startsWith('../') || candidate.startsWith('./')) {
    candidate = candidate.startsWith('../') ? candidate.slice(3) : candidate.slice(2);
  }
  const normalized = path.posix.normalize(candidate);
  if (!normalized.startsWith('.raw/captured/') || normalized === '.raw/captured') return null;
  return normalized;
}

async function isSafeRawSnapshot(vault: string, target: string): Promise<boolean> {
  try {
    const vaultReal = await fsp.realpath(vault);
    const capturedReal = await fsp.realpath(path.join(vault, '.raw', 'captured'));
    const targetPath = path.join(vault, ...target.split('/'));
    const stat = await fsp.lstat(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const targetReal = await fsp.realpath(targetPath);
    return isPathInside(vaultReal, capturedReal) && isPathInside(capturedReal, targetReal);
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function parseKnowledgeHealthReport(
  raw: unknown,
  commandOk: boolean,
  commandError: string | null,
  recoveryPending: boolean,
): KnowledgeHealthReport {
  const parsed = asRecord(raw);
  if (!parsed) return emptyHealth(commandError ?? '健康报告格式无效。', recoveryPending);
  const summaryRecord = asRecord(parsed.summary) ?? {};
  const findings: KnowledgeHealthFinding[] = [];
  for (const category of LINT_CATEGORIES) {
    const items = Array.isArray(parsed[category]) ? parsed[category] as unknown[] : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem) ?? {};
      findings.push({
        rule: category,
        severity: lintSeverity(category),
        path: firstString(item.path, item.source, item.page, item.file) ?? '',
        line: typeof item.line === 'number' ? item.line : null,
        target: firstString(item.target, item.link, item.basename),
        message: firstString(item.message, item.reason, item.error) ?? categoryLabel(category),
      });
    }
  }
  const pages = numberValue(summaryRecord.pages_scanned);
  const links = numberValue(summaryRecord.links_scanned);
  const issueCount = numberValue(summaryRecord.issues_found, findings.length);
  const summary: Record<string, number> = { pages_scanned: pages, links_scanned: links, issues_found: issueCount };
  const counts = asRecord(summaryRecord.category_counts);
  if (counts) {
    for (const [key, value] of Object.entries(counts)) if (typeof value === 'number') summary[key] = value;
  }
  return {
    ok: commandOk && issueCount === 0 && findings.length === 0 && !recoveryPending,
    pages,
    links,
    findings,
    summary,
    recoveryPending,
    error: commandOk ? null : commandError,
  };
}

async function resolveReadableVaultFile(vault: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('当前笔记路径无效。');
  const root = await fsp.realpath(vault);
  const candidate = path.resolve(root, ...relative.replace(/\\/g, '/').split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('当前笔记路径越界。');
  const stat = await fsp.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('当前笔记必须是普通 Markdown 文件。');
  const real = await fsp.realpath(candidate);
  if (!real.startsWith(`${root}${path.sep}`)) throw new Error('当前笔记指向 Vault 之外。');
  return real;
}

function sanitizeRetrievedEvidence(raw: unknown): string | null {
  const value = asRecord(raw);
  if (!value || !Array.isArray(value.candidates)) return null;
  const candidates = value.candidates.flatMap((rawCandidate): Array<Record<string, unknown>> => {
    const candidate = asRecord(rawCandidate);
    const pagePath = candidate && typeof candidate.page_path === 'string' ? candidate.page_path.replace(/\\/g, '/') : '';
    if (!pagePath.startsWith('wiki/') || pagePath.includes('../')) return [];
    return [{
      page_path: pagePath,
      chunk_id: typeof candidate?.chunk_id === 'string' ? candidate.chunk_id : undefined,
      snippet: typeof candidate?.snippet === 'string' ? candidate.snippet.slice(0, 4_000) : '',
      bm25_score: typeof candidate?.bm25_score === 'number' ? candidate.bm25_score : undefined,
      rerank_score: typeof candidate?.rerank_score === 'number' ? candidate.rerank_score : undefined,
    }];
  }).slice(0, 5);
  if (candidates.length === 0) return null;
  return JSON.stringify({
    strategy: typeof value.strategy === 'string' ? value.strategy : 'wiki-retrieve',
    candidates,
  }, null, 2);
}

async function searchKnowledgePages(vault: string, question: string, limit: number): Promise<Array<{ path: string; content: string }>> {
  const terms = queryTerms(question);
  if (terms.length === 0) return [];
  const files = await listMarkdownFiles(path.join(vault, 'wiki'));
  const scored: Array<{ path: string; content: string; score: number }> = [];
  for (const full of files) {
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const content = await fsp.readFile(full, 'utf8');
    const relative = path.relative(vault, full).split(path.sep).join('/');
    const haystack = `${relative}\n${content}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const fileWeight = relative.toLowerCase().includes(term) ? 5 : 0;
      const occurrences = haystack.split(term).length - 1;
      score += fileWeight + Math.min(occurrences, 20);
    }
    if (score > 0) scored.push({ path: relative, content: content.slice(0, 80_000), score });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

function queryTerms(question: string): string[] {
  const lower = question.toLowerCase();
  const words = (lower.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).map(word => word.slice(0, 64));
  const chineseRuns = lower.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const bigrams = chineseRuns.flatMap(run => {
    const characters = [...run].slice(0, 64);
    return characters.slice(0, -1).map((char, index) => `${char}${characters[index + 1]}`);
  });
  return [...new Set([...words, ...bigrams])].sort((a, b) => b.length - a.length).slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function errorCode(message: string | null): string {
  if (!message) return 'unknown';
  return message.match(/\b(?:ERR\s+)?([A-Z][A-Z0-9_]{2,})\b/)?.[1]?.toLowerCase() ?? 'runtime-error';
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function lintSeverity(category: typeof LINT_CATEGORIES[number]): KnowledgeHealthFinding['severity'] {
  if (['configuration_errors', 'read_errors', 'provenance_errors'].includes(category)) return 'high';
  if (['orphans', 'empty_sections'].includes(category)) return 'low';
  return 'medium';
}

function categoryLabel(category: string): string {
  return ({
    configuration_errors: '知识库配置错误',
    read_errors: '文件读取错误',
    provenance_errors: '证据账本错误',
    dead_links: '断开的链接',
    ambiguous_targets: '链接目标不明确',
    duplicate_basenames: '重复笔记名称',
    missing_frontmatter: '缺少笔记属性',
    stale_index_entries: '索引条目已过期',
    orphans: '孤立笔记',
    empty_sections: '空章节',
  } as Record<string, string>)[category] ?? category;
}

function emptyHealth(error: string, recoveryPending: boolean): KnowledgeHealthReport {
  return { ok: false, pages: 0, links: 0, findings: [], summary: {}, recoveryPending, error };
}

function extractTitle(content: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Untitled';
}

async function countLedgerEntryChanges(
  vault: string,
  draft: KnowledgeDraftV1,
  relative: string,
  collectionKey: 'sources' | 'claims',
): Promise<number> {
  const write = draft.writes.find(item => item.path === relative);
  if (!write) return 0;
  try {
    const beforeText = await fsp.readFile(path.join(vault, relative), 'utf8').catch(() => '{}');
    const before = asRecord(asRecord(JSON.parse(beforeText))?.[collectionKey]) ?? {};
    const after = asRecord(asRecord(JSON.parse(write.content))?.[collectionKey]) ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let changed = 0;
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed += 1;
    }
    return changed;
  } catch {
    return 1;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(full);
      if (output.length > 5000) throw new Error('知识库页面超过首版 5000 页引用校验上限。');
    }
  };
  await walk(root);
  return output;
}
