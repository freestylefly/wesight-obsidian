import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { KnowledgeRuntimeManifest } from './manifest';
import { KNOWLEDGE_BRAIN_RUNTIME_DIR } from './manifest';
import { wesightHome } from '../paths';
import { extractSafeTarGz, MAX_ARCHIVE_BYTES } from './safeArchive';

const execFileAsync = promisify(execFile);
const ALLOWED_DOWNLOAD_HOSTS = new Set(['github.com', 'codeload.github.com']);

export interface InstallRecord {
  schema: 'wesight.knowledge-runtime-install.v1';
  id: string;
  version: string;
  commit: string;
  installedAt: number;
  pythonPath: string;
  pythonVersion: string;
  runtimePath: string;
  sha256: string;
}

export interface InstallResult {
  ok: boolean;
  record: InstallRecord | null;
  error: string | null;
}

export function runtimeInstallDir(manifest: KnowledgeRuntimeManifest): string {
  return path.join(wesightHome(), KNOWLEDGE_BRAIN_RUNTIME_DIR, manifest.id, manifest.version);
}

export function runtimeTempDir(manifest: KnowledgeRuntimeManifest): string {
  return path.join(wesightHome(), 'tmp', 'knowledge-brain', `download-${manifest.id}-${manifest.version}-${Date.now()}`);
}

export function installRecordPath(): string {
  return path.join(wesightHome(), 'knowledge-brain', 'install.json');
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function downloadTo(
  sourceUrl: string,
  destination: string,
  progress?: (message: string) => void,
  signal?: AbortSignal,
  redirects = 0,
): Promise<void> {
  if (redirects > 5) throw new Error('运行包下载重定向次数过多。');
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`运行包下载域名不受信任：${url.hostname}`);
  }
  await ensurePrivateDir(path.dirname(destination));
  await new Promise<void>((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'WeSight-Knowledge-Brain' }, signal }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        void downloadTo(redirected, destination, progress, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`下载失败：HTTP ${status}`));
        return;
      }
      const declared = Number(response.headers['content-length'] ?? 0);
      if (declared > MAX_ARCHIVE_BYTES) {
        response.destroy();
        reject(new Error('运行包超过 64 MiB 下载限制。'));
        return;
      }
      const output = fs.createWriteStream(destination, { mode: 0o600 });
      let downloaded = 0;
      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (downloaded > MAX_ARCHIVE_BYTES) {
          response.destroy(new Error('运行包超过 64 MiB 下载限制。'));
          return;
        }
        if (declared > 0) progress?.(`已下载 ${Math.min(100, Math.round(downloaded / declared * 100))}%`);
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      response.pipe(output);
    });
    request.on('error', reject);
  });
  await fsp.chmod(destination, 0o600);
}

async function validateExtracted(root: string, manifest: KnowledgeRuntimeManifest, pythonPath: string, signal?: AbortSignal): Promise<void> {
  const required = [
    'claude_obsidian/__main__.py',
    'claude_obsidian/__init__.py',
    'scripts/claude-obsidian.py',
    'scripts/retrieve.py',
    'skills/wiki-ingest/SKILL.md',
    'skills/wiki-query/SKILL.md',
    'skills/save/SKILL.md',
    'LICENSE',
  ];
  for (const relative of required) {
    const candidate = path.join(root, relative);
    const stat = await fsp.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`运行包缺少必要文件：${relative}`);
  }
  const env = { ...process.env, PYTHONPATH: root };
  const version = await execFileAsync(pythonPath, ['-m', 'claude_obsidian', '--version'], {
    cwd: root,
    env,
    timeout: 30_000,
    signal,
  });
  if (version.stdout.trim() !== manifest.version) {
    throw new Error(`运行包版本不匹配：期望 ${manifest.version}，实际 ${version.stdout.trim() || '(empty)'}`);
  }
  const validation = await execFileAsync(pythonPath, ['-m', 'claude_obsidian', 'package', 'validate'], {
    cwd: root,
    env,
    timeout: 120_000,
    signal,
  });
  const parsed = JSON.parse(validation.stdout) as { ok?: unknown };
  if (parsed.ok !== true) throw new Error('运行包 package validate 未通过。');
  const contracts = await execFileAsync(pythonPath, ['-m', 'claude_obsidian', 'contracts', '--check-only'], {
    cwd: root,
    env,
    timeout: 120_000,
    signal,
  });
  const contractResult = JSON.parse(contracts.stdout) as { valid?: unknown };
  if (contractResult.valid !== true) throw new Error('运行包 contracts --check-only 未通过。');
}

