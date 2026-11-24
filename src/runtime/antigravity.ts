import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RuntimeTurnEvent } from '../types';
import type { LocalModelOption } from './localModels';
import { parseJson } from './parsers';

/**
 * Antigravity integration.
 *
 * - Detection: the `agy` CLI (PATH / ~/.local/bin) runs turns; Antigravity.app alone
 *   cannot, so its presence only changes the install hint.
 * - Auth: `agy models` exits 0 only when signed in, so it doubles as the auth probe
 *   and the model catalog.
 * - Login: `agy acp --login` prints a Google sign-in URL, then reads the code that
 *   https://antigravity.google/oauth-callback shows from stdin (same flow T3 Code uses).
 */

export const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/';
const ANTIGRAVITY_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
const AUTH_PROBE_TIMEOUT_MS = 30_000;
const LOGIN_URL_TIMEOUT_MS = 60_000;
const LOGIN_TOTAL_TIMEOUT_MS = 5 * 60_000;

export function antigravityAppPaths(): string[] {
  if (process.platform !== 'darwin') return [];
  return [
    '/Applications/Antigravity.app',
    path.join(os.homedir(), 'Applications', 'Antigravity.app'),
  ];
}

export function antigravityAppInstalled(): boolean {
  return antigravityAppPaths().some(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

export function antigravityLocalConfigPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity-cli'),
    path.join(home, '.gemini', 'antigravity'),
  ];
}

export interface AntigravityAuthStatus {
  state: 'unknown' | 'checking' | 'signedIn' | 'signedOut' | 'error';
  models: LocalModelOption[];
  message: string | null;
  checkedAt: number;
}

let cachedStatus: AntigravityAuthStatus = { state: 'unknown', models: [], message: null, checkedAt: 0 };
let inflight: Promise<AntigravityAuthStatus> | null = null;
const listeners = new Set<(status: AntigravityAuthStatus) => void>();

export function getAntigravityAuthStatus(): AntigravityAuthStatus {
  return cachedStatus;
}

export function onAntigravityAuthChange(listener: (status: AntigravityAuthStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: AntigravityAuthStatus): AntigravityAuthStatus {
  cachedStatus = next;
  for (const listener of listeners) listener(next);
  return next;
}

/** Test hook. */
export function resetAntigravityAuthCache(): void {
  cachedStatus = { state: 'unknown', models: [], message: null, checkedAt: 0 };
  inflight = null;
}

/** Parses `agy models` output: one `<id>\t<label>` per line after a status line. */
export function parseAntigravityModels(stdout: string): LocalModelOption[] {
  const models: LocalModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('\t')) continue;
    const [id, ...rest] = line.split('\t');
    const modelId = id.trim();
    if (!/^[\w.:/-]+$/.test(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({ id: modelId, label: rest.join(' ').trim() || modelId });
  }
  return models;
}

function isSignInRequired(text: string): boolean {
  return /sign in|log in|authenticat|accounts\.google\.com/i.test(text);
}

/** Runs `agy models`; signed in ⇔ exit 0. Concurrent callers share one probe. */
export function checkAntigravityAuth(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<AntigravityAuthStatus> {
  const maxAge = options.maxAgeMs ?? 60_000;
  if (!options.force && cachedStatus.state !== 'unknown' && cachedStatus.state !== 'checking'
    && Date.now() - cachedStatus.checkedAt < maxAge) {
    return Promise.resolve(cachedStatus);
  }
  if (inflight) return inflight;
  setStatus({ ...cachedStatus, state: 'checking' });
  inflight = new Promise<AntigravityAuthStatus>(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: Omit<AntigravityAuthStatus, 'checkedAt'>): void => {
      if (settled) return;
      settled = true;
      inflight = null;
      resolve(setStatus({ ...status, checkedAt: Date.now() }));
    };
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, ['models'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ state: 'error', models: [], message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = window.setTimeout(() => {
      child.kill('SIGKILL');
      finish({ state: 'error', models: cachedStatus.models, message: 'Antigravity 响应超时，请检查网络后重试。' });
    }, AUTH_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      window.clearTimeout(timer);
      finish({ state: 'error', models: [], message: error.message });
    });
    child.on('close', code => {
      window.clearTimeout(timer);
      if (code === 0) {
        finish({ state: 'signedIn', models: parseAntigravityModels(stdout), message: null });
        return;
      }
      const output = `${stdout}\n${stderr}`;
      if (isSignInRequired(output)) {
        finish({ state: 'signedOut', models: [], message: '尚未登录 Antigravity。' });
        return;
      }
      finish({
        state: 'error',
        models: [],
        message: output.replace(/Fetching available models\.\.\./g, '').trim().slice(0, 400) || `agy models 退出码 ${code ?? 'unknown'}`,
      });
    });
  });
  return inflight;
}

