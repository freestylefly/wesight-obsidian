import { parseClaudeStreamLine, parseCodexStreamLine, parseOpenCodeStreamLine } from '../src/runtime/parsers';

describe('stream parsers', () => {
  test('parses Claude assistant message content arrays', () => {
    const events = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    }));
    expect(events).toContainEqual({ type: 'text', content: 'hello' });
  });

  test('parses Codex deltas and errors', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.agent_message.delta',
      delta: 'hi',
    }))).toContainEqual({ type: 'text', content: 'hi' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'turn.failed',
      message: 'bad model',
    }))).toContainEqual({ type: 'error', message: 'bad model' });
  });

  test('parses OpenCode text payloads', () => {
    expect(parseOpenCodeStreamLine(JSON.stringify({
      type: 'message',
      text: 'done',
    }))).toContainEqual({ type: 'text', content: 'done' });
  });
});
