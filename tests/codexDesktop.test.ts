import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  codexDesktopBinaryCandidates,
  resolveCodexDesktopBinary,
} from '../src/runtime/codexDesktop';

function bundledPath(appRoot: string): string {
  if (process.platform === 'darwin') return path.join(appRoot, 'Contents/Resources/codex');
  if (process.platform === 'win32') return path.join(appRoot, 'resources/codex.exe');
  return path.join(appRoot, 'resources/codex');
}

function makeCodexBundle(appRoot: string, version: string): string {
  const binary = bundledPath(appRoot);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return binary;
}

describe('codexDesktop', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-codex-desktop-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns nothing when the override is empty', () => {
    expect(codexDesktopBinaryCandidates({ WESIGHT_CODEX_DESKTOP_ROOTS: '' })).toEqual([]);
    expect(resolveCodexDesktopBinary({ WESIGHT_CODEX_DESKTOP_ROOTS: '' })).toBeNull();
  });

  test('locates a single bundled Codex CLI', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const binary = makeCodexBundle(appRoot, '0.146.0');
    const env = { WESIGHT_CODEX_DESKTOP_ROOTS: appRoot };
    expect(codexDesktopBinaryCandidates(env)).toEqual([binary]);
    expect(resolveCodexDesktopBinary(env)).toBe(binary);
  });

  test('picks the newest CLI across several desktop apps', () => {
    const olderRoot = path.join(tempDir, 'ChatGPT.app');
    const newerRoot = path.join(tempDir, 'Codex.app');
    makeCodexBundle(olderRoot, '0.146.0-alpha.9.2');
    const newer = makeCodexBundle(newerRoot, '0.147.0');
    const env = {
      WESIGHT_CODEX_DESKTOP_ROOTS: [olderRoot, newerRoot].join(path.delimiter),
    };
    expect(resolveCodexDesktopBinary(env)).toBe(newer);
  });

  test('accepts an override pointing straight at a binary', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const binary = makeCodexBundle(appRoot, '0.146.0');
    const env = { WESIGHT_CODEX_DESKTOP_ROOTS: binary };
    expect(resolveCodexDesktopBinary(env)).toBe(binary);
  });
});
