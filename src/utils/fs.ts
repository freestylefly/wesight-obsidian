import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function executableFileExists(filePath: string): boolean {
  if (!fileExists(filePath)) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fileExists(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown, mode = 0o600): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
    // chmod is best-effort on some filesystems.
  }
  fs.renameSync(tmpPath, filePath);
}

export function safeRemoveDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Temporary cleanup should not mask the actual runtime result.
  }
}