function isInstallRecord(value: unknown): value is InstallRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'wesight.knowledge-runtime-install.v1'
    && ['id', 'version', 'commit', 'pythonPath', 'pythonVersion', 'runtimePath', 'sha256'].every(key => typeof record[key] === 'string')
    && typeof record.installedAt === 'number';
}

export async function readInstallRecord(): Promise<InstallRecord | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(installRecordPath(), 'utf8')) as unknown;
    return isInstallRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeInstallRecord(record: InstallRecord): Promise<void> {
  const target = installRecordPath();
  await ensurePrivateDir(path.dirname(target));
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600);
}

export async function installKnowledgeRuntime(
  pythonPath: string,
  pythonVersion: string,
  manifest: KnowledgeRuntimeManifest,
  progress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<InstallResult> {
  const existing = await readInstallRecord();
  if (
    existing
    && existing.id === manifest.id
    && existing.version === manifest.version
    && existing.commit === manifest.commit
    && existing.sha256 === manifest.sha256
    && path.resolve(existing.runtimePath) === path.resolve(runtimeInstallDir(manifest))
    && await fsp.stat(existing.runtimePath).then(stat => stat.isDirectory(), () => false)
  ) {
    try {
      await validateExtracted(existing.runtimePath, manifest, pythonPath, signal);
      const currentRecord = { ...existing, pythonPath, pythonVersion };
      if (existing.pythonPath !== pythonPath || existing.pythonVersion !== pythonVersion) await writeInstallRecord(currentRecord);
      return { ok: true, record: currentRecord, error: null };
    } catch {
      progress?.('现有运行包校验失败，正在重新安装…');
    }
  }

  const tempDir = runtimeTempDir(manifest);
  const archivePath = path.join(tempDir, 'runtime.tar.gz');
  const extractedDir = path.join(tempDir, 'extracted');
  const finalDir = runtimeInstallDir(manifest);
  const backupDir = `${finalDir}.rollback-${Date.now()}`;
  let backedUp = false;
  let installed = false;
  try {
    await ensurePrivateDir(tempDir);
    progress?.('正在下载知识大脑运行包…');
    await downloadTo(manifest.downloadUrl, archivePath, progress, signal);
    progress?.('正在校验 SHA-256…');
    const actualSha = await sha256File(archivePath);
    if (actualSha !== manifest.sha256) throw new Error(`SHA-256 校验失败：实际 ${actualSha}`);
    progress?.('正在安全检查并解压运行包…');
    const root = await extractSafeTarGz(archivePath, extractedDir);
    progress?.('正在校验版本与运行包契约…');
    await validateExtracted(root, manifest, pythonPath, signal);
    await ensurePrivateDir(path.dirname(finalDir));
    try {
      await fsp.rename(finalDir, backupDir);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fsp.rename(root, finalDir);
    installed = true;
    const record: InstallRecord = {
      schema: 'wesight.knowledge-runtime-install.v1',
      id: manifest.id,
      version: manifest.version,
      commit: manifest.commit,
      installedAt: Date.now(),
      pythonPath,
      pythonVersion,
      runtimePath: finalDir,
      sha256: manifest.sha256,
    };
    await writeInstallRecord(record);
    if (backedUp) await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, record, error: null };
  } catch (error) {
    if (installed) await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp) await fsp.rename(backupDir, finalDir).catch(() => undefined);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, record: null, error: error instanceof Error ? error.message : String(error) };
  }
}
