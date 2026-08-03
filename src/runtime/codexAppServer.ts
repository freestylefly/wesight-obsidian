import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

interface JsonRpcError {
  code: number | string;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export interface CodexAppServerConnectOptions {
  executablePath: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

/**
 * Codex CLI has changed the accepted service-tier values over time. The
 * desktop config can retain an older `default`/`priority` value, which makes
 * a newer app-server reject the whole configuration before a thread starts.
 * `fast` is accepted by current CLI versions and is safely omitted by Codex
 * when the selected model does not advertise that tier.
 */
export function buildCodexAppServerArgs(): string[] {
  return ['app-server', '-c', 'service_tier="fast"', '--listen', 'stdio://'];
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private executablePath: string | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stdoutBuffer = '';
  private stderrTail = '';
  private ready = false;
  private disconnecting = false;

  get isReady(): boolean {
    return this.ready;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  get connectedExecutablePath(): string | null {
    return this.executablePath;
  }

  async connect(options: CodexAppServerConnectOptions): Promise<void> {
    if (this.isRunning && this.executablePath === options.executablePath && this.ready) return;
    if (this.child) await this.disconnect();

    this.disconnecting = false;
    this.ready = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.executablePath = options.executablePath;

    const child = spawn(options.executablePath, buildCodexAppServerArgs(), {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.handleStdout(text);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      const text = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).trim();
      if (text) {
        this.stderrTail = `${this.stderrTail}\n${text}`.slice(-8_000).trim();
        this.emit('log', 'warn', text);
      }
    });
    child.on('error', error => this.handleFatal(error));
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));

    await this.request('initialize', {
      clientInfo: {
        name: 'wesight_obsidian',
        title: 'WeSight Obsidian',
        version: options.clientVersion ?? '0.1.8',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, 10_000);
    this.notify('initialized', {});
    this.ready = true;
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      return Promise.reject(new Error('Codex App Server is not running'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  reject(id: number | string, code: number | string, message: string, data?: unknown): void {
    this.write({ id, error: { code, message, data } });
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    this.disconnecting = true;
    this.ready = false;
    this.child = null;
    this.executablePath = null;
    this.rejectPending(new Error('Codex App Server disconnected'));
    if (!child || child.killed || child.exitCode !== null) return;

    child.stdin?.end();
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timeout = window.setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin?.writable) {
      this.emit('log', 'warn', 'Codex App Server stdin is not writable');
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit('log', 'warn', `Codex App Server returned non-JSON output: ${line.slice(0, 240)}`);
      return;
    }

    if (message.id !== undefined) {
      if (message.method) {
        this.emit('serverRequest', message.id, message.method, message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        window.clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(new Error(message.error.message || `Codex App Server error ${message.error.code}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      return;
    }

    if (message.method) this.emit('notification', message.method, message.params);
  }

  private handleFatal(error: Error): void {
    this.ready = false;
    this.rejectPending(error);
    this.emit('close', error.message);
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = null;
    this.ready = false;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    const detail = this.stderrTail ? `${reason}: ${this.stderrTail}` : reason;
    this.rejectPending(new Error(`Codex App Server exited with ${detail}`));
    if (!this.disconnecting) this.emit('close', detail);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
