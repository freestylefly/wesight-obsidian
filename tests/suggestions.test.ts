import { findMentionQuery, findSlashQuery } from '../src/utils/inputQueries';
import { filterSlashCommands } from '../src/utils/slashCommands';

describe('input helpers', () => {
  test('finds mention and slash queries', () => {
    expect(findMentionQuery('read @folder/no', 15)).toBe('folder/no');
    expect(findSlashQuery('/sum', 4)).toBe('sum');
  });

  test('filters slash commands', () => {
    expect(filterSlashCommands('sum')[0].id).toBe('summarize');
  });
});
