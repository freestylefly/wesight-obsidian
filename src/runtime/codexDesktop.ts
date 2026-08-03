import os from 'os';
import path from 'path';

import { readCommandVersion } from '../utils/command';
import { executableFileExists, fileExists } from '../utils/fs';

/**
 * The official ChatGPT / Codex desktop apps ship a bundled Codex CLI that the
 * apps keep auto-updated. Reusing it in codex "local mode" means the plugin
 * always runs the latest CLI the user already has installed, without WeSight
 * having to manage its own copy.
 */

/** App bundle roots (or direct binary paths) probed for a bundled Codex CLI. */
export function codexDesktopAppRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.WESIGHT_CODEX_DESKTOP_ROOTS;
  if (override !== undefined) {
    // An empty override disables desktop discovery (used by tests and opt-outs).
    return override.split(path.delimiter).map(entry => entry.trim()).filter(Boolean);
  }

  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/ChatGPT.app',
      path.join(home, 'Applications', 'ChatGPT.app'),
      '/Applications/Codex.app',
      path.join(home, 'Applications', 'Codex.app'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    const programFiles = env.PROGRAMFILES?.trim() || 'C:\\Program Files';
    return [
      path.join(localAppData, 'Programs', 'ChatGPT'),
      path.join(programFiles, 'ChatGPT'),
      path.join(localAppData, 'Programs', 'Codex'),
    ];
  }
  return [
    '/opt/ChatGPT',
    path.join(home, '.local', 'share', 'ChatGPT'),
    '/opt/Codex',
  ];
}

/** Resolves the bundled Codex CLI path for a given app root (or direct binary). */
function bundledBinaryForRoot(root: string): string {
  // An override may point straight at a binary rather than an .app/root dir.
  if (fileExists(root)) return root;
  if (process.platform === 'darwin') {
    return path.join(root, 'Contents', 'Resources', 'codex');
  }
  if (process.platform === 'win32') {
    return path.join(root, 'resources', 'codex.exe');
  }
  return path.join(root, 'resources', 'codex');
}

/** Existing, executable Codex CLI binaries bundled in a desktop app. */
export function codexDesktopBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const root of codexDesktopAppRoots(env)) {
    const binary = bundledBinaryForRoot(root);
    if (seen.has(binary)) continue;
    seen.add(binary);
    if (executableFileExists(binary)) {
      candidates.push(binary);
    }
  }
  return candidates;
}

/** Numeric sort key for a `codex-cli 0.146.0-alpha.9.2` style version string. */
function versionSortKey(version: string): number[] {
  return (version.match(/\d+/g) ?? []).map(Number);
}

function compareVersionKeys(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Path to the newest Codex CLI bundled in an installed ChatGPT / Codex desktop
 * app, or null when none is present. When several apps are installed the one
 * reporting the highest `--version` wins so local mode always runs the latest.
 */
export function resolveCodexDesktopBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = codexDesktopBinaryCandidates(env);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let best: { path: string; key: number[] } | null = null;
  for (const candidate of candidates) {
    const version = readCommandVersion(candidate, env);
    const key = version ? versionSortKey(version) : [];
    if (!best || compareVersionKeys(key, best.key) > 0) {
      best = { path: candidate, key };
    }
  }
  return best?.path ?? candidates[0];
}
