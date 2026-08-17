import { EventEmitter } from 'events';

import type {
  ChatTurnRequest,
  CodexModelDescriptor,
  CodexRuntimeStatus,
  RuntimeBinarySource,
  RuntimeTurnEvent,
  ToolCallEvent,
} from '../types';
import { privateUrlProxyBypassHost, withNoProxyHost } from '../utils/env';
import { CodexAppServerClient } from './codexAppServer';
import { appendAttachmentContext } from './attachmentContext';

export interface CodexRuntimeConnection {
  binaryPath: string;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  clientVersion?: string;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  listener: (event: RuntimeTurnEvent) => void;
  resolve: () => void;
  emittedDeltas: Map<string, string>;
  emittedItems: Set<string>;
  bufferedNotifications: Array<{ method: string; params: unknown }>;
  interrupted: boolean;
  finished: boolean;
  errorEmitted: boolean;
  cleanupAbort: () => void;
  interruptFallback: number | null;
}

const EMPTY_STATUS: CodexRuntimeStatus = {
  state: 'idle',
  binaryPath: null,
  binarySource: null,
  version: null,
  connected: false,
  authenticated: null,
  authMode: null,
  currentModelId: null,
  currentModel: null,
  models: [],
  imageGeneration: null,
  webSearch: null,
  error: null,
};

export class CodexAppServerRuntime extends EventEmitter {
  private status: CodexRuntimeStatus = { ...EMPTY_STATUS };
  private connection: CodexRuntimeConnection | null = null;
  private connecting: Promise<void> | null = null;
  private inferredNoProxyHost: string | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(private readonly client = new CodexAppServerClient()) {
    super();
    client.on('notification', (method: string, params: unknown) => this.handleNotification(method, params));
    client.on('serverRequest', (id: number | string, method: string, params: unknown) => {
      this.handleServerRequest(id, method, params);
    });
    client.on('close', (reason: string) => this.handleClose(reason));
  }

  getStatus(): CodexRuntimeStatus {
    return {
      ...this.status,
      models: this.status.models.map(model => ({ ...model, inputModalities: [...model.inputModalities] })),
      currentModel: this.status.currentModel
        ? { ...this.status.currentModel, inputModalities: [...this.status.currentModel.inputModalities] }
        : null,
    };
  }

  onStatusChange(listener: (status: CodexRuntimeStatus) => void): () => void {
    this.on('status', listener);
    return () => this.off('status', listener);
  }

