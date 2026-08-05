import { findMentionQuery, findSlashQuery } from '../src/utils/inputQueries';
import { filterSlashCommands } from '../src/utils/slashCommands';

const sampleCommands = [
  { id: 'summarize', label: '/summarize', insertText: 'Summarize', description: 'Summarize a note' },
  { id: 'rewrite', label: '/rewrite', insertText: 'Rewrite', description: 'Improve writing' },
];

describe('input helpers', () => {
  test('finds mention and slash queries', () => {
    expect(findMentionQuery('read @folder/no', 15)).toBe('folder/no');
    expect(findSlashQuery('/sum', 4)).toBe('sum');
  });

  test('filters slash commands', () => {
    expect(filterSlashCommands(sampleCommands, 'sum')[0].id).toBe('summarize');
  });
});
