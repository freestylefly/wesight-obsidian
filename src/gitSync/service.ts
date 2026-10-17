import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { wesightHome } from '../paths';
import { executableSearchPath } from '../utils/env';
import { readJsonFile, writeJsonFile } from '../utils/fs';
import { summarizeGitDiffs, type GitCommitDiff } from './commitMessage';
import {
  DEFAULT_GIT_SYNC_SETTINGS,
  isSyncPathExcluded,
  isAutomaticOfflineHistory,
  parseGitChanges,
  type GitSyncResult,
  type GitSyncSettings,
  type GitSyncState,
  type GitSyncTarget,
} from './types';

interface GitSyncDeps {
  vaultPath: string | null;
  configDir: string;
  settingsDir?: string;
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  notify?: (message: string) => void;
  isOnline?: () => boolean;
  generateCommitMessage?: (diffs: GitCommitDiff[], signal: AbortSignal) => Promise<string>;
}

class GitCommandError extends Error {
  constructor(readonly detail: string, readonly code?: string | number | null,
    readonly remoteOperation = false, readonly timedOut = false) {
    super('Git 命令执行失败');
  }
}

class GitOfflineError extends Error {
  constructor() { super('当前离线，请联网后再同步。'); }
}

function remoteNetworkError(error: unknown): boolean {
  if (!(error instanceof GitCommandError) || !error.remoteOperation) return false;
  const detail = error.detail.toLowerCase();
  if (/authentication|permission denied|could not read username|terminal prompts disabled|invalid username|repository not found|certificate|ssl certificate|tls certificate|proxy authentication|returned error: (?:401|403|407)|pre-receive|hook declined/.test(detail)) return false;
  return error.timedOut || /could not resolve|couldn't resolve|resolve host|resolve proxy|name or service not known|temporary failure in name resolution|network is unreachable|network is down|no route to host|failed to connect|couldn't connect|connection (?:refused|reset|closed|timed out)|operation timed out|connection timeout|econnrefused|econnreset|enetunreach|enotfound|etimedout|empty reply from server/.test(detail);
}

function friendlyError(error: unknown): string {
  if (!(error instanceof GitCommandError)) return error instanceof Error ? error.message : 'Git 同步失败。';
  const detail = error.detail.toLowerCase();
  if (error.code === 'ENOENT') return '未找到 Git，请安装 Git 并重新启动 Obsidian。';
  if (/authentication|could not read username|permission denied|terminal prompts disabled|invalid username|repository not found/.test(detail)) {
    return 'GitHub 认证失败或无仓库权限，请检查本机 Git 登录凭据。';
  }
  if (remoteNetworkError(error)) {
    return '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。';
  }
  if (/index.lock|another git process/.test(detail)) return '仓库正被其他 Git 操作使用，请稍后重试。';
  if (/user.email|user.name|identity unknown|unable to auto-detect email/.test(detail)) {
    return '请先在本机 Git 中配置 user.name 和 user.email，再提交或合并。';
  }
  if (/untracked working tree|would be overwritten|local changes/.test(detail)) {
    return '本地文件会与远程更新重叠，请先提交或处理本地修改，再拉取。';
  }
  if (/conflict|unmerged/.test(detail)) return '存在合并冲突，自动同步已暂停。请处理冲突并完成提交后重试。';
  if (/protected branch|hook declined|pre-receive|gh006|gh013/.test(detail)) return '远程分支规则拒绝了推送，请按团队规则提交合并请求。';
  if (/non-fast-forward|rejected|fetch first/.test(detail)) return '远程已有新提交，请先拉取并合并，再重试推送。';
  if (/not a git repository/.test(detail)) return '当前知识库尚未连接 Git 仓库。';
  return 'Git 操作失败。请检查本机 Git 凭据、仓库权限和 Git 日志后重试。';
}

