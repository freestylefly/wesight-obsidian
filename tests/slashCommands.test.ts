import { describe, expect, test } from 'vitest';

import { filterSlashCommands } from '../src/utils/slashCommands';

describe('filterSlashCommands', () => {
  test('filters by label', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Alpha skill' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Beta skill' },
    ];
    expect(filterSlashCommands(commands, 'bet')).toHaveLength(1);
    expect(filterSlashCommands(commands, 'bet')[0]?.id).toBe('b');
  });

  test('filters by description', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Fetch pages' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Extract data' },
    ];
    expect(filterSlashCommands(commands, 'extract')).toHaveLength(1);
  });

  test('empty query returns all', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Alpha' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Beta' },
    ];
    expect(filterSlashCommands(commands, '')).toHaveLength(2);
  });
});
