import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AgentAdapter, buildAntigravityArgs } from '../src/runtime/adapter';
import {
  checkAntigravityAuth,
  createAntigravityStreamParser,
  extractAntigravityAuthUrl,
  normalizeAntigravityLoginCode,
  parseAntigravityModels,
  resetAntigravityAuthCache,
  startAntigravityLogin,
} from '../src/runtime/antigravity';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc';

let tempDir: string;

function writeScript(name: string, lines: string[]): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, ['#!/bin/sh', ...lines].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

const baseRequest: ChatTurnRequest = {
  conversationId: 'c1',
  agentId: 'antigravity',
  prompt: 'hello',
  cwd: '/tmp',
  configSource: 'localCli',
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-agy-'));
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  resetAntigravityAuthCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('antigravity stream parser', () => {
  test('maps init, text deltas, tools and failed results', () => {
    const parse = createAntigravityStreamParser();
    const lines = [
      '{"event":"init","conversation_id":"conv-1","init":{"model":"m"}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hel"}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"lo"}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"/a.txt"}}}}',
      '{"event":"result","result":{"status":"FAILED","response":"boom"}}',
    ];
    const events = lines.flatMap(line => parse(line));
    expect(events).toEqual([
      { type: 'session', sessionId: 'conv-1' },
      { type: 'text', content: 'Hel' },
      { type: 'text', content: 'lo' },
      { type: 'tool', toolCall: { id: 'agy-conv-1-2', name: 'write_file', status: 'completed', input: { Path: '/a.txt' } } },
      { type: 'error', message: 'Antigravity 运行失败（FAILED）', detail: 'boom' },
    ]);
  });

  test('successful result adds nothing', () => {
    const parse = createAntigravityStreamParser();
    expect(parse('{"event":"result","result":{"status":"SUCCESS","response":"done"}}')).toEqual([]);
  });
});

describe('antigravity helpers', () => {
  test('parses agy models output', () => {
    const models = parseAntigravityModels('Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
    expect(models).toEqual([
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    ]);
  });

  test('extracts only Google sign-in URLs', () => {
    expect(extractAntigravityAuthUrl(`  ${AUTH_URL}`)).toBe(AUTH_URL);
    expect(extractAntigravityAuthUrl('https://evil.example/o/oauth2/auth')).toBeNull();
  });

  test('accepts a bare code or the callback URL, rejects line breaks', () => {
    expect(normalizeAntigravityLoginCode(' 4/0AbC-d_e.f ')).toBe('4/0AbC-d_e.f');
    expect(normalizeAntigravityLoginCode('https://antigravity.google/oauth-callback?code=abc&state=s'))
      .toBe('https://antigravity.google/oauth-callback?code=abc&state=s');
    expect(normalizeAntigravityLoginCode('abc\nrm -rf')).toBeNull();
    expect(normalizeAntigravityLoginCode('https://evil.example/cb?code=1')).toBeNull();
  });

  test('builds print-mode args with model, resume and permission mode', () => {
    expect(buildAntigravityArgs({ ...baseRequest, model: 'gemini-x', sessionId: 'conv-1' }, 'hi')).toEqual([
      '--output-format', 'stream-json', '--model', 'gemini-x', '--conversation', 'conv-1', '--dangerously-skip-permissions', '-p=hi',
    ]);
    expect(buildAntigravityArgs({ ...baseRequest, accessMode: 'read-only' }, '-x')).toEqual([
      '--output-format', 'stream-json', '--mode', 'plan', '-p=-x',
    ]);
  });
});

describe('antigravity auth', () => {
  test('signed in when agy models exits 0', async () => {
    const bin = writeScript('agy', ['printf "Fetching available models...\\nmodel-a\\tModel A\\n"']);
    const status = await checkAntigravityAuth(bin, process.env, { force: true });
    expect(status.state).toBe('signedIn');
    expect(status.models).toEqual([{ id: 'model-a', label: 'Model A' }]);
  });

  test('signed out when agy asks to sign in', async () => {
    const bin = writeScript('agy', ['echo "Error: Please sign in to view available models." >&2', 'exit 1']);
    const status = await checkAntigravityAuth(bin, process.env, { force: true });
    expect(status.state).toBe('signedOut');
  });

  test('browser login: emits URL, forwards the code via stdin, resolves on exit 0', async () => {
    const received = path.join(tempDir, 'code.txt');
    const bin = writeScript('agy', [
      '[ "$1" = "acp" ] && [ "$2" = "--login" ] || exit 9',
      'echo "Open this link in a browser to log in with Google:"',
      'echo ""',
      `echo "  ${AUTH_URL}"`,
      'read code',
      `printf '%s' "$code" > ${JSON.stringify(received)}`,
      '[ "$code" = "good-code" ] && exit 0 || exit 1',
    ]);
    const session = startAntigravityLogin(bin);
    await expect(session.authorizationUrl).resolves.toBe(AUTH_URL);
    session.submit('good-code');
    await expect(session.completed).resolves.toBeUndefined();
    expect(fs.readFileSync(received, 'utf8')).toBe('good-code');
  });

  test('browser login rejects a wrong code', async () => {
    const bin = writeScript('agy', [`echo "${AUTH_URL}"`, 'read code', 'exit 1']);
    const session = startAntigravityLogin(bin);
    await session.authorizationUrl;
    session.submit('bad');
    await expect(session.completed).rejects.toThrow(/登录失败/);
  });
});

describe('antigravity adapter', () => {
  test('runs a turn and turns a sign-in prompt into a login error', async () => {
    const bin = writeScript('agy', [
      'echo "Authentication required. Please visit the URL to log in:" >&2',
      `echo "  ${AUTH_URL}" >&2`,
      'exit 1',
    ]);
    const adapter = new AgentAdapter({ agentId: 'antigravity', binaryPath: bin, sharedEnvironmentVariables: '', providerProfile: null });
    const events: RuntimeTurnEvent[] = [];
    adapter.onRuntimeEvent(event => events.push(event));
    await adapter.run({ ...baseRequest, cwd: tempDir });
    const errors = events.filter(event => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: '尚未登录 Antigravity。' });
  });

  test('streams text and captures the conversation id', async () => {
    const bin = writeScript('agy', [
      `echo '{"event":"init","conversation_id":"conv-9"}'`,
      `echo '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"hi"}}'`,
      `echo '{"event":"result","result":{"status":"SUCCESS"}}'`,
    ]);
    const adapter = new AgentAdapter({ agentId: 'antigravity', binaryPath: bin, sharedEnvironmentVariables: '', providerProfile: null });
    const events: RuntimeTurnEvent[] = [];
    adapter.onRuntimeEvent(event => events.push(event));
    await adapter.run({ ...baseRequest, cwd: tempDir });
    expect(events).toEqual([
      { type: 'session', sessionId: 'conv-9' },
      { type: 'text', content: 'hi' },
      { type: 'done' },
    ]);
  });
});