function safeRemoteUrl(value: string): string {
  return value.replace(/([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/gi, '$1').replace(/[?#].*$/, '');
}

function sameTarget(first: GitSyncTarget | null, second: GitSyncTarget | null): boolean {
  return !!first && !!second && first.root === second.root && first.branch === second.branch
    && first.remote === second.remote && first.remoteBranch === second.remoteBranch
    && first.remoteUrlHash === second.remoteUrlHash;
}

export class GitSyncService {
  private readonly listeners = new Set<(state: GitSyncState) => void>();
  private readonly abort = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private readonly vaultPath: string | null;
  private readonly now: () => number;
  private readonly recordPath: string | null;
  private settings: GitSyncSettings = structuredClone(DEFAULT_GIT_SYNC_SETTINGS);
  private state: GitSyncState = {
    available: false, root: null, branch: null, remote: null, remoteBranch: null,
    remoteUrl: null, upstream: null, ahead: 0, behind: 0, changes: [], operation: null,
    pausedReason: null, error: null, checkedAt: null, remoteCheckedAt: null, history: [],
  };
  private currentTarget: GitSyncTarget | null = null;
  private running: Promise<GitSyncResult> | null = null;
  private disposed = false;
  private lastActivityAt: number;
  private lastAutomaticAt = 0;
  private lastLocalCheckAt = 0;
  private lastCommitAttemptAt = 0;
  private lastAutoError: string | null = null;
  private incompleteOperation = false;

  constructor(private readonly deps: GitSyncDeps) {
    this.now = deps.now ?? Date.now;
    this.lastActivityAt = this.now();
    this.settings = this.normalizeSettings(DEFAULT_GIT_SYNC_SETTINGS);
    this.vaultPath = deps.vaultPath ? fs.realpathSync(deps.vaultPath) : null;
    const env = deps.env ?? process.env;
    this.env = {
      ...env, PATH: executableSearchPath(env.PATH), GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '',
    };
    // Parent processes may export these for another checkout; always use this vault's repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX']) {
      delete this.env[key];
    }
    this.recordPath = this.vaultPath ? path.join(deps.settingsDir ?? path.join(wesightHome(), 'git-sync'),
      `${createHash('sha256').update(this.vaultPath).digest('hex')}.json`) : null;
  }

  async initialize(): Promise<void> {
    if (this.recordPath) {
      const record = readJsonFile<{ settings?: Partial<GitSyncSettings>; history?: GitSyncState['history'] }>(this.recordPath, {});
      if (record.settings) this.settings = this.normalizeSettings(record.settings);
      if (Array.isArray(record.history)) {
        this.state.history = record.history.filter(entry => typeof entry?.message === 'string'
          && typeof entry?.at === 'number' && typeof entry?.action === 'string' && typeof entry?.ok === 'boolean')
          .filter(entry => !isAutomaticOfflineHistory(entry)).slice(0, 30);
        if (this.state.history.length !== record.history.length) {
          try { this.persist(); } catch { /* Filtering the visible history still works in a read-only settings directory. */ }
        }
      }
    }
    await this.refresh();
  }

  getState(): GitSyncState { return structuredClone(this.state); }
  getSettings(): GitSyncSettings { return structuredClone(this.settings); }

  onChange(listener: (state: GitSyncState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.listeners.clear();
  }

  markActivity(vaultRelativePath?: string): void {
    if (vaultRelativePath && this.excluded(vaultRelativePath)) return;
    this.lastActivityAt = this.now();
  }

  previewCommitPaths(settings: GitSyncSettings = this.settings): string[] {
    return this.state.changes.map(change => change.path).filter(filePath => {
      const relative = this.vaultRelative(filePath);
      return relative !== null && !this.excluded(relative, settings);
    });
  }

  async saveSettings(input: GitSyncSettings): Promise<GitSyncResult> {
    return this.perform('保存同步设置', async () => {
      const next = this.normalizeSettings(input);
      const enabled = next.autoPull || next.pullOnOpen || next.autoPush || next.autoCommit;
      try { await this.inspect(); }
      catch (error) {
        if (enabled) throw error;
        this.state.pausedReason = friendlyError(error);
      }
      if (next.autoPull || next.pullOnOpen || next.autoPush || next.autoCommit) {
        this.requireRepository();
        next.target = this.currentTarget;
      } else {
        next.target = null;
      }
      // Persist first: a failed write must never enable automation in memory.
      this.persist(next);
      this.settings = next;
      this.lastActivityAt = this.now();
      this.lastAutomaticAt = this.now();
      this.updatePauseReason();
      return '同步设置已保存，仅作用于此设备的当前知识库。';
    });
  }

  refresh(): Promise<GitSyncResult> {
    if (this.running) return this.running;
    return this.perform('检测仓库', async () => {
      await this.inspect();
      return this.state.available ? '仓库检测完成。' : this.state.pausedReason ?? '当前仓库不可用。';
    }, false);
  }

  check(): Promise<GitSyncResult> {
    return this.perform('检查远程更新', async () => {
      await this.inspect();
      this.requireRepository();
      await this.fetch();
      await this.inspect();
      return `检查完成：待拉取 ${this.state.behind} 个提交，待推送 ${this.state.ahead} 个提交。`;
    });
  }

  pull(): Promise<GitSyncResult> {
    return this.perform('拉取团队更新', async () => {
      await this.inspect();
      this.requireRepository();
      const target = this.currentTarget;
      await this.fetch();
      await this.inspect();
      this.requireUnchangedTarget(target);
      return this.mergeRemote();
    });
  }

  push(): Promise<GitSyncResult> {
    return this.perform('推送提交', async () => {
      await this.inspect();
      this.requireRepository();
      const target = this.currentTarget;
      await this.fetch();
      await this.inspect();
      this.requireUnchangedTarget(target);
      if (this.state.behind) throw new Error('远程已有新提交，请先拉取，再推送。');
      this.requireNoConflict();
      return this.pushCurrent();
    });
  }

  commitAndPush(files: string[], message: string): Promise<GitSyncResult> {
    return this.perform('提交并推送', async () => {
      await this.inspect();
      this.requireRepository();
      this.requireNoConflict();
      const target = this.currentTarget;
      const selected = [...new Set(files)];
      const allowed = new Set(this.previewCommitPaths());
      if (!selected.length) throw new Error('请选择要提交的文件。');
      if (selected.some(file => !allowed.has(file))) {
        throw new Error('文件状态或同步范围已变化，请重新选择要提交的文件。');
      }
      if (!message.trim()) throw new Error('请填写提交说明。');
      await this.git(['add', '--all', '--', ...selected]);
      await this.inspect();
      this.requireUnchangedTarget(target);
      this.requireNoConflict();
      await this.git(['commit', '--only', '-m', message.trim(), '--', ...selected]);
      this.lastActivityAt = this.now();
      await this.inspect();
      this.state.history.unshift({ at: this.now(), action: '手动提交', ok: true,
        message: `已提交 ${selected.length} 个文件。` });
      try {
        await this.fetch();
        await this.inspect();
        this.requireUnchangedTarget(target);
        await this.mergeRemote();
        this.requireUnchangedTarget(target);
        return await this.pushCurrent();
      } catch (error) {
        throw new Error(`本地提交已保存，尚未推送。${friendlyError(error)}`);
      }
    });
  }

  summarizeCommit(files: string[], withAi = false, signal = this.abort.signal): Promise<GitSyncResult> {
    const combinedSignal = AbortSignal.any([this.abort.signal, signal]);
    return this.perform(withAi ? 'AI 总结修改' : '总结修改', async () => {
      await this.inspect();
      this.requireRepository();
      const allowed = new Set(this.previewCommitPaths());
      const selected = [...new Set(files)];
      if (!selected.length) throw new Error('请选择要总结的文件。');
      if (selected.some(file => !allowed.has(file))) throw new Error('所选文件已变化，请重新打开提交窗口。');
      let budget = 48_000;
      const diffs: GitCommitDiff[] = [];
      for (const file of selected) {
        if (combinedSignal.aborted) throw new Error('生成已取消。');
        const change = this.state.changes.find(item => item.path === file)!;
        let patch = ''; let truncated = false;
        const limit = Math.min(8_000, budget);
        if (limit > 0 && change.untracked) {
          const absolute = path.join(this.state.root!, file);
          const stat = fs.lstatSync(absolute);
          if (!stat.isSymbolicLink() && stat.isFile() && stat.size < 128_000) {
            const bytes = fs.readFileSync(absolute);
            if (!bytes.includes(0)) patch = bytes.toString('utf8').split('\n').map(line => `+${line}`).join('\n');
          }
          truncated = !patch || patch.length > limit;
        } else if (limit > 0) {
          patch = await this.git(['diff', '--no-ext-diff', '--no-textconv', '--unified=1', 'HEAD', '--', file]);
          truncated = patch.length > limit;
        } else truncated = true;
        patch = patch.slice(0, limit); budget -= patch.length;
        diffs.push({ file, kind: change.untracked || change.index === 'A' ? 'added'
          : change.working === 'D' || change.index === 'D' ? 'deleted' : 'modified', patch, truncated });
      }
      if (withAi) {
        if (!this.deps.generateCommitMessage) throw new Error('AI 生成暂不可用，请使用自动摘要或手动填写。');
        return this.deps.generateCommitMessage(diffs, combinedSignal);
      }
      return summarizeGitDiffs(diffs);
    }, false);
  }

  async onVaultOpened(): Promise<void> {
    if (this.settings.pullOnOpen) await this.automate(true);
  }

  async tick(): Promise<void> {
    if (this.disposed || this.running || !this.online()) return;
    if (this.now() - this.lastLocalCheckAt >= 30_000) await this.refresh();
    if (this.disposed || this.running) return;
    const settings = this.settings;
    const automatic = settings.autoPull || settings.autoPush || settings.autoCommit;
    const idle = this.now() - this.lastActivityAt >= settings.idleMinutes * 60_000;
    const commitDue = settings.autoCommit && idle && this.previewCommitPaths().length > 0
      && this.now() - this.lastCommitAttemptAt >= 60_000;
    if (automatic && (commitDue || this.now() - this.lastAutomaticAt >= settings.intervalMinutes * 60_000)) {
      if (commitDue) this.lastCommitAttemptAt = this.now();
      await this.automate(false, idle);
    }
  }

  private async automate(onOpen: boolean, idle = false): Promise<void> {
    this.lastAutomaticAt = this.now();
    if (!this.online()) return;
    const result = await this.perform('自动同步', async () => {
      await this.inspect();
      this.requireRepository();
      this.requireAutomaticTarget();
      this.requireNoConflict();
      if (!this.online()) throw new GitOfflineError();
      if (onOpen || this.settings.autoPull || this.settings.autoPush) {
        // Fetch even for push-only mode so remote changes cannot be silently overwritten.
        await this.fetch();
        await this.inspect();
        this.requireAutomaticTarget();
      }
      if (!this.online()) throw new GitOfflineError();
      if (!onOpen && this.settings.autoCommit && idle) await this.commitChanges();
      if (onOpen || this.settings.autoPull) await this.mergeRemote();
      if (!onOpen && this.settings.autoPush) {
        await this.inspect();
        this.requireAutomaticTarget();
        this.requireNoConflict();
        if (this.state.behind) throw new Error('团队有新提交，自动推送已暂停。请先拉取，或开启自动拉取。');
        await this.pushCurrent();
      }
      return '自动同步完成。';
    }, true, true);
    if (result.skipped) return;
    if (!result.ok && result.message !== this.lastAutoError && !this.disposed) {
      this.deps.notify?.(`仓库同步：${result.message}`);
      this.lastAutoError = result.message;
    } else if (result.ok) this.lastAutoError = null;
  }

  private async perform(action: string, work: () => Promise<string>, record = true, automatic = false): Promise<GitSyncResult> {
    if (this.disposed) return { ok: false, message: 'Git 同步已停止。' };
    if (this.running) return { ok: false, message: '仓库正在执行 Git 操作，请稍后重试。' };
    this.state.operation = action;
    this.state.error = null;
    // Defer work until the lock is assigned, including synchronous failures.
    const operation = Promise.resolve().then(async () => {
      let result: GitSyncResult;
      try {
        result = { ok: true, message: await work() };
      } catch (error) {
        if (automatic && (error instanceof GitOfflineError || remoteNetworkError(error))) {
          result = { ok: true, skipped: true, message: '当前离线，已跳过自动同步。' };
        } else {
          result = { ok: false, message: friendlyError(error) };
          if (!this.disposed) {
            try { await this.inspect(); } catch { /* Keep the last known snapshot. */ }
            this.state.error = result.message;
          }
        }
      }
      if (!this.disposed && record && !result.skipped) {
        // Routine automatic successes with no changes do not fill the history.
        if (!automatic || !result.ok || this.state.history[0]?.action !== action) {
          this.state.history.unshift({ at: this.now(), action, ...result });
          this.state.history = this.state.history.slice(0, 30);
          try { this.persist(); } catch { /* Operation result remains valid if history cannot be saved. */ }
        }
      }
      return result;
    });
    this.running = operation;
    this.emit();
    try { return await operation; }
    finally {
      this.running = null;
      this.state.operation = null;
      if (!this.disposed) this.emit();
    }
  }

  private async git(args: string[], cwd = this.state.root ?? this.vaultPath): Promise<string> {
    if (!cwd) throw new Error('Git 同步仅支持桌面端本地知识库。');
    if (this.disposed) throw new Error('Git 同步已停止。');
    const remoteOperation = ['fetch', 'push', 'ls-remote'].includes(args[0]);
    if (remoteOperation && !this.online()) throw new GitOfflineError();
    return new Promise((resolve, reject) => {
      execFile(this.deps.gitPath ?? 'git', ['--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
        cwd, env: this.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        windowsHide: true, shell: false, signal: this.abort.signal,
      }, (error, stdout, stderr) => {
        if (error) reject(new GitCommandError(`${stderr}\n${stdout}\n${error.message}`, error.code,
          remoteOperation, error.killed === true && error.signal === 'SIGTERM'
            && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && !this.abort.signal.aborted));
        else resolve(stdout);
      });
    });
  }

  private online(): boolean { return this.deps.isOnline?.() !== false; }

  private async inspect(): Promise<void> {
    this.lastLocalCheckAt = this.now();
    this.state.available = false;
    this.state.pausedReason = null;
    this.currentTarget = null;
    if (!this.vaultPath) throw new Error('Git 同步仅支持桌面端本地知识库。');
    try {
      this.state.root = (await this.git(['rev-parse', '--show-toplevel'], this.vaultPath)).trim();
    } catch (error) {
      Object.assign(this.state, { root: null, branch: null, remote: null, remoteBranch: null,
        remoteUrl: null, upstream: null, ahead: 0, behind: 0, changes: [] });
      throw error;
    }
    const [branch, changes, gitDir] = await Promise.all([
      this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.git(['rev-parse', '--absolute-git-dir']),
    ]);
    this.state.branch = branch.trim() || null;
    this.state.changes = parseGitChanges(changes);
    this.state.checkedAt = this.now();
    this.state.ahead = 0;
    this.state.behind = 0;
    this.state.remote = null;
    this.state.remoteBranch = null;
    this.state.remoteUrl = null;
    this.state.upstream = null;
    this.incompleteOperation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
      .some(file => fs.existsSync(path.join(gitDir.trim(), file)));
    if (this.incompleteOperation || this.state.changes.some(change => change.conflict)) {
      this.state.pausedReason = '存在未完成的合并或冲突。请完成当前 Git 操作后重试。';
    }
    if (!this.state.branch) {
      this.state.pausedReason = '当前处于游离 HEAD，请先切换到团队协作分支。';
      return;
    }
    const fields = (await this.git(['for-each-ref',
      '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
      `refs/heads/${this.state.branch}`])).trim().split('\0');
    if (!fields[0] || !fields[1] || fields[1] === '.' || !fields[2]?.startsWith('refs/heads/')) {
      this.state.pausedReason ??= '当前分支尚未设置远程跟踪分支，请先在 Git 中连接远程仓库并设置 upstream。';
      return;
    }
    const [fetchUrl, pushUrl] = await Promise.all([
      this.git(['remote', 'get-url', '--', fields[1]]),
      this.git(['remote', 'get-url', '--push', '--all', '--', fields[1]]),
    ]);
    const remoteUrl = fetchUrl.trim();
    this.state.upstream = fields[0];
    this.state.remote = fields[1];
    this.state.remoteBranch = fields[2].slice('refs/heads/'.length);
    this.state.remoteUrl = safeRemoteUrl(remoteUrl);
    this.currentTarget = {
      root: fs.realpathSync(this.state.root), branch: this.state.branch,
      remote: fields[1], remoteBranch: this.state.remoteBranch,
      remoteUrlHash: createHash('sha256').update(`${remoteUrl}\0${pushUrl.trim()}`).digest('hex'),
    };
    const counts = (await this.git(['rev-list', '--left-right', '--count', `HEAD...${this.state.upstream}`])).trim().split(/\s+/);
    this.state.ahead = Number(counts[0]);
    this.state.behind = Number(counts[1]);
    this.state.available = true;
    this.updatePauseReason();
  }

  private updatePauseReason(): void {
    const enabled = this.settings.autoPull || this.settings.autoPush || this.settings.autoCommit || this.settings.pullOnOpen;
    if (enabled && !sameTarget(this.settings.target, this.currentTarget)) {
      this.state.pausedReason = '仓库、分支或远程已变更，自动同步已暂停。请在同步设置中保存当前目标。';
    } else if (this.state.pausedReason?.startsWith('仓库、分支或远程已变更')) {
      this.state.pausedReason = this.incompleteOperation ? '存在未完成的合并或冲突。请完成当前 Git 操作后重试。' : null;
    }
  }

  private requireRepository(): void {
    if (!this.state.available || !this.currentTarget) {
      throw new Error(this.state.pausedReason ?? '当前知识库尚未连接可用的 Git 远程仓库。');
    }
  }

  private requireAutomaticTarget(): void {
    if (!sameTarget(this.settings.target, this.currentTarget)) {
      throw new Error('仓库、分支或远程已变更，自动同步已暂停。请在同步设置中保存当前目标。');
    }
  }

  private requireUnchangedTarget(target: GitSyncTarget | null): void {
    if (!sameTarget(target, this.currentTarget)) throw new Error('Git 目标在操作期间发生变更，请重新检查仓库后重试。');
  }

  private requireNoConflict(): void {
    if (this.incompleteOperation || this.state.changes.some(change => change.conflict)) {
      throw new Error('存在未完成的合并或冲突。请完成当前 Git 操作后重试。');
    }
  }

  private async fetch(): Promise<void> {
    await this.git(['fetch', '--no-tags', '--', this.state.remote!]);
    this.state.remoteCheckedAt = this.now();
  }

  private async mergeRemote(): Promise<string> {
    this.requireNoConflict();
    if (!this.state.behind) return '当前分支已包含团队的最新提交。';
    if (this.state.changes.some(change => !change.untracked)) {
      throw new Error('有尚未提交的本地修改，请先提交后再拉取。');
    }
    const count = this.state.behind;
    // Git refuses overlapping untracked files. Never stash, reset, force or discard edits.
    await this.git(['-c', 'merge.autoStash=false', 'merge', '--no-edit', this.state.upstream!]);
    await this.inspect();
    return `拉取成功，已合并 ${count} 个团队提交。`;
  }

  private async pushCurrent(): Promise<string> {
    if (!this.state.ahead) return '当前没有待推送的提交。';
    const count = this.state.ahead;
    await this.git(['push', '--', this.state.remote!, `refs/heads/${this.state.branch!}:refs/heads/${this.state.remoteBranch!}`]);
    await this.inspect();
    return `推送成功，已推送 ${count} 个本地提交。`;
  }

  private async commitChanges(): Promise<void> {
    this.requireNoConflict();
    if (this.state.changes.some(change => !change.untracked && change.index !== ' ')) {
      throw new Error('暂存区已有手动暂存的修改，自动提交已暂停。请先完成手动提交。');
    }
    const files = this.previewCommitPaths();
    if (!files.length) return;
    // Arguments remain literal even for leading dashes, spaces and pathspec-looking filenames.
    await this.git(['add', '--all', '--', ...files]);
    await this.inspect();
    this.requireAutomaticTarget();
    const message = this.settings.commitMessage.replaceAll('{device}', os.hostname())
      .replaceAll('{time}', new Date(this.now()).toISOString());
    // --only prevents unrelated paths staged by another Git client from entering our commit.
    await this.git(['commit', '--only', '-m', message, '--', ...files]);
    this.lastActivityAt = this.now();
    await this.inspect();
    this.state.history.unshift({ at: this.now(), action: '自动提交', ok: true, message: `已提交 ${files.length} 个文件。` });
  }

  private vaultRelative(filePath: string): string | null {
    if (!this.state.root || !this.vaultPath) return null;
    const relative = path.relative(this.vaultPath, path.join(this.state.root, filePath)).replaceAll('\\', '/');
    return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? null : relative;
  }

  private excluded(vaultRelativePath: string, settings = this.settings): boolean {
    return isSyncPathExcluded(vaultRelativePath, [...settings.excludedPaths, `${this.deps.configDir}/`]);
  }

  private normalizeSettings(input: Partial<GitSyncSettings>): GitSyncSettings {
    const defaults = structuredClone(DEFAULT_GIT_SYNC_SETTINGS);
    return {
      autoPull: input.autoPull === true, autoPush: input.autoPush === true,
      autoCommit: input.autoCommit === true, pullOnOpen: input.pullOnOpen === true,
      intervalMinutes: [1, 5, 15, 30].includes(input.intervalMinutes ?? 0) ? input.intervalMinutes! : 5,
      idleMinutes: [1, 5, 10, 15].includes(input.idleMinutes ?? 0) ? input.idleMinutes! : 5,
      excludedPaths: [...new Set([
        ...(Array.isArray(input.excludedPaths)
          ? input.excludedPaths.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean)
          : defaults.excludedPaths),
        `${this.deps.configDir}/`,
      ])],
      commitMessage: typeof input.commitMessage === 'string' && input.commitMessage.trim()
        ? input.commitMessage.trim().slice(0, 500) : defaults.commitMessage,
      target: input.target && typeof input.target === 'object' ? input.target : null,
    };
  }

  private persist(settings = this.settings): void {
    if (!this.recordPath) throw new Error('当前知识库不支持保存 Git 同步配置。');
    writeJsonFile(this.recordPath, { settings, history: this.state.history.slice(0, 30) });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.getState());
  }
}
