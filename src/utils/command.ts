import { spawnSync } from 'child_process';
import path from 'path';

import { executableFileExists } from './fs';

export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    env,
    shell: false,
  });
  if (direct.status === 0) {
    const match = direct.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (match) return match;
  }

  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? [command, `${command}.exe`, `${command}.cmd`]
    : [command];
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (executableFileExists(candidate)) return candidate;
    }
  }

  return null;
}

export function readCommandVersion(commandPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const result = spawnSync(commandPath, ['--version'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
}
