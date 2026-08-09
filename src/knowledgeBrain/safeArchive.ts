import fsp from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;

interface TarEntry {
  name: string;
  type: 'file' | 'directory';
  mode: number;
  content: Buffer;
}

function fieldText(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString('utf8').trim();
}

function octalField(block: Buffer, start: number, length: number): number {
  const text = fieldText(block, start, length).replace(/\0/g, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar 数字字段无效：${text}`);
  return Number.parseInt(text, 8);
}

function verifyChecksum(block: Buffer): void {
  const expected = octalField(block, 148, 8);
  let actual = 0;
  for (let i = 0; i < block.length; i++) actual += i >= 148 && i < 156 ? 32 : block[i];
  if (actual !== expected) throw new Error('tar 头校验失败。');
}

function safeEntryName(raw: string): string {
  if (!raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw)) {
    throw new Error(`压缩包路径无效：${raw || '(empty)'}`);
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, '')).replace(/\/$/, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`压缩包路径越界：${raw}`);
  }
  return normalized;
}

function validateGlobalPax(content: Buffer): void {
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    if (space < 0) throw new Error('PAX 全局头格式无效。');
    const lengthText = content.subarray(offset, space).toString('ascii');
    if (!/^\d{1,10}$/.test(lengthText)) throw new Error('PAX 全局头长度无效。');
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (length <= space - offset + 3 || end > content.length || content[end - 1] !== 10) {
      throw new Error('PAX 全局头记录截断。');
    }
    const record = content.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('PAX 全局头记录无效。');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key !== 'comment' || value.length > 1024 || /[\0\r\n]/.test(value)) {
      throw new Error(`PAX 全局头包含不允许的字段：${key}`);
    }
    offset = end;
  }
}

function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let total = 0;
  let rawEntryCount = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    verifyChecksum(header);
    const prefix = fieldText(header, 345, 155);
    const base = fieldText(header, 0, 100);
    const name = safeEntryName(prefix ? `${prefix}/${base}` : base);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`压缩包存在重复或大小写冲突路径：${name}`);
    names.add(key);
    const size = octalField(header, 124, 12);
    if (size > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`压缩包单文件超过 64 MiB：${name}`);
    const type = String.fromCharCode(header[156] || 48);
    if (type !== '0' && type !== '5' && type !== 'g') throw new Error(`压缩包包含不允许的链接或特殊条目：${name}`);
    if (type === '5' && size !== 0) throw new Error(`tar 目录条目大小无效：${name}`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) throw new Error(`tar 条目截断：${name}`);
    total += size;
    if (total > MAX_EXTRACTED_BYTES) throw new Error('压缩包解压总量超过 256 MiB。');
    rawEntryCount += 1;
    if (rawEntryCount > MAX_ARCHIVE_ENTRIES) throw new Error('压缩包条目超过 4096 个。');
    if (type === 'g') {
      validateGlobalPax(buffer.subarray(contentStart, contentEnd));
      offset = contentStart + Math.ceil(size / 512) * 512;
      continue;
    }
    entries.push({
      name,
      type: type === '5' ? 'directory' : 'file',
      mode: octalField(header, 100, 8),
      content: buffer.subarray(contentStart, contentEnd),
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error('压缩包为空。');
  return entries;
}

export async function extractSafeTarGz(archivePath: string, destination: string): Promise<string> {
  const compressed = await fsp.readFile(archivePath);
  if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error('运行包超过 64 MiB 下载限制。');
  const unpacked = gunzipSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES + 1 });
  if (unpacked.length > MAX_EXTRACTED_BYTES) throw new Error('压缩包解压总量超过 256 MiB。');
  const entries = parseTar(unpacked);
  const topLevels = new Set(entries.map(entry => entry.name.split('/')[0]));
  if (topLevels.size !== 1) throw new Error('压缩包必须只有一个顶层目录。');
  const top = [...topLevels][0];
  const topEntry = entries.find(entry => entry.name === top);
  if (!topEntry || topEntry.type !== 'directory') throw new Error('压缩包顶层条目必须是目录。');
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await fsp.chmod(destination, 0o700);
  const root = path.resolve(destination);
  for (const entry of entries) {
    const target = path.resolve(destination, ...entry.name.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`压缩包路径越界：${entry.name}`);
    if (entry.type === 'directory') {
      await fsp.mkdir(target, { recursive: true, mode: 0o700 });
      await fsp.chmod(target, 0o700);
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const mode = entry.mode & 0o100 ? 0o700 : 0o600;
      await fsp.writeFile(target, entry.content, { mode });
      await fsp.chmod(target, mode);
    }
  }
  return path.join(destination, top);
}
