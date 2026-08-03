import fs from 'fs';
import os from 'os';
import path from 'path';

import { RuntimeDiscovery } from '../src/runtime/discovery';

function makeExecutable(filePath: string, content = '#!/bin/sh\necho test\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('RuntimeDiscovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('prefers configured paths', () => {
    const configured = path.join(tempDir, 'custom-claude');
    makeExecutable(configured, '#!/bin/sh\necho claude 1.0\n');
    const discovery = new RuntimeDiscovery({
      env: { WESIGHT_HOME: tempDir, PATH: '' },
      configuredPaths: { claude: configured },
    });
    const status = discovery.resolve('claude');
    expect(status.found).toBe(true);
    expect(status.source).toBe('configured');
    expect(status.binaryPath).toBe(configured);
  });

  test('falls back to managed runtime before PATH', () => {
    const managed = path.join(tempDir, 'runtimes/codex/node_modules/.bin/codex');
    const pathBin = path.join(tempDir, 'bin/codex');
    makeExecutable(managed);
    makeExecutable(pathBin);
    const discovery = new RuntimeDiscovery({
      // Disable desktop-app discovery so the managed fallback is exercised.
      env: { WESIGHT_HOME: tempDir, PATH: path.dirname(pathBin), WESIGHT_CODEX_DESKTOP_ROOTS: '' },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('managed');
    expect(status.binaryPath).toBe(managed);
  });

  test('prefers the local PATH Codex CLI before the desktop-app CLI', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const bundled = process.platform === 'darwin'
      ? path.join(appRoot, 'Contents/Resources/codex')
      : process.platform === 'win32'
        ? path.join(appRoot, 'resources/codex.exe')
        : path.join(appRoot, 'resources/codex');
    const pathBin = path.join(tempDir, 'bin/codex');
    makeExecutable(bundled);
    makeExecutable(pathBin);
    const discovery = new RuntimeDiscovery({
      env: {
        WESIGHT_HOME: tempDir,
        PATH: path.dirname(pathBin),
        WESIGHT_CODEX_DESKTOP_ROOTS: appRoot,
      },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('path');
    expect(status.binaryPath).toBe(pathBin);
  });

  test('configured path still overrides the desktop-app Codex CLI', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const bundled = process.platform === 'darwin'
      ? path.join(appRoot, 'Contents/Resources/codex')
      : process.platform === 'win32'
        ? path.join(appRoot, 'resources/codex.exe')
        : path.join(appRoot, 'resources/codex');
    const configured = path.join(tempDir, 'custom-codex');
    makeExecutable(bundled);
    makeExecutable(configured);
    const discovery = new RuntimeDiscovery({
      env: { WESIGHT_HOME: tempDir, PATH: '', WESIGHT_CODEX_DESKTOP_ROOTS: appRoot },
      configuredPaths: { codex: configured },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('configured');
    expect(status.binaryPath).toBe(configured);
  });

  test('reports missing without installing', () => {
    const discovery = new RuntimeDiscovery({
      env: { WESIGHT_HOME: tempDir, PATH: '' },
    });
    const status = discovery.resolve('opencode');
    expect(status.found).toBe(false);
    expect(status.state).toBe('missing');
    expect(fs.existsSync(path.join(tempDir, 'runtimes/opencode'))).toBe(false);
  });
});
