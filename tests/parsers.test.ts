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

  test('parses Claude nested content block deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '<section>' },
      },
    }))).toContainEqual({ type: 'text', content: '<section>' });
  });

  test('preserves whitespace-only Claude text deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' ' },
      },
    }))).toEqual([{ type: 'text', content: ' ' }]);
  });

  test('ignores Claude tool results that contain HTML examples', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: '<section><p>Skill 组件示例</p></section>',
        }],
      },
    }))).toEqual([]);
  });

  test('keeps assistant text while ignoring non-text content blocks', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_result', content: '<section>工具输出</section>' },
          { type: 'text', text: '<section>正文</section>' },
        ],
      },
    }))).toEqual([{ type: 'text', content: '<section>正文</section>' }]);
  });

  test('parses Claude result errors', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: Request rejected (429)',
    }))).toContainEqual({ type: 'error', message: 'API Error: Request rejected (429)' });
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

  test('parses Codex item.completed agent messages', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'OK' },
    }))).toContainEqual({ type: 'text', content: 'OK' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'message', content: [{ type: 'output_text', text: 'hi there' }] },
    }))).toContainEqual({ type: 'text', content: 'hi there' });
  });

  test('parses OpenCode text payloads', () => {
    expect(parseOpenCodeStreamLine(JSON.stringify({
      type: 'message',
      text: 'done',
    }))).toContainEqual({ type: 'text', content: 'done' });
    expect(parseOpenCodeStreamLine(JSON.stringify({
      type: 'part.updated',
      part: { type: 'text', text: '<section>' },
    }))).toContainEqual({ type: 'text', content: '<section>' });
  });
});
