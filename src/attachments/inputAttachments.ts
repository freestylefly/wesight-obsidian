import { promises as fs } from 'fs';
import path from 'path';

import type { ChatInputAttachment } from '../types';
import { createId } from '../utils/id';

export const MAX_TOP_LEVEL_INPUT_ATTACHMENTS = 100;

export const DEFAULT_DIRECTORY_IGNORE_PATTERNS = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  'coverage',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.*',
] as const;

interface ElectronFile extends File {
  path?: string;
  webkitRelativePath: string;
}

interface ElectronModule {
  webUtils?: {
    getPathForFile?: (file: File) => string;
  };
}

export function getDomFileAbsolutePath(file: File): string | null {
  let candidate = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is provided by the Obsidian host.
    const electron = require('electron') as ElectronModule;
    candidate = electron.webUtils?.getPathForFile?.(file) ?? '';
  } catch {
    // Older Obsidian/Electron builds expose the absolute path on File.path.
  }
  if (!candidate) candidate = (file as ElectronFile).path ?? '';
  return candidate ? normalizeAbsolutePath(candidate) : null;
}

export function deriveSelectedDirectoryPath(absoluteFilePath: string, webkitRelativePath: string): string | null {
  const relativeParts = webkitRelativePath.split(/[\\/]+/).filter(Boolean);
  if (relativeParts.length < 2) return null;
  const pathApi = isWindowsAbsolutePath(absoluteFilePath) ? path.win32 : path;
  let directory = pathApi.normalize(absoluteFilePath);
  for (let index = 1; index < relativeParts.length; index += 1) {
    directory = pathApi.dirname(directory);
  }
  return directory;
}

export function inputAttachmentPathKey(value: string): string {
  const pathApi = isWindowsAbsolutePath(value) ? path.win32 : path;
  const normalized = pathApi.normalize(value);
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

export async function createExternalInputAttachment(
  requestedPath: string,
  displayName?: string,
): Promise<ChatInputAttachment> {
  const absolutePath = normalizeAbsolutePath(requestedPath);
  const originalStat = await fs.lstat(absolutePath);
  if (originalStat.isSymbolicLink()) throw new Error(`无法添加符号链接：${absolutePath}`);
  if (!originalStat.isFile() && !originalStat.isDirectory()) {
    throw new Error(`仅支持普通文件或文件夹：${absolutePath}`);
  }
  if (originalStat.isFile() && originalStat.size <= 0) {
    throw new Error(`无法添加空文件：${absolutePath}`);
  }

  const canonicalPath = normalizeAbsolutePath(await fs.realpath(absolutePath));
  const canonicalStat = await fs.stat(canonicalPath);
  const imageMimeType = canonicalStat.isFile() ? await detectImageMimeType(canonicalPath) : null;
  const kind = canonicalStat.isDirectory()
    ? 'directory'
    : imageMimeType
      ? 'image'
      : 'file';
  const pathApi = isWindowsAbsolutePath(canonicalPath) ? path.win32 : path;
  const mimeType = kind === 'image'
    ? imageMimeType ?? undefined
    : inferMimeType(canonicalPath);

  return {
    id: createId('input-attachment'),
    kind,
    source: 'external',
    displayName: displayName?.trim() || pathApi.basename(canonicalPath),
    absolutePath: canonicalPath,
    mimeType,
    size: canonicalStat.isFile() ? canonicalStat.size : undefined,
    createdAt: Date.now(),
    ignoredPatterns: kind === 'directory' ? [...DEFAULT_DIRECTORY_IGNORE_PATTERNS] : undefined,
  };
}

export async function validateInputAttachment(attachment: ChatInputAttachment): Promise<string | null> {
  try {
    const stat = await fs.lstat(attachment.absolutePath);
    if (stat.isSymbolicLink()) return '源路径已变为符号链接';
    if (attachment.kind === 'directory') {
      return stat.isDirectory() ? null : '源文件夹不存在';
    }
    if (!stat.isFile()) return '源文件不存在';
    if (stat.size <= 0) return '源文件为空';
    return null;
  } catch {
    return attachment.kind === 'directory' ? '源文件夹不存在' : '源文件不存在';
  }
}

function normalizeAbsolutePath(value: string): string {
  if (isWindowsAbsolutePath(value)) return path.win32.normalize(value);
  return path.resolve(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

async function detectImageMimeType(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    if (
      header.length >= 8
      && header[0] === 0x89
      && header[1] === 0x50
      && header[2] === 0x4e
      && header[3] === 0x47
      && header[4] === 0x0d
      && header[5] === 0x0a
      && header[6] === 0x1a
      && header[7] === 0x0a
    ) return 'image/png';
    if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      header.length >= 12
      && header.subarray(0, 4).toString('ascii') === 'RIFF'
      && header.subarray(8, 12).toString('ascii') === 'WEBP'
    ) return 'image/webp';
    if (
      header.length >= 6
      && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))
    ) return 'image/gif';
    return null;
  } finally {
    await handle.close();
  }
}

function inferMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    case '.pdf': return 'application/pdf';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.zip': return 'application/zip';
    default: return undefined;
  }
}
