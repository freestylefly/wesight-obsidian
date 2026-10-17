import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GitSyncService } from '../src/gitSync/service';

const cleanups: string[] = [];
const services: GitSyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const directory of cleanups.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-git-offline-'));
  cleanups.push(directory);
  const globalConfig = path.join(directory, 'global-config');
  fs.writeFileSync(globalConfig, '');
  const failurePath = path.join(directory, 'remote-failure');
  const commandLog = path.join(directory, 'commands');
  fs.writeFileSync(failurePath, '');
  fs.writeFileSync(commandLog, '');
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    WESIGHT_TEST_GIT_FAILURE: failurePath, WESIGHT_TEST_GIT_COMMANDS: commandLog,
  };
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const remote = path.join(directory, 'team.git');
  const vault = path.join(directory, 'vault');
  git(directory, 'init', '--bare', remote);
  git(directory, 'clone', remote, vault);
  git(vault, 'config', 'user.name', 'Offline Test');
  git(vault, 'config', 'user.email', 'offline@example.test');
  git(vault, 'config', 'commit.gpgsign', 'false');
  git(vault, 'config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  git(vault, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(vault, 'note.md'), 'original\n');
  git(vault, 'add', 'note.md');
  git(vault, 'commit', '-m', 'Initial');
  git(vault, 'push', '-u', 'origin', 'main');
  const gitPath = path.join(directory, 'git-wrapper');
  fs.writeFileSync(gitPath, `#!/bin/sh
printf '%s\\0' "$@" >> "$WESIGHT_TEST_GIT_COMMANDS"
printf '\\n' >> "$WESIGHT_TEST_GIT_COMMANDS"
case " $* " in
  *" fetch "*|*" push "*|*" ls-remote "*)
    if [ -s "$WESIGHT_TEST_GIT_FAILURE" ]; then
      cat "$WESIGHT_TEST_GIT_FAILURE" >&2
      exit 128
    fi
    ;;
esac
exec git "$@"
`, { mode: 0o755 });
  let time = 1_800_000_000_000;
  let online = true;
  const notify = vi.fn();
  const settingsDir = path.join(directory, 'settings');
  const recordPath = path.join(settingsDir, `${createHash('sha256').update(fs.realpathSync(vault)).digest('hex')}.json`);
  const makeService = () => {
    const service = new GitSyncService({
      vaultPath: vault, configDir: '.config-obsidian', settingsDir, gitPath, env,
      now: () => time, isOnline: () => online, notify,
    });
    services.push(service);
    return service;
  };
  return {
    vault, remote, git, notify, recordPath, makeService,
    advance: (minutes = 5) => { time += minutes * 60_000; },
    setOnline: (value: boolean) => { online = value; },
    failRemote: (detail: string) => { fs.writeFileSync(failurePath, detail); },
    clearCommands: () => { fs.writeFileSync(commandLog, ''); },
    commands: () => fs.readFileSync(commandLog, 'utf8'),
  };
}

