import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface CliOptions {
  pythonPath: string;
  runtimePath: string;
  vaultPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: unknown;
  error: string | null;
}

function buildEnv(runtimePath: string): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PYTHONPATH: existing ? `${runtimePath}${separator}${existing}` : runtimePath,
  };
}

export async function runCoreCommand(
  options: CliOptions,
  args: string[],
): Promise<CliResult> {
  const cwd = options.vaultPath;
  const env = buildEnv(options.runtimePath);
  const timeout = options.timeoutMs ?? 120_000;
  try {
    const { stdout, stderr } = await execFileAsync(
      options.pythonPath,
      ['-m', 'claude_obsidian', ...args],
      { cwd, env, timeout, signal: options.signal },
    );
    const text = stdout || stderr;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { ok: true, stdout, stderr, exitCode: 0, parsed, error: null };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    const stdout = typeof execError.stdout === 'string' ? execError.stdout : '';
    const stderr = typeof execError.stderr === 'string' ? execError.stderr : '';
    const text = stdout || stderr || execError.message || String(error);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return {
      ok: false,
      stdout,
      stderr,
      exitCode: typeof execError.code === 'number' ? execError.code : -1,
      parsed,
      error: text.slice(0, 800),
    };
  }
}

export async function runRuntimeScript(
  options: CliOptions,
  scriptRelativePath: string,
  args: string[],
): Promise<CliResult> {
  const env = buildEnv(options.runtimePath);
  try {
    const { stdout, stderr } = await execFileAsync(
      options.pythonPath,
      [path.join(options.runtimePath, scriptRelativePath), ...args],
      { cwd: options.vaultPath, env, timeout: options.timeoutMs ?? 120_000, signal: options.signal },
    );
    let parsed: unknown = null;
    try { parsed = JSON.parse(stdout || stderr); } catch { parsed = stdout || stderr; }
    return { ok: true, stdout, stderr, exitCode: 0, parsed, error: null };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    const stdout = value.stdout ?? '';
    const stderr = value.stderr ?? '';
    return {
      ok: false,
      stdout,
      stderr,
      exitCode: typeof value.code === 'number' ? value.code : -1,
      parsed: stdout || stderr,
      error: (stderr || stdout || value.message || String(error)).slice(0, 800),
    };
  }
}

export function commandDoctor(options: CliOptions): Promise<CliResult> {
  return runCoreCommand(options, ['doctor', '--vault', options.vaultPath]);
}

export function commandAdoptDryRun(options: CliOptions): Promise<CliResult> {
  return runCoreCommand(options, ['adopt', options.vaultPath]);
}

export function commandAdoptApply(
  options: CliOptions,
  approvalHash: string,
  generatedAt: string,
  operationId: string,
): Promise<CliResult> {
  return runCoreCommand(options, [
    'adopt',
    options.vaultPath,
    '--apply',
    '--generated-at',
    generatedAt,
    '--operation-id',
    operationId,
    '--approved-plan-sha256',
    approvalHash,
  ]);
}

export function commandLint(options: CliOptions): Promise<CliResult> {
  return runCoreCommand(options, ['lint', '--vault', options.vaultPath, '--format', 'json']);
}

export function commandTransactionInspect(
  options: CliOptions,
  bundlePath: string,
): Promise<CliResult> {
  return runCoreCommand(options, [
    'transaction',
    'inspect',
    '--vault',
    options.vaultPath,
    bundlePath,
  ]);
}

export function commandTransactionApply(
  options: CliOptions,
  bundlePath: string,
  approvalHash: string,
): Promise<CliResult> {
  return runCoreCommand(options, [
    'transaction',
    'apply',
    '--vault',
    options.vaultPath,
    '--approved-plan-sha256',
    approvalHash,
    bundlePath,
  ]);
}

export function commandTransactionRecover(options: CliOptions): Promise<CliResult> {
  return runCoreCommand(options, ['transaction', 'recover', '--vault', options.vaultPath]);
}

export function commandContracts(
  options: CliOptions,
  capability?: string,
  verify = false,
): Promise<CliResult> {
  const args = ['contracts', '--vault', options.vaultPath];
  if (verify) args.push('--verify');
  if (capability) args.push('--capability', capability);
  return runCoreCommand(options, args);
}

export function runtimeSkillPath(runtimePath: string, skillName: string): string {
  return path.join(runtimePath, 'skills', skillName, 'SKILL.md');
}

export function runtimeWikiReferencePath(runtimePath: string, referenceName: 'provenance' | 'operation-transactions'): string {
  return path.join(runtimePath, 'skills', 'wiki', 'references', `${referenceName}.md`);
}

export function loadRuntimeSkill(runtimePath: string, skillName: string): Promise<string> {
  return readFile(runtimeSkillPath(runtimePath, skillName), 'utf-8');
}

export function loadRuntimeWikiReference(
  runtimePath: string,
  referenceName: 'provenance' | 'operation-transactions',
): Promise<string> {
  return readFile(runtimeWikiReferencePath(runtimePath, referenceName), 'utf-8');
}
