import { EventEmitter } from 'events';
import { setTimeout as delay } from 'timers/promises';

import type { CodexAppServerClient } from '../src/runtime/codexAppServer';
import { CodexAppServerRuntime } from '../src/runtime/codexRuntime';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';

class FakeAppServerClient extends EventEmitter {
  isReady = false;
  connectedExecutablePath: string | null = null;
  requests: Array<{ method: string; params: unknown }> = [];
  imageGeneration = true;
  emitWarning = false;
  private threadNumber = 0;

  async connect(options: { executablePath: string }): Promise<void> {
    this.isReady = true;
    this.connectedExecutablePath = options.executablePath;
  }

  async disconnect(): Promise<void> {
    this.isReady = false;
    this.connectedExecutablePath = null;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const value = params as Record<string, unknown>;
    if (method === 'model/list') {
      if (value.cursor === 'page-2') {
        return {
          data: [{ id: 'model-b', model: 'model-b', displayName: 'Model B', isDefault: true }],
          nextCursor: null,
        };
      }
      return {
        data: [{ id: 'model-a', model: 'model-a', displayName: 'Model A', isDefault: false }],
        nextCursor: 'page-2',
      };
    }
    if (method === 'config/read') return { config: { model: 'model-a' } };
    if (method === 'account/read') return { account: { type: 'chatgpt' }, authMode: 'chatgpt' };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: this.imageGeneration, webSearch: false };
    if (method === 'thread/start') {
      this.threadNumber += 1;
      return { thread: { id: `thread-${this.threadNumber}`, model: 'model-a' } };
    }
    if (method === 'thread/resume') return { thread: { id: value.threadId, model: 'model-a' } };
    if (method === 'turn/start') {
      const threadId = String(value.threadId);
      const turnId = `turn-${threadId}`;
      const input = value.input as Array<Record<string, string>>;
      const prompt = input.find(item => item.type === 'text')?.text ?? '';
      if (this.emitWarning) {
        process.nextTick(() => this.emit('notification', 'warning', {
          threadId,
          message: 'Model metadata fallback warning',
        }));
      }
      if (prompt !== 'HOLD') {
        process.nextTick(() => this.emitCompletedTurn(threadId, turnId, prompt));
      }
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      process.nextTick(() => {
        this.emit('notification', 'turn/completed', {
          threadId: value.threadId,
          turn: { id: value.turnId, status: 'interrupted' },
        });
      }, 0);
      return {};
    }
    return {};
  }

  respond(): void {}
  reject(): void {}

  private emitCompletedTurn(threadId: string, turnId: string, prompt: string): void {
    const messageId = `message-${threadId}`;
    const reply = `reply:${prompt}`;
    this.emit('notification', 'item/agentMessage/delta', { threadId, turnId, itemId: messageId, delta: reply });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'thinking', id: `thinking-${threadId}`, text: 'reasoning text' },
    });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: messageId, text: reply },
    });
    this.emit('notification', 'item/started', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: `command-${threadId}`, command: 'pwd', status: 'inProgress' },
    });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: `command-${threadId}`, command: 'pwd', status: 'completed', aggregatedOutput: '/vault' },
    });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: `image-${threadId}`,
        status: 'completed',
        savedPath: `/tmp/${threadId}.png`,
        revisedPrompt: `revised:${prompt}`,
      },
    });
    this.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
  }
}

const connection = {
  binaryPath: '/fake/codex',
  binarySource: 'desktopApp' as const,
  version: 'codex-cli 1.0.0',
  env: {},
};

function request(prompt: string): ChatTurnRequest {
  return {
    conversationId: prompt,
    agentId: 'codex',
    prompt,
    cwd: '/vault',
    configSource: 'localCli',
    attachments: [{ vaultPath: 'image.png', absolutePath: '/vault/image.png', mimeType: 'image/png' }],
  };
}

describe('CodexAppServerRuntime', () => {
  test('reads paginated models and gives config/read precedence over the default model', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    const status = await runtime.refreshStatus(connection);

    expect(status.state).toBe('ready');
    expect(status.currentModelId).toBe('model-a');
    expect(status.currentModel?.displayName).toBe('Model A');
    expect(status.models.map(model => model.id)).toEqual(['model-a', 'model-b']);
    expect(status.authenticated).toBe(true);
    expect(status.imageGeneration).toBe(true);
    expect(status.webSearch).toBe(false);
    await runtime.shutdown();
  });

  test('isolates concurrent threads, deduplicates completed text, and emits tools and image artifacts', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const first: RuntimeTurnEvent[] = [];
    const second: RuntimeTurnEvent[] = [];

    await Promise.all([
      runtime.runTurn(request('FIRST'), connection, event => first.push(event)),
      runtime.runTurn(request('SECOND'), connection, event => second.push(event)),
    ]);

    expect(first.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'reply:FIRST' }]);
    expect(second.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'reply:SECOND' }]);
    expect(first.filter(event => event.type === 'tool')).toHaveLength(3);
    const firstSession = first.find((event): event is Extract<RuntimeTurnEvent, { type: 'session' }> => event.type === 'session');
    const firstThreadId = firstSession?.sessionId ?? '';
    expect(first.filter(event => event.type === 'reasoning')).toEqual([{ type: 'reasoning', content: 'reasoning text', id: `thinking-${firstThreadId}` }]);
    expect(first.find(event => event.type === 'artifact')).toMatchObject({
      type: 'artifact',
      artifact: {
        itemId: `image-${firstThreadId}`,
        kind: 'image',
        sourcePath: `/tmp/${firstThreadId}.png`,
        revisedPrompt: 'revised:FIRST',
      },
    });
    const threadStart = client.requests.find(entry => entry.method === 'thread/start');
    const turnStart = client.requests.find(entry => {
      if (entry.method !== 'turn/start') return false;
      const params = entry.params as { input?: Array<{ type: string; text?: string }> };
      return params.input?.some(item => item.type === 'text' && item.text === 'FIRST');
    });
    expect(threadStart?.params).not.toHaveProperty('model');
    expect(turnStart?.params).not.toHaveProperty('model');
    expect(turnStart?.params).toMatchObject({
      input: [
        { type: 'text', text: 'FIRST' },
        { type: 'localImage', path: '/vault/image.png' },
      ],
    });
    await runtime.shutdown();
  });

  test('resumes an existing thread, sends plan collaboration mode, and interrupts through AbortSignal', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'existing-thread',
      planMode: true,
      signal: controller.signal,
    }, connection, event => events.push(event));

    await delay(10);
    controller.abort();
    await run;

    expect(client.requests.find(entry => entry.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'existing-thread',
    });
    expect(client.requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'model-a', developer_instructions: null },
      },
    });
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'existing-thread' });
    await runtime.shutdown();
  });

  test('keeps normal chat available when image generation capability is missing', async () => {
    const client = new FakeAppServerClient();
    client.imageGeneration = false;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    const status = await runtime.refreshStatus(connection);
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('CHAT_ONLY'), connection, event => events.push(event));

    expect(status.imageGeneration).toBe(false);
    expect(events).toContainEqual({ type: 'text', content: 'reply:CHAT_ONLY' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'thread-1' });
    await runtime.shutdown();
  });

  test('does not turn non-fatal App Server warnings into chat errors', async () => {
    const client = new FakeAppServerClient();
    client.emitWarning = true;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn(request('WARNING_ONLY'), connection, event => events.push(event));

    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text', content: 'reply:WARNING_ONLY' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    await runtime.shutdown();
  });
});