describe('Git automatic synchronization while offline', () => {
  test('does not run Git, commit, notify or record automatic work while the device is offline', async () => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), autoPull: true, autoPush: true, autoCommit: true, idleMinutes: 1 });
    fs.writeFileSync(path.join(t.vault, 'note.md'), 'work while offline\n');
    const head = t.git(t.vault, 'rev-parse', 'HEAD');
    const history = service.getState().history;
    const record = fs.readFileSync(t.recordPath, 'utf8');
    t.setOnline(false); t.clearCommands(); t.advance();
    await service.tick();
    expect(t.commands()).toBe('');
    expect(t.git(t.vault, 'rev-parse', 'HEAD')).toBe(head);
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('original');
    expect(service.getState()).toMatchObject({ operation: null, error: null, remoteCheckedAt: null, history });
    expect(fs.readFileSync(t.recordPath, 'utf8')).toBe(record);
    expect(t.notify).not.toHaveBeenCalled();
  });

  test('skips pull-on-open while offline and resumes automatic synchronization after reconnecting', async () => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), pullOnOpen: true, autoPull: true, autoPush: true, autoCommit: true, idleMinutes: 1 });
    fs.writeFileSync(path.join(t.vault, 'note.md'), 'reconnected update\n');
    t.setOnline(false); t.clearCommands();
    await service.onVaultOpened();
    expect(t.commands()).toBe('');
    expect(t.notify).not.toHaveBeenCalled();
    expect(service.getState().error).toBeNull();
    t.setOnline(true); t.advance(); await service.tick();
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('reconnected update');
    expect(service.getState()).toMatchObject({ error: null, ahead: 0, behind: 0 });
  });

  test.each([
    "fatal: unable to access 'https://example.invalid/team.git/': Could not resolve host: example.invalid",
    'ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known',
    "fatal: unable to access 'https://example.invalid/team.git/': Failed to connect to example.invalid port 443 after 1000 ms: Couldn't connect to server",
    'ssh: connect to host example.invalid port 22: Network is unreachable',
    "fatal: unable to access 'https://example.invalid/team.git/': Recv failure: Connection reset by peer",
    "fatal: unable to access 'https://example.invalid/team.git/': Operation timed out after 1000 milliseconds with 0 bytes received",
  ])('silently skips an automatic remote connectivity failure: %s', async detail => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), autoPull: true });
    const history = service.getState().history;
    t.failRemote(detail); t.advance(); await service.tick();
    expect(t.commands()).toContain('fetch');
    expect(service.getState()).toMatchObject({ operation: null, error: null, remoteCheckedAt: null, history });
    expect(t.notify).not.toHaveBeenCalled();
    t.failRemote(''); t.advance(); await service.tick();
    expect(service.getState().remoteCheckedAt).not.toBeNull();
    expect(service.getState().error).toBeNull();
  });

  test('does not create a local automatic commit when the remote becomes unreachable before synchronization', async () => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), autoCommit: true, autoPull: true, autoPush: true, idleMinutes: 1 });
    fs.writeFileSync(path.join(t.vault, 'note.md'), 'save after reconnecting\n');
    const head = t.git(t.vault, 'rev-parse', 'HEAD');
    const history = service.getState().history;
    t.failRemote('fatal: Could not resolve host: example.invalid');
    t.advance(); await service.tick();
    expect(t.git(t.vault, 'rev-parse', 'HEAD')).toBe(head);
    expect(t.git(t.vault, 'diff', '--cached', '--name-only')).toBe('');
    expect(service.getState()).toMatchObject({ error: null, history });
    expect(t.notify).not.toHaveBeenCalled();
    t.failRemote(''); t.advance(); await service.tick();
    expect(t.git(t.remote, 'show', 'main:note.md')).toBe('save after reconnecting');
    expect(service.getState()).toMatchObject({ error: null, ahead: 0 });
  });

  test.each([
    "fatal: unable to access 'https://example.invalid/team.git/': The requested URL returned error: 403",
    "fatal: unable to access 'https://example.invalid/team.git/': SSL certificate problem: unable to get local issuer certificate",
    "fatal: unable to access 'https://example.invalid/team.git/': Received HTTP code 407 from proxy after CONNECT",
    "fatal: unable to access 'https://example.invalid/team.git/': Unexpected server response",
    'Permission denied (publickey). fatal: Could not read from remote repository.',
  ])('keeps actionable or unknown remote failures visible: %s', async detail => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), autoPull: true });
    t.failRemote(detail); t.advance(); await service.tick();
    expect(service.getState().error).toBeTruthy();
    expect(service.getState().history[0]).toMatchObject({ action: '自动同步', ok: false });
    expect(t.notify).toHaveBeenCalledOnce();
  });

  test('continues to report a failed manual remote request', async () => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    t.failRemote('fatal: Could not resolve host: example.invalid');
    const result = await service.check();
    expect(result.ok).toBe(false);
    expect(service.getState().error).toBeTruthy();
    expect(service.getState().history[0]).toMatchObject({ action: '检查远程更新', ok: false });
  });

  test('hides only clearly identified old automatic network failures in synchronization history', async () => {
    const t = repository(); const service = t.makeService(); await service.initialize();
    await service.saveSettings({ ...service.getSettings(), autoPull: true });
    const record = JSON.parse(fs.readFileSync(t.recordPath, 'utf8')) as Record<string, unknown>;
    const entry = (action: string, message: string, ok = false) => ({ at: 1_800_000_000_000, action, message, ok });
    const retained = [
      entry('自动同步', 'Git 操作失败。请检查本机 Git 凭据、仓库权限和 Git 日志后重试。'),
      entry('自动同步', 'GitHub 认证失败或无仓库权限，请检查本机 Git 登录凭据。'),
      entry('自动同步', '存在合并冲突，自动同步已暂停。请处理冲突并完成提交后重试。'),
      entry('检查远程更新', '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。'),
      entry('自动同步', '自动同步完成。', true),
    ];
    fs.writeFileSync(t.recordPath, JSON.stringify({ ...record, history: [
      entry('自动同步', '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。'),
      ...retained,
    ] }));
    const restored = t.makeService(); await restored.initialize();
    expect(restored.getState().history).toEqual(retained);
  });
});
