import os from 'os';
import path from 'path';

export function parseEnvironmentText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    result[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export function mergeEnvironment(base: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
  const merged = {
    ...base,
    ...parseEnvironmentText(text),
  };
  return {
    ...merged,
    PATH: executableSearchPath(merged.PATH),
  };
}

/**
 * GUI apps on macOS inherit a minimal PATH and cannot launch npm CLI shims
 * whose shebang uses `env node`. Keep the inherited/user-configured entries
 * first, then add the common per-user and package-manager executable folders.
 */
export function executableSearchPath(currentPath = ''): string {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
      currentPath,
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
    ]
    : [
      currentPath,
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.volta', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  return [...new Set(
    candidates.flatMap(value => value.split(path.delimiter)).filter(Boolean),
  )].join(path.delimiter);
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '********';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
