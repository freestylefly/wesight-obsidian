import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';

import { extractSafeTarGz } from '../../src/knowledgeBrain/safeArchive';

interface Entry {
  name: string;
  type: '0' | '1' | '2' | '5' | 'g';
  content?: Buffer;
  mode?: number;
  declaredSize?: number;
}

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function archive(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    octal(entry.mode ?? 0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(entry.declaredSize ?? content.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(32, 148, 156);
    header.write(entry.type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = [...header].reduce((total, value) => total + value, 0);
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('safe runtime archive extraction', () => {
  let root: string;
  let archivePath: string;
  let destination: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-archive-'));
    archivePath = path.join(root, 'runtime.tar.gz');
    destination = path.join(root, 'out');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('extracts one private regular-file tree', async () => {
    const paxComment = Buffer.from('52 comment=a3b3df4539802e150e942266fd310c1b5978a3c0\n');
    fs.writeFileSync(archivePath, archive([
      { name: 'pax_global_header', type: 'g', content: paxComment },
      { name: 'runtime/', type: '5', mode: 0o755 },
      { name: 'runtime/skills/', type: '5', mode: 0o755 },
      { name: 'runtime/skills/SKILL.md', type: '0', mode: 0o644, content: Buffer.from('safe\n') },
      { name: 'runtime/run.py', type: '0', mode: 0o755, content: Buffer.from('#!/usr/bin/env python3\n') },
    ]));

    const extracted = await extractSafeTarGz(archivePath, destination);
    expect(fs.readFileSync(path.join(extracted, 'skills', 'SKILL.md'), 'utf8')).toBe('safe\n');
    expect(fs.statSync(path.join(extracted, 'skills', 'SKILL.md')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(extracted, 'run.py')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
  });

  test.each([
    ['path traversal', { name: 'runtime/../../escape', type: '0' as const, content: Buffer.from('x') }],
    ['symbolic link', { name: 'runtime/link', type: '2' as const }],
    ['hard link', { name: 'runtime/link', type: '1' as const }],
  ])('rejects %s entries before writing', async (_label, malicious) => {
    fs.writeFileSync(archivePath, archive([{ name: 'runtime/', type: '5' }, malicious]));
    await expect(extractSafeTarGz(archivePath, destination)).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });

  test('rejects portable case collisions and oversized declared files', async () => {
    fs.writeFileSync(archivePath, archive([
      { name: 'runtime/', type: '5' },
      { name: 'runtime/A.md', type: '0', content: Buffer.from('a') },
      { name: 'runtime/a.md', type: '0', content: Buffer.from('b') },
    ]));
    await expect(extractSafeTarGz(archivePath, destination)).rejects.toThrow('大小写冲突');

    fs.writeFileSync(archivePath, archive([
      { name: 'runtime/', type: '5' },
      { name: 'runtime/huge.bin', type: '0', declaredSize: 64 * 1024 * 1024 + 1 },
    ]));
    await expect(extractSafeTarGz(archivePath, destination)).rejects.toThrow('单文件超过 64 MiB');
  });

  test('rejects PAX metadata that could rewrite an entry path', async () => {
    const paxPath = Buffer.from('25 path=../../outside.md\n');
    fs.writeFileSync(archivePath, archive([
      { name: 'pax_global_header', type: 'g', content: paxPath },
      { name: 'runtime/', type: '5' },
    ]));
    await expect(extractSafeTarGz(archivePath, destination)).rejects.toThrow('不允许的字段');
  });
});