export function listAntigravityLocalModels(): LocalModelOption[] {
  return [
    { id: '', label: 'CLI default', note: 'uses Antigravity default' },
    ...cachedStatus.models,
  ];
}

export interface AntigravityLoginSession {
  /** Resolves with the Google sign-in URL the user must open. */
  authorizationUrl: Promise<string>;
  /** Sends the code shown on the Antigravity callback page (or that page's URL). */
  submit(code: string): void;
  /** Resolves when `agy` stored the credentials; rejects on failure or cancel. */
  completed: Promise<void>;
  cancel(): void;
}

export function extractAntigravityAuthUrl(line: string): string | null {
  const match = line.match(/https:\/\/accounts\.google\.com\/\S+/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.origin !== 'https://accounts.google.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Accepts the bare code, or the full callback URL pasted from the address bar.
 * Rejects anything with whitespace or line breaks so nothing extra reaches stdin.
 */
export function normalizeAntigravityLoginCode(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value) || value.length > 4096) return null;
  if (/^[\w./~-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (`${url.origin}${url.pathname}` === ANTIGRAVITY_REDIRECT_URI && url.searchParams.get('code')) return value;
  } catch {
    // Not a URL.
  }
  return null;
}

export function startAntigravityLogin(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravityLoginSession {
  // Drop display variables so agy never tries to open a browser on its own; WeSight opens it.
  const childEnv = { ...env };
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  const child = spawn(binaryPath, ['acp', '--login'], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin?.on('error', () => {});

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const authorizationUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  authorizationUrl.catch(() => {});

  let cancelled = false;
  let urlFound = false;
  let output = '';
  const scan = (chunk: unknown): void => {
    output = (output + String(chunk)).slice(-8_000);
    if (urlFound) return;
    for (const line of output.split(/\r?\n/)) {
      const url = extractAntigravityAuthUrl(line);
      if (url) {
        urlFound = true;
        window.clearTimeout(urlTimer);
        resolveUrl(url);
        return;
      }
    }
  };
  const urlTimer = window.setTimeout(() => {
    if (urlFound) return;
    rejectUrl(new Error('Antigravity 没有返回登录链接，请检查网络后重试。'));
    child.kill('SIGTERM');
  }, LOGIN_URL_TIMEOUT_MS);
  const totalTimer = window.setTimeout(() => child.kill('SIGTERM'), LOGIN_TOTAL_TIMEOUT_MS);
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);

  const completed = new Promise<void>((resolve, reject) => {
    child.on('error', error => {
      window.clearTimeout(urlTimer);
      window.clearTimeout(totalTimer);
      rejectUrl(error);
      reject(new Error(`无法启动 Antigravity 登录：${error.message}`));
    });
    child.on('close', code => {
      window.clearTimeout(urlTimer);
      window.clearTimeout(totalTimer);
      if (!urlFound) rejectUrl(new Error('Antigravity 登录进程已退出。'));
      if (cancelled) {
        reject(new Error('已取消登录。'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      if (/access_denied|denied|cancel/i.test(output)) {
        reject(new Error('Google 登录未获授权，请重新开始。'));
      } else if (/SUBSCRIPTION_REQUIRED/.test(output)) {
        reject(new Error('该 Google 账号没有可用的 Antigravity 订阅。'));
      } else {
        reject(new Error('Antigravity 登录失败，授权码可能已过期，请重新开始。'));
      }
    });
  });
  completed.catch(() => {});

  return {
    authorizationUrl,
    completed,
    submit(code: string) {
      const value = normalizeAntigravityLoginCode(code);
      if (!value) throw new Error('授权码格式不正确，请粘贴页面上显示的完整授权码。');
      child.stdin?.write(`${value}\n`);
    },
    cancel() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      child.kill('SIGTERM');
    },
  };
}

/** Called when a turn reports that sign-in is required, so UIs show the login prompt. */
export function markAntigravitySignedOutFromRun(): void {
  setStatus({ state: 'signedOut', models: cachedStatus.models, message: '尚未登录 Antigravity。', checkedAt: Date.now() });
}

export function isAntigravitySignInOutput(text: string): boolean {
  return /Authentication required|Please sign in|sign in to/i.test(text) || /accounts\.google\.com\/o\/oauth2/.test(text);
}

/**
 * Parses `agy --output-format stream-json` lines.
 * Events: init (conversation_id), step_update (agent_response text_delta, tool steps), result.
 */
export function createAntigravityStreamParser(): (line: string) => RuntimeTurnEvent[] {
  let sessionEmitted = false;
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const parsed = parseJson(trimmed);
    if (!parsed) {
      if (isAntigravitySignInOutput(trimmed)) {
        return [{ type: 'error', message: '尚未登录 Antigravity，请在设置 → Antigravity 中完成浏览器登录。' }];
      }
      return [];
    }
    const event = typeof parsed.event === 'string' ? parsed.event : '';
    const events: RuntimeTurnEvent[] = [];
    if (event === 'init') {
      const conversationId = typeof parsed.conversation_id === 'string' ? parsed.conversation_id : '';
      if (conversationId && !sessionEmitted) {
        sessionEmitted = true;
        events.push({ type: 'session', sessionId: conversationId });
      }
      return events;
    }
    if (event === 'step_update' && parsed.step_update && typeof parsed.step_update === 'object') {
      const step = parsed.step_update as Record<string, unknown>;
      const stepType = typeof step.step_type === 'string' ? step.step_type : '';
      const state = typeof step.state === 'string' ? step.state : '';
      if (stepType === 'agent_response') {
        const thinking = typeof step.thinking_delta === 'string' ? step.thinking_delta : '';
        if (thinking) events.push({ type: 'reasoning', content: thinking });
        const text = typeof step.text_delta === 'string' ? step.text_delta : '';
        if (text) events.push({ type: 'text', content: text });
        return events;
      }
      if (stepType === 'tool') {
        const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info as Record<string, unknown> : {};
        const name = typeof step.tool_name === 'string' ? step.tool_name : typeof info.name === 'string' ? info.name : 'tool';
        events.push({
          type: 'tool',
          toolCall: {
            id: `agy-${typeof step.conversation_id === 'string' ? step.conversation_id : ''}-${typeof step.step_index === 'number' ? step.step_index : ''}`,
            name,
            status: state === 'DONE' ? 'completed' : state === 'ERROR' ? 'error' : 'started',
            input: info.parameters,
          },
        });
        return events;
      }
      return events;
    }
    if (event === 'result' && parsed.result && typeof parsed.result === 'object') {
      const result = parsed.result as Record<string, unknown>;
      const status = typeof result.status === 'string' ? result.status : '';
      if (status && status !== 'SUCCESS') {
        const detail = typeof result.error === 'string' ? result.error : typeof result.response === 'string' ? result.response : undefined;
        events.push({ type: 'error', message: `Antigravity 运行失败（${status}）`, detail });
      }
      return events;
    }
    if (event === 'error') {
      const message = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : trimmed;
      events.push({ type: 'error', message });
    }
    return events;
  };
}
