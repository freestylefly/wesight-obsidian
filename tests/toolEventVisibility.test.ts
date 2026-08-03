import { shouldRenderToolEvent } from '../src/ui/toolEventVisibility';

describe('tool event visibility', () => {
  test.each([
    ['Command', 'started'],
    ['Command', 'completed'],
    ['Image generation', 'started'],
    ['Image generation', 'completed'],
  ] as const)('hides successful Codex %s %s events', (name, status) => {
    expect(shouldRenderToolEvent('codex', { id: 'tool-1', name, status })).toBe(false);
  });

  test('keeps Codex tool failures visible', () => {
    expect(shouldRenderToolEvent('codex', {
      id: 'tool-1',
      name: 'Image generation',
      status: 'error',
      error: 'generation failed',
    })).toBe(true);
  });

  test('preserves tool progress for other agents', () => {
    expect(shouldRenderToolEvent('claude', {
      id: 'tool-1',
      name: 'Command',
      status: 'completed',
    })).toBe(true);
  });
});
