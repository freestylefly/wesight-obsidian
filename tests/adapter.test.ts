import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

import { AgentAdapter } from '../src/runtime/adapter';
import type { ChatTurnRequest, ProviderProfile, RuntimeTurnEvent } from '../src/types';

const profile: ProviderProfile = {
  id: 'moonshot-profile',
  agentId: 'claude',
  name: 'Moonshot',
  apiKey: 'sk-test',
  baseUrl: 'https://api.moonshot.cn/anthropic',
  model: 'kimi-k3',
  defaultModel: 'kimi-k3',
  models: ['kimi-k3'],
  wireApi: 'chat',
  anthropicAuthMode: 'authToken',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

const request: ChatTurnRequest = {
  conversationId: 'conversation-1',
  agentId: 'claude',
  prompt: 'hello',
  cwd: process.cwd(),
  configSource: 'providerProfile',
  providerProfileId: profile.id,
};

describe('AgentAdapter Claude provider failures', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-adapter-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('emits one structured 429 error and stops a waiting Claude process', async () => {
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      'echo "API Error: Request rejected (429)·您多次使用无效令牌，请等待 120 秒后再试" >&2',
      'echo "(request id: request-123)" >&2',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      sharedEnvironmentVariables: '',
      providerProfile: profile,
    });

    const startedAt = Date.now();
    adapter.onRuntimeEvent(event => events.push(event));
    await adapter.run(request);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      statusCode: 429,
      retryAfterSeconds: 120,
      requestId: 'request-123',
      providerProfileId: profile.id,
    });
  });

  test('cancels a running Claude process without an exit-code error', async () => {
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      sharedEnvironmentVariables: '',
      providerProfile: profile,
    });

    adapter.onRuntimeEvent(event => events.push(event));
    const run = adapter.run(request);
    await delay(50);
    adapter.cancel();
    await run;

    expect(events).toContainEqual({ type: 'done' });
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  test('starts text-only turns without tools, customizations, or session persistence', async () => {
    const argsPath = path.join(tempDir, 'args.json');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      sharedEnvironmentVariables: '',
      providerProfile: profile,
    });

    await adapter.run({ ...request, textOnly: true });

    const args = fs.readFileSync(argsPath, 'utf8').split('\n');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--effort');
    expect(args).toContain('low');
    expect(args).toContain('--system-prompt');
  });

  test('limits read-only Claude turns to safe read tools and plan permission mode', async () => {
    const argsPath = path.join(tempDir, 'read-only-args.json');
    const binaryPath = path.join(tempDir, 'fake-claude-read-only');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      sharedEnvironmentVariables: '',
      providerProfile: profile,
    });

    await adapter.run({ ...request, accessMode: 'read-only', systemPrompt: 'Only inspect supplied evidence.' });

    const args = fs.readFileSync(argsPath, 'utf8').split('\n');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--disable-slash-commands');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Only inspect supplied evidence.');
  });
});
