import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GitSyncService } from '../src/gitSync/service';

const timeout = vi.hoisted(() => ({ command: null as string | null, code: null as string | null }));

vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    execFile: (...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      if (timeout.command && gitArgs.includes(timeout.command)) {
        const callback = args[args.length - 1] as (error: Error, stdout: string, stderr: string) => void;
        // Match execFile's actual timeout metadata, without waiting its full timeout.
        const error = Object.assign(new Error('Command failed: git'), { code: timeout.code, killed: true, signal: 'SIGTERM' });
        queueMicrotask(() => { callback(error, '', ''); });
        return {};
      }
      return Reflect.apply(original.execFile, undefined, args) as ReturnType<typeof original.execFile>;
    },
  };
});

const cleanups: string[] = [];
const services: GitSyncService[] = [];

afterEach(() => {
  timeout.command = null;
  timeout.code = null;
  for (const service of services.splice(0)) service.dispose();
  for (const directory of cleanups.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-git-timeout-'));
  cleanups.push(directory);
  const globalConfig = path.join(directory, 'global-config');
  fs.writeFileSync(globalConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const remote = path.join(directory, 'team.git');
  const vault = path.join(directory, 'vault');
  git(directory, 'init', '--bare', remote);
  git(directory, 'clone', remote, vault);
  git(vault, 'config', 'user.name', 'Timeout Test');
  git(vault, 'config', 'user.email', 'timeout@example.test');
  git(vault, 'config', 'commit.gpgsign', 'false');
  git(vault, 'config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  git(vault, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(vault, 'note.md'), 'original\n');
  git(vault, 'add', 'note.md');
  git(vault, 'commit', '-m', 'Initial');
  git(vault, 'push', '-u', 'origin', 'main');
  let time = 1_800_000_000_000;
  const notify = vi.fn();
  const service = new GitSyncService({
    vaultPath: vault, configDir: '.config-obsidian', settingsDir: path.join(directory, 'settings'), env,
    now: () => time, isOnline: () => true, notify,
  });
  services.push(service);
  return { vault, git, notify, service, advance: () => { time += 5 * 60_000; } };
}

describe('Git command timeout handling', () => {
  test('silently skips an automatic remote fetch timeout with a generic execFile error message', async () => {
    const t = repository(); await t.service.initialize();
    await t.service.saveSettings({ ...t.service.getSettings(), autoPull: true });
    const history = t.service.getState().history;
    timeout.command = 'fetch'; t.advance(); await t.service.tick();
    expect(t.service.getState()).toMatchObject({ operation: null, error: null, remoteCheckedAt: null, history });
    expect(t.notify).not.toHaveBeenCalled();
  });

  test('keeps a timed-out local automatic commit visible for investigation', async () => {
    const t = repository(); await t.service.initialize();
    await t.service.saveSettings({ ...t.service.getSettings(), autoCommit: true, idleMinutes: 1 });
    fs.writeFileSync(path.join(t.vault, 'note.md'), 'local update\n');
    const head = t.git(t.vault, 'rev-parse', 'HEAD');
    timeout.command = 'commit'; t.advance(); await t.service.tick();
    expect(t.service.getState().error).toBeTruthy();
    expect(t.service.getState().history[0]).toMatchObject({ action: '自动同步', ok: false });
    expect(t.notify).toHaveBeenCalledOnce();
    expect(t.git(t.vault, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('keeps an automatic remote output-buffer failure visible even if the child process was killed', async () => {
    const t = repository(); await t.service.initialize();
    await t.service.saveSettings({ ...t.service.getSettings(), autoPull: true });
    timeout.command = 'fetch'; timeout.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    t.advance(); await t.service.tick();
    expect(t.service.getState().error).toBeTruthy();
    expect(t.service.getState().history[0]).toMatchObject({ action: '自动同步', ok: false });
    expect(t.notify).toHaveBeenCalledOnce();
  });
});
