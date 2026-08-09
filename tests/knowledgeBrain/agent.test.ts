import type { ChatTurnRequest, RuntimeTurnEvent } from '../../src/types';
import type { RuntimeManager } from '../../src/runtime/runtimeManager';
import { runPlanningTurn, runQueryTurn } from '../../src/knowledgeBrain/agent';

class CapturingRuntime {
  requests: ChatTurnRequest[] = [];

  async runTurn(request: ChatTurnRequest, listener: (event: RuntimeTurnEvent) => void): Promise<void> {
    this.requests.push(request);
    listener({ type: 'session', sessionId: 'kb-session' });
    listener({ type: 'text', content: 'result' });
    listener({ type: 'done', sessionId: 'kb-session' });
  }
}

describe('knowledge agent isolation', () => {
  test('runs planning as text-only read-only work without a reusable chat session', async () => {
    const runtime = new CapturingRuntime();
    const result = await runPlanningTurn(runtime as unknown as RuntimeManager, 'codex', 'system', 'prompt', '/vault', null);

    expect(result).toEqual({ text: 'result', sessionId: 'kb-session' });
    expect(runtime.requests[0]).toMatchObject({
      agentId: 'codex',
      cwd: '/vault',
      textOnly: true,
      accessMode: 'read-only',
      logPolicy: 'metadata-only',
    });
    expect(runtime.requests[0].planMode).toBeUndefined();
    expect(runtime.requests[0].sessionId).toBeUndefined();
  });

  test('keeps knowledge query sessions read-only and conversation-scoped', async () => {
    const runtime = new CapturingRuntime();
    const events: RuntimeTurnEvent[] = [];
    await runQueryTurn(runtime as unknown as RuntimeManager, {
      agentId: 'claude',
      conversationId: 'kb:conversation-1',
      systemPrompt: 'system',
      prompt: 'question',
      cwd: '/vault',
      sessionId: 'knowledge-session',
      signal: null,
    }, event => events.push(event));

    expect(runtime.requests[0]).toMatchObject({
      conversationId: 'kb:conversation-1',
      sessionId: 'knowledge-session',
      accessMode: 'read-only',
      logPolicy: 'metadata-only',
    });
    expect(events).toContainEqual({ type: 'text', content: 'result' });
  });
});
