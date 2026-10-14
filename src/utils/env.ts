import { lookup } from 'dns/promises';
import { isIP } from 'net';
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

export async function privateUrlProxyBypassHost(
  value: string | null | undefined,
  resolveAddresses: (hostname: string) => Promise<readonly string[]> = lookupAddresses,
): Promise<string | null> {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [hostname] : await resolveAddresses(hostname);
    return addresses.some(isPrivateNetworkAddress) ? hostname : null;
  } catch {
    return null;
  }
}

export function withNoProxyHost(env: NodeJS.ProcessEnv, hostname: string | null): NodeJS.ProcessEnv {
  if (!hostname) return env;
  const upper = appendNoProxyHost(env.NO_PROXY, hostname);
  const lower = appendNoProxyHost(env.no_proxy, hostname);
  if (upper === env.NO_PROXY && lower === env.no_proxy) return env;
  return { ...env, NO_PROXY: upper, no_proxy: lower };
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

async function lookupAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map(result => result.address);
}

function appendNoProxyHost(value: string | undefined, hostname: string): string {
  const entries = value?.split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
  if (entries.includes('*') || entries.includes(hostname)) return value ?? '';
  return [...entries, hostname].join(',');
}

function isPrivateNetworkAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return isPrivateNetworkAddress(normalized.slice('::ffff:'.length));
    }
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return false;
}