  async refreshStatus(connection: CodexRuntimeConnection): Promise<CodexRuntimeStatus> {
    this.connection = this.prepareConnection(connection);
    this.setStatus({
      ...this.status,
      state: 'connecting',
      binaryPath: connection.binaryPath,
      binarySource: connection.binarySource,
      version: connection.version,
      connected: false,
      error: null,
    });
    try {
      await this.ensureConnected();
      const [models, config, account, capabilities] = await Promise.all([
        this.readAllModels(),
        this.tryRequest('config/read', { includeLayers: false }),
        this.tryRequest('account/read', { refreshToken: false }),
        this.tryRequest('modelProvider/capabilities/read', {}),
      ]);
      // GUI apps may route private providers through the OS proxy because they
      // do not inherit the user's shell NO_PROXY settings.
      const inferredNoProxyHost = await privateUrlProxyBypassHost(codexProviderBaseUrl(config));
      this.inferredNoProxyHost = inferredNoProxyHost;
      const preparedConnection = this.prepareConnection(connection);
      if (!sameNoProxyEnvironment(this.connection.env, preparedConnection.env)) {
        this.connection = preparedConnection;
        await this.client.disconnect();
        await this.ensureConnected();
      }
      const currentModelId = stringAt(config, 'config', 'model')
        ?? models.find(model => model.isDefault)?.id
        ?? null;
      const currentModel = models.find(model => model.id === currentModelId || model.model === currentModelId) ?? null;
      const accountValue = recordAt(account, 'account');
      const authMode = stringAt(account, 'authMode')
        ?? stringAt(accountValue, 'type')
        ?? stringAt(accountValue, 'authMode');
      this.setStatus({
        state: 'ready',
        binaryPath: connection.binaryPath,
        binarySource: connection.binarySource,
        version: connection.version,
        connected: true,
        authenticated: account === null
          ? null
          : accountValue !== null || valueAt(account, 'requiresOpenaiAuth') === false,
        authMode,
        currentModelId,
        currentModel,
        models,
        imageGeneration: readCapability(capabilities, 'imageGeneration'),
        webSearch: readCapability(capabilities, 'webSearch'),
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus({
        ...this.status,
        state: 'error',
        connected: false,
        error: message,
      });
    }
    return this.getStatus();
  }

  markUnavailable(error: string): void {
    this.connection = null;
    this.inferredNoProxyHost = null;
    for (const active of [...this.activeTurns.values()]) {
      this.finishTurn(active, { type: 'error', message: 'Codex CLI 当前不可用。', detail: error });
    }
    void this.client.disconnect();
    this.setStatus({ ...EMPTY_STATUS, state: 'error', error });
  }

  async runTurn(
    request: ChatTurnRequest,
    connection: CodexRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
  ): Promise<void> {
    this.connection = this.prepareConnection(connection);
    if (request.signal?.aborted) {
      listener({ type: 'done' });
      return;
    }

    if (
      this.status.state !== 'ready'
      || this.status.binaryPath !== connection.binaryPath
      || !this.status.connected
    ) {
      await this.refreshStatus(connection);
    }
    if (this.status.state !== 'ready') {
      listener({ type: 'error', message: 'Codex App Server 启动失败。', detail: this.status.error ?? undefined });
      listener({ type: 'done' });
      return;
    }

    let threadResult: unknown;
    const threadOptions = {
      cwd: request.cwd,
      approvalPolicy: 'never',
      sandbox: request.accessMode === 'read-only' ? 'read-only' : 'workspace-write',
      developerInstructions: request.systemPrompt?.trim() || undefined,
      serviceName: 'wesight_obsidian',
    };
    try {
      if (request.sessionId?.trim()) {
        try {
          threadResult = await this.client.request('thread/resume', {
            threadId: request.sessionId.trim(),
            ...threadOptions,
          });
        } catch {
          threadResult = await this.client.request('thread/start', threadOptions);
        }
      } else {
        threadResult = await this.client.request('thread/start', threadOptions);
      }
    } catch (error) {
      listener({ type: 'error', message: 'Codex 会话启动失败。', detail: errorMessage(error) });
      listener({ type: 'done' });
      return;
    }

    const threadId = stringAt(threadResult, 'thread', 'id');
    if (!threadId) {
      listener({ type: 'error', message: 'Codex App Server 未返回 threadId。' });
      listener({ type: 'done' });
      return;
    }
    listener({ type: 'session', sessionId: threadId });

    await new Promise<void>(resolve => {
      const abort = (): void => {
        active.interrupted = true;
        if (active.turnId) void this.interruptTurn(active);
      };
      const active: ActiveTurn = {
        threadId,
        turnId: null,
        listener,
        resolve,
        emittedDeltas: new Map(),
        emittedItems: new Set(),
        bufferedNotifications: [],
        interrupted: false,
        finished: false,
        errorEmitted: false,
        cleanupAbort: () => request.signal?.removeEventListener('abort', abort),
        interruptFallback: null,
      };
      this.activeTurns.set(threadId, active);
      request.signal?.addEventListener('abort', abort, { once: true });

      const pathAttachments = request.attachments?.filter(attachment => !attachment.mimeType?.startsWith('image/'));
      const prompt = appendAttachmentContext(request.prompt, pathAttachments);
      const input: Array<Record<string, unknown>> = [{ type: 'text', text: prompt, text_elements: [] }];
      for (const attachment of request.attachments ?? []) {
        if (attachment.mimeType?.startsWith('image/')) {
          input.push({ type: 'localImage', path: attachment.absolutePath });
        }
      }
      const params: Record<string, unknown> = {
        threadId,
        input,
        cwd: request.cwd,
        approvalPolicy: 'never',
        ...(request.textOnly ? { effort: 'low' } : {}),
        sandboxPolicy: request.accessMode === 'read-only'
          ? { type: 'readOnly' }
          : {
              type: 'workspaceWrite',
              writableRoots: [request.cwd],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
      };
      if (request.planMode) {
        const planModel = stringAt(threadResult, 'thread', 'model')
          ?? this.status.currentModelId
          ?? this.status.models.find(model => model.isDefault)?.id;
        if (planModel) {
          params.collaborationMode = {
            mode: 'plan',
            settings: {
              model: planModel,
              reasoning_effort: 'medium',
              developer_instructions: null,
            },
          };
        }
      }

      void this.client.request('turn/start', params).then(result => {
        active.turnId = stringAt(result, 'turn', 'id');
        if (!active.turnId) {
          this.finishTurn(active, {
            type: 'error',
            message: 'Codex App Server 未返回 turnId。',
          });
          return;
        }
        const buffered = active.bufferedNotifications.splice(0);
        for (const notification of buffered) {
          this.deliverNotification(active, notification.method, notification.params);
        }
        if (active.interrupted) void this.interruptTurn(active);
      }).catch(error => {
        this.finishTurn(active, {
          type: 'error',
          message: 'Codex 回合启动失败。',
          detail: errorMessage(error),
        });
      });
    });
  }

  async cancelAll(): Promise<void> {
    const turns = [...this.activeTurns.values()];
    for (const turn of turns) turn.interrupted = true;
    await Promise.all(turns.map(turn => this.interruptTurn(turn)));
  }

  async shutdown(): Promise<void> {
    const cancellation = this.cancelAll();
    for (const active of [...this.activeTurns.values()]) this.finishTurn(active);
    await this.client.disconnect();
    await cancellation;
    this.connection = null;
    this.inferredNoProxyHost = null;
    this.setStatus({ ...EMPTY_STATUS });
  }

  private async ensureConnected(): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error('Codex CLI path is unavailable');
    if (this.client.isReady && this.client.connectedExecutablePath === connection.binaryPath) return;
    if (!this.connecting) {
      this.connecting = this.client.connect({
        executablePath: connection.binaryPath,
        env: connection.env,
        clientVersion: connection.clientVersion,
      }).finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private prepareConnection(connection: CodexRuntimeConnection): CodexRuntimeConnection {
    const env = withNoProxyHost(connection.env, this.inferredNoProxyHost);
    return env === connection.env ? connection : { ...connection, env };
  }

  private async readAllModels(): Promise<CodexModelDescriptor[]> {
    const models: CodexModelDescriptor[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      const data = arrayAt(result, 'data');
      for (const value of data) {
        const model = toModelDescriptor(value);
        if (model) models.push(model);
      }
      cursor = stringAt(result, 'nextCursor');
    } while (cursor);
    return models;
  }

  private async tryRequest(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.client.request(method, params, 10_000);
    } catch {
      return null;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const threadId = stringAt(params, 'threadId') ?? stringAt(params, 'thread', 'id');
    if (!threadId) return;
    const active = this.activeTurns.get(threadId);
    if (!active || active.finished) return;
    if (!active.turnId) {
      active.bufferedNotifications.push({ method, params });
      return;
    }
    this.deliverNotification(active, method, params);
  }

  private deliverNotification(active: ActiveTurn, method: string, params: unknown): void {
    const turnId = stringAt(params, 'turnId') ?? stringAt(params, 'turn', 'id');
    if (turnId && turnId !== active.turnId) return;

    if (method === 'item/agentMessage/delta') {
      const itemId = stringAt(params, 'itemId') ?? 'agent-message';
      const delta = stringAt(params, 'delta');
      if (delta) {
        active.emittedDeltas.set(itemId, `${active.emittedDeltas.get(itemId) ?? ''}${delta}`);
        active.listener({ type: 'text', content: delta });
      }
      return;
    }
    if (method === 'item/plan/delta') {
      const itemId = stringAt(params, 'itemId') ?? 'plan';
      const delta = stringAt(params, 'delta');
      if (delta) {
        active.emittedDeltas.set(itemId, `${active.emittedDeltas.get(itemId) ?? ''}${delta}`);
        active.listener({ type: 'text', content: delta });
      }
      return;
    }
    if (method === 'item/thinking/delta' || method === 'item/reasoning/delta') {
      const itemId = stringAt(params, 'itemId') ?? 'thinking';
      const delta = stringAt(params, 'delta');
      if (delta) {
        active.emittedDeltas.set(itemId, `${active.emittedDeltas.get(itemId) ?? ''}${delta}`);
        active.listener({ type: 'reasoning', content: delta, id: itemId });
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.deliverItem(active, recordAt(params, 'item'), method === 'item/completed');
      return;
    }
    if (method === 'error') {
      const error = recordAt(params, 'error');
      active.errorEmitted = true;
      active.listener({
        type: 'error',
        message: stringAt(error, 'message') ?? 'Codex 回合失败。',
        detail: stringAt(error, 'additionalDetails') ?? undefined,
        statusCode: numberAt(error, 'codexErrorInfo', 'httpStatusCode') ?? undefined,
      });
      return;
    }
    if (method === 'warning') {
      // App Server warnings are non-fatal diagnostics (for example an
      // unavailable service tier or fallback model metadata). Rendering them
      // as a red assistant error makes a successful turn look failed.
      return;
    }
    if (method === 'turn/completed') {
      const turn = recordAt(params, 'turn');
      if (stringAt(turn, 'status') === 'failed' && !active.errorEmitted) {
        const error = recordAt(turn, 'error');
        active.listener({
          type: 'error',
          message: stringAt(error, 'message') ?? 'Codex 回合失败。',
          detail: stringAt(error, 'additionalDetails') ?? undefined,
        });
      }
      this.finishTurn(active);
    }
  }

  private deliverItem(active: ActiveTurn, item: Record<string, unknown> | null, completed: boolean): void {
    if (!item) return;
    const id = stringAt(item, 'id') ?? `${stringAt(item, 'type') ?? 'item'}-${active.emittedItems.size}`;
    const type = stringAt(item, 'type') ?? 'tool';
    if (completed && active.emittedItems.has(id)) return;

    if (type === 'agentMessage' || type === 'plan') {
      if (!completed) return;
      active.emittedItems.add(id);
      const text = stringAt(item, 'text');
      if (text && !active.emittedDeltas.has(id)) active.listener({ type: 'text', content: text });
      return;
    }

    if (type === 'thinking' || type === 'reasoning') {
      if (!completed) return;
      active.emittedItems.add(id);
      const text = stringAt(item, 'text') ?? stringAt(item, 'thinking') ?? stringAt(item, 'reasoning') ?? stringAt(item, 'content');
      if (text && !active.emittedDeltas.has(id)) active.listener({ type: 'reasoning', content: text, id });
      return;
    }

    const toolCall = toolCallFromItem(item, completed);
    if (toolCall) active.listener({ type: 'tool', toolCall });
    if (!completed) return;
    active.emittedItems.add(id);

    if (type === 'imageGeneration') {
      const sourcePath = stringAt(item, 'savedPath');
      if (sourcePath) {
        active.listener({
          type: 'artifact',
          artifact: {
            itemId: id,
            kind: 'image',
            sourcePath,
            mimeType: stringAt(item, 'mimeType') ?? undefined,
            revisedPrompt: stringAt(item, 'revisedPrompt') ?? stringAt(item, 'revised_prompt') ?? undefined,
          },
        });
      } else {
        const failed = stringAt(item, 'status') === 'failed';
        active.listener({
          type: 'error',
          message: failed ? 'Codex 图片生成失败。' : 'Codex 图片生成没有返回 savedPath。',
          detail: stringAt(item, 'error') ?? stringAt(item, 'result') ?? undefined,
        });
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const active = this.activeTurns.get(stringAt(params, 'threadId') ?? '');
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.client.respond(id, { decision: 'approve' });
      active?.listener({ type: 'text', content: 'Codex 请求执行/写文件，WeSight 已自动批准。' });
      return;
    }
    this.client.reject(id, -32601, `Unsupported Codex server request: ${method}`);
    active?.listener({ type: 'error', message: `Codex 发出了未支持的服务端请求：${method}` });
  }

  private async interruptTurn(active: ActiveTurn): Promise<void> {
    if (!active.turnId || active.finished) return;
    try {
      await this.client.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }, 5_000);
      if (!active.finished && active.interruptFallback === null) {
        active.interruptFallback = window.setTimeout(() => this.finishTurn(active), 2_000);
      }
    } catch {
      this.finishTurn(active);
    }
  }

  private finishTurn(active: ActiveTurn, error?: Extract<RuntimeTurnEvent, { type: 'error' }>): void {
    if (active.finished) return;
    active.finished = true;
    active.cleanupAbort();
    if (active.interruptFallback !== null) window.clearTimeout(active.interruptFallback);
    this.activeTurns.delete(active.threadId);
    if (error) active.listener(error);
    active.listener({ type: 'done', sessionId: active.threadId });
    active.resolve();
  }

  private handleClose(reason: string): void {
    this.setStatus({ ...this.status, state: 'error', connected: false, error: `Codex App Server 已退出：${reason}` });
    for (const active of [...this.activeTurns.values()]) {
      this.finishTurn(active, { type: 'error', message: 'Codex App Server 连接已中断。', detail: reason });
    }
  }

  private setStatus(status: CodexRuntimeStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}

function toolCallFromItem(item: Record<string, unknown>, completed: boolean): ToolCallEvent | null {
  const type = stringAt(item, 'type') ?? '';
  const id = stringAt(item, 'id') ?? `${type}-${Date.now()}`;
  const status: ToolCallEvent['status'] = completed
    ? (stringAt(item, 'status') === 'failed' ? 'error' : 'completed')
    : 'started';
  if (type === 'commandExecution') {
    return { id, name: 'Command', status, input: { command: item.command, cwd: item.cwd }, output: item.aggregatedOutput, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'fileChange') {
    return { id, name: 'File changes', status, input: item.changes, output: completed ? item.changes : undefined };
  }
  if (type === 'mcpToolCall') {
    return { id, name: `${stringAt(item, 'server') ?? 'MCP'}:${stringAt(item, 'tool') ?? 'tool'}`, status, input: item.arguments, output: item.result, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'dynamicToolCall') {
    return { id, name: stringAt(item, 'tool') ?? 'Tool', status, input: item.arguments, output: item.contentItems, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'webSearch') {
    return { id, name: 'Web search', status, input: item.query ?? item.action, output: completed ? item.action : undefined };
  }
  if (type === 'imageGeneration') {
    return { id, name: 'Image generation', status, input: item.prompt, output: completed ? item.savedPath : undefined, error: stringAt(item, 'error') ?? undefined };
  }
  return null;
}

function toModelDescriptor(value: unknown): CodexModelDescriptor | null {
  if (!isRecord(value)) return null;
  const id = stringAt(value, 'id') ?? stringAt(value, 'model');
  if (!id) return null;
  const modalities = Array.isArray(value.inputModalities)
    ? value.inputModalities.filter((entry): entry is string => typeof entry === 'string')
    : ['text', 'image'];
  return {
    id,
    model: stringAt(value, 'model') ?? id,
    displayName: stringAt(value, 'displayName') ?? id,
    description: stringAt(value, 'description') ?? '',
    hidden: Boolean(value.hidden),
    isDefault: Boolean(value.isDefault),
    defaultReasoningEffort: stringAt(value, 'defaultReasoningEffort'),
    inputModalities: modalities,
  };
}

function readCapability(value: unknown, key: string): boolean | null {
  const direct = valueAt(value, key);
  if (typeof direct === 'boolean') return direct;
  const supported = valueAt(value, 'capabilities', key);
  if (typeof supported === 'boolean') return supported;
  const nested = valueAt(value, 'capabilities', key, 'supported');
  if (typeof nested === 'boolean') return nested;
  return null;
}

function codexProviderBaseUrl(value: unknown): string | null {
  const config = recordAt(value, 'config');
  const providerId = stringAt(config, 'model_provider');
  return providerId ? stringAt(config, 'model_providers', providerId, 'base_url') : null;
}

function sameNoProxyEnvironment(a: NodeJS.ProcessEnv, b: NodeJS.ProcessEnv): boolean {
  return a.NO_PROXY === b.NO_PROXY && a.no_proxy === b.no_proxy;
}

function recordAt(value: unknown, ...path: string[]): Record<string, unknown> | null {
  const resolved = valueAt(value, ...path);
  return isRecord(resolved) ? resolved : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const resolved = valueAt(value, ...path);
  return Array.isArray(resolved) ? resolved : [];
}

function stringAt(value: unknown, ...path: string[]): string | null {
  const resolved = valueAt(value, ...path);
  return typeof resolved === 'string' && resolved.trim() ? resolved : null;
}

function numberAt(value: unknown, ...path: string[]): number | null {
  const resolved = valueAt(value, ...path);
  return typeof resolved === 'number' ? resolved : null;
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
