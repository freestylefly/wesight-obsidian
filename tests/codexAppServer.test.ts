import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexAppServerClient } from '../src/runtime/codexAppServer';

describe('CodexAppServerClient', () => {
  let tempDir: string;
  let executablePath: string;

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-app-server-'));
    executablePath = path.join(tempDir, 'fake-codex');
    fs.writeFileSync(executablePath, [
      '#!/usr/bin/env node',
      "let buffer = '';",
      'let initialized = false;',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      '  buffer += chunk;',
      "  let newline = buffer.indexOf('\\n');",
      '  while (newline >= 0) {',
      '    const line = buffer.slice(0, newline);',
      '    buffer = buffer.slice(newline + 1);',
      '    if (line.trim()) handle(JSON.parse(line));',
      "    newline = buffer.indexOf('\\n');",
      '  }',
      '});',
      'function send(value, split = false) {',
      "  const text = JSON.stringify(value) + '\\n';",
      '  if (!split) return process.stdout.write(text);',
      '  const middle = Math.floor(text.length / 2);',
      '  process.stdout.write(text.slice(0, middle));',
      '  setTimeout(() => process.stdout.write(text.slice(middle)), 5);',
      '}',
      'function handle(message) {',
      "  if (message.method === 'initialize') return send({ id: message.id, result: { ok: true } }, true);",
      "  if (message.method === 'initialized') { initialized = true; return; }",
      "  if (!initialized) return send({ id: message.id, error: { code: -32000, message: 'initialized notification missing' } });",
      "  if (message.method === 'fast') return send({ id: message.id, result: 'fast' });",
      "  if (message.method === 'slow') return setTimeout(() => send({ id: message.id, result: 'slow' }), 20);",
      "  if (message.method === 'malformed') { process.stdout.write('not-json\\n'); return send({ id: message.id, result: 'ok' }); }",
      "  if (message.method === 'crash') return process.exit(7);",
      "  if (message.method === 'never') return;",
      '}',
    ].join('\n'), { mode: 0o755 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('handshakes over split JSONL and routes out-of-order responses by id', async () => {
    const client = new CodexAppServerClient();
    await client.connect({ executablePath });

    const [slow, fast] = await Promise.all([
      client.request('slow'),
      client.request('fast'),
    ]);

    expect(slow).toBe('slow');
    expect(fast).toBe('fast');
    expect(client.isReady).toBe(true);
    await client.disconnect();
    expect(client.isRunning).toBe(false);
  });

  test('isolates malformed stdout and enforces request timeouts', async () => {
    const client = new CodexAppServerClient();
    const logs: string[] = [];
    client.on('log', (_level: string, message: string) => logs.push(message));
    await client.connect({ executablePath });

    await expect(client.request('malformed')).resolves.toBe('ok');
    await expect(client.request('never', {}, 20)).rejects.toThrow('timed out');
    expect(logs.some(message => message.includes('non-JSON'))).toBe(true);
    await client.disconnect();
  });

  test('rejects pending requests when the process crashes', async () => {
    const client = new CodexAppServerClient();
    await client.connect({ executablePath });

    await expect(client.request('crash')).rejects.toThrow('exited with exit code 7');
    expect(client.isReady).toBe(false);
    await client.connect({ executablePath });
    await expect(client.request('fast')).resolves.toBe('fast');
    await client.disconnect();
  });
});
