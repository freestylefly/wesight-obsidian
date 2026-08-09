import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
const VERSIONED_NAMES = ['python3.14', 'python3.13', 'python3.12', 'python3.11'];
const HOMEBREW_PREFIXES = ['/opt/homebrew/bin', '/usr/local/bin'];
const CANDIDATES = [
  ...VERSIONED_NAMES,
  ...HOMEBREW_PREFIXES.flatMap(prefix => VERSIONED_NAMES.map(name => `${prefix}/${name}`)),
  'python3',
  ...HOMEBREW_PREFIXES.map(prefix => `${prefix}/python3`),
];

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export interface PythonDetection {
  ok: boolean;
  path: string | null;
  version: string | null;
  required: string;
  hint: string | null;
}

export function parsePythonVersion(stdout: string): string | null {
  const match = stdout.trim().match(/Python\s+(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export async function detectPython(required = '3.11.0'): Promise<PythonDetection> {
  let best: { path: string; version: string } | null = null;
  const errors: string[] = [];

  for (const candidate of CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      const version = parsePythonVersion(`${stdout}\n${stderr}`);
      if (!version) {
        errors.push(`${candidate}: 无法解析版本输出`);
        continue;
      }
      if (compareVersions(version, required) >= 0) {
        if (!best || compareVersions(version, best.version) > 0) {
          best = { path: candidate, version };
        }
      }
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (best) {
    return { ok: true, path: best.path, version: best.version, required, hint: null };
  }

  const detectedOld = errors.length < CANDIDATES.length;
  return {
    ok: false,
    path: null,
    version: null,
    required,
    hint: detectedOld
      ? `检测到的 Python 版本低于 ${required}。macOS 可通过 Homebrew 安装：\`brew install python@3.11\`，然后重新启动 Obsidian。`
      : `未检测到 Python 3.11+。macOS 可通过 Homebrew 安装：\`brew install python@3.11\`，然后重新启动 Obsidian。`,
  };
}
