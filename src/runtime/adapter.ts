import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import type { AgentId, ChatTurnRequest, ProviderProfile, RuntimeTurnEvent } from '../types';
import { mergeEnvironment } from '../utils/env';
import { prepareProviderProjection } from './providerProjection';
import {
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parseOpenCodeStreamLine,
} from './parsers';
import {
  classifyClaudeProviderError,
  extractClaudeConnectorWarning,
  stripClaudeConnectorWarning,
} from './errors';

export interface AgentAdapterOptions {
  agentId: AgentId;
  binaryPath: string;
  sharedEnvironmentVariables: string;
  providerProfile: ProviderProfile | null;
}

export class AgentAdapter extends EventEmitter {
  private child: ChildProcess | null = null;
  private terminalErrorEmitted = false;
  private cancelled = false;
  private pendingTerminalError: Extract<RuntimeTurnEvent, { type: 'error' }> | null = null;
  private terminalErrorTimer: number | null = null;

  constructor(private readonly options: AgentAdapterOptions) {
    super();
  }

  run(request: ChatTurnRequest): Promise<void> {
    this.terminalErrorEmitted = false;
    this.cancelled = false;
    this.clearPendingTerminalError();
    const baseEnv = mergeEnvironment(process.env, this.options.sharedEnvironmentVariables);
    const projection = request.configSource === 'providerProfile'
      ? prepareProviderProjection(this.options.agentId, this.options.providerProfile, baseEnv)
      : prepareProviderProjection(this.options.agentId, null, baseEnv);
    const prompt = buildEffectivePrompt(request, this.options.agentId);
    const { args, stdinPayload } = this.buildArgs(request, prompt, projection.args);

    return new Promise<void>((resolve) => {
      let stdoutBuffer = '';
      let stderrTail = '';
      let sawOutput = false;

      const child = spawn(this.options.binaryPath, args, {
        cwd: request.cwd,
        env: projection.env,
        stdio: [stdinPayload === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      if (stdinPayload !== null && child.stdin) {
        // The runtime may exit before consuming stdin; swallow the resulting EPIPE.
        child.stdin.on('error', () => {});
        child.stdin.end(stdinPayload);
      }

      child.stdout?.on('data', (chunk: unknown) => {
        sawOutput = true;
        stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          this.emitParsed(line);
        }
      });

      child.stderr?.on('data', (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stderrTail = appendTail(stderrTail, text);
        if (this.options.agentId === 'claude' && this.options.providerProfile) {
          const classified = classifyClaudeProviderError(stderrTail, {
            providerName: this.options.providerProfile?.name,
            providerProfileId: this.options.providerProfile?.id,
          });
          if (classified) this.scheduleTerminalProviderError(classified);
        }
      });

      child.on('error', error => {
        this.clearPendingTerminalError();
        projection.cleanup();
        this.terminalErrorEmitted = true;
        this.emitEvent({ type: 'error', message: `Failed to start ${this.options.agentId}: ${error.message}` });
        resolve();
      });

      child.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          this.emitParsed(stdoutBuffer);
        }
        this.flushTerminalProviderError();
        projection.cleanup();
        this.child = null;
        if (this.terminalErrorEmitted) {
          resolve();
          return;
        }
        if (this.cancelled) {
          this.emitEvent({ type: 'done' });
          resolve();
          return;
        }
        if (code === 0) {
          if (!sawOutput) {
            this.emitEvent({ type: 'text', content: 'The runtime finished without visible output.' });
          }
          this.emitEvent({ type: 'done' });
          resolve();
          return;
        }
        const message = `${this.options.agentId} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
        const providerClaudeRun = this.options.agentId === 'claude' && Boolean(this.options.providerProfile);
        const cleanedStderr = providerClaudeRun
          ? stripClaudeConnectorWarning(stderrTail)
          : stderrTail.trim();
        this.emitEvent({
          type: 'error',
          message,
          detail: cleanedStderr || undefined,
          providerProfileId: this.options.providerProfile?.id,
          diagnostic: providerClaudeRun ? extractClaudeConnectorWarning(stderrTail) : undefined,
        });
        resolve();
      });
    });
  }

  cancel(): void {
    const child = this.child;
    if (!child) return;
    this.cancelled = true;
    child.kill('SIGTERM');
    const killTimer = window.setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 3_000);
    child.once('exit', () => window.clearTimeout(killTimer));
  }

  onRuntimeEvent(listener: (event: RuntimeTurnEvent) => void): () => void {
    this.on('runtimeEvent', listener);
    return () => this.off('runtimeEvent', listener);
  }

  // Prompts include full file contents and can exceed the OS argv size limit
  // (ARG_MAX), so they are piped through stdin whenever the CLI supports it.
  private buildArgs(
    request: ChatTurnRequest,
    prompt: string,
    providerArgs: string[],
  ): { args: string[]; stdinPayload: string | null } {
    if (this.options.agentId === 'claude') {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ];
      const model = request.configSource === 'providerProfile'
        ? this.options.providerProfile?.defaultModel || this.options.providerProfile?.model
        : request.model;
      if (model?.trim()) {
        args.push('--model', model.trim());
      }
      if (request.sessionId?.trim()) {
        args.push('--resume', request.sessionId.trim());
      }
      if (request.planMode) {
        args.push('--permission-mode', 'plan');
      }
      // `claude -p` without a positional prompt reads it from stdin.
      return { args, stdinPayload: prompt };
    }

    if (this.options.agentId === 'codex') {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--cd',
        request.cwd,
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy="never"',
      ];
      args.push(...providerArgs);
      if (request.configSource === 'localCli' && request.model?.trim()) {
        args.push(...buildCodexModelArgs(request.model.trim()));
      }
      for (const attachment of request.attachments ?? []) {
        if (attachment.mimeType?.startsWith('image/')) {
          args.push('--image', attachment.absolutePath);
        }
      }
      // `codex exec -` reads the prompt from stdin.
      args.push('-');
      return { args, stdinPayload: prompt };
    }

    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      request.cwd,
    ];
    args.push(...providerArgs);
    if (request.configSource === 'localCli' && request.model?.trim()) {
      args.push('--model', request.model.trim());
    }
    for (const attachment of request.attachments ?? []) {
      args.push('--file', attachment.absolutePath);
    }
    // opencode has no documented stdin prompt mode, so it keeps the argv path.
    args.push(prompt);
    return { args, stdinPayload: null };
  }

  private emitParsed(line: string): void {
    const events = this.options.agentId === 'claude'
      ? parseClaudeStreamLine(line)
      : this.options.agentId === 'codex'
        ? parseCodexStreamLine(line)
        : parseOpenCodeStreamLine(line);
    for (const event of events) {
      if (event.type === 'error') {
        if (this.terminalErrorEmitted) continue;
        const classified = this.options.agentId === 'claude' && this.options.providerProfile
          ? classifyClaudeProviderError(`${event.message}\n${event.detail ?? ''}`, {
            providerName: this.options.providerProfile?.name,
            providerProfileId: this.options.providerProfile?.id,
          })
          : null;
        if (classified) {
          this.scheduleTerminalProviderError(classified);
          continue;
        }
        this.terminalErrorEmitted = true;
      }
      this.emitEvent(event);
    }
  }

  private emitTerminalProviderError(event: Extract<RuntimeTurnEvent, { type: 'error' }>): void {
    if (this.terminalErrorEmitted) return;
    this.clearPendingTerminalError();
    this.terminalErrorEmitted = true;
    this.emitEvent(event);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }

  private scheduleTerminalProviderError(event: Extract<RuntimeTurnEvent, { type: 'error' }>): void {
    if (this.terminalErrorEmitted) return;
    const pending = this.pendingTerminalError;
    this.pendingTerminalError = pending
      ? {
        ...event,
        detail: event.detail && event.detail.length >= (pending.detail?.length ?? 0) ? event.detail : pending.detail,
        statusCode: event.statusCode ?? pending.statusCode,
        retryAfterSeconds: event.retryAfterSeconds ?? pending.retryAfterSeconds,
        requestId: event.requestId ?? pending.requestId,
        providerProfileId: event.providerProfileId ?? pending.providerProfileId,
        diagnostic: event.diagnostic ?? pending.diagnostic,
      }
      : event;
    if (this.terminalErrorTimer) window.clearTimeout(this.terminalErrorTimer);
    // Claude often prints the request id on the next stderr line. A short
    // debounce keeps the failure immediate while preserving that metadata.
    this.terminalErrorTimer = window.setTimeout(() => this.flushTerminalProviderError(), 40);
  }

  private flushTerminalProviderError(): void {
    const event = this.pendingTerminalError;
    this.clearPendingTerminalError();
    if (event) this.emitTerminalProviderError(event);
  }

  private clearPendingTerminalError(): void {
    if (this.terminalErrorTimer) window.clearTimeout(this.terminalErrorTimer);
    this.terminalErrorTimer = null;
    this.pendingTerminalError = null;
  }

  private emitEvent(event: RuntimeTurnEvent): void {
    this.emit('runtimeEvent', event);
  }
}

function buildCodexModelArgs(model: string): string[] {
  const [provider, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');
  if (provider && modelId) {
    return [
      '-c',
      `model_provider=${JSON.stringify(provider)}`,
      '-c',
      `model=${JSON.stringify(modelId)}`,
    ];
  }
  return ['-c', `model=${JSON.stringify(model)}`];
}

function buildEffectivePrompt(request: ChatTurnRequest, agentId: AgentId): string {
  const sections: string[] = [];
  if (request.systemPrompt?.trim()) {
    sections.push(`System guidance:\n${request.systemPrompt.trim()}`);
  }
  // Claude gets real plan enforcement via --permission-mode plan; others only get this soft instruction.
  if (request.planMode && agentId !== 'claude') {
    sections.push([
      'Plan Mode is enabled.',
      'Explore the vault context, explain the intended changes, and wait for explicit user approval before editing files or running destructive commands.',
    ].join('\n'));
  }
  sections.push(request.prompt);
  if (agentId === 'claude') {
    const attachmentPaths = (request.attachments ?? []).map(attachment => `- ${attachment.absolutePath}`);
    if (attachmentPaths.length > 0) {
      sections.push(`Attached files (use your file tools to read them):\n${attachmentPaths.join('\n')}`);
    }
  }
  return sections.join('\n\n');
}

function appendTail(current: string, addition: string): string {
  const next = current + addition;
  return next.length > 24_000 ? next.slice(next.length - 24_000) : next;
}
