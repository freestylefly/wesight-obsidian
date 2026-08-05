import { describe, expect, test } from 'vitest';

import { parseSkillFrontmatter } from '../src/skill/skillParser';

describe('parseSkillFrontmatter', () => {
  test('parses name and quoted description', () => {
    const text = '---\nname: browser-act\ndescription: "Browser automation CLI"\n---\n\nbody';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'browser-act', description: 'Browser automation CLI' });
  });

  test('parses unquoted single-line values', () => {
    const text = '---\nname: my-skill\ndescription: Do a thing\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'my-skill', description: 'Do a thing' });
  });

  test('uses fallback name when name is missing', () => {
    const text = '---\ndescription: No name here\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'fallback', description: 'No name here' });
  });

  test('returns null when no frontmatter', () => {
    const text = 'No frontmatter here';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toBeNull();
  });

  test('parses multi-line quoted description', () => {
    const text = '---\nname: long-skill\ndescription: "Line one\nLine two"\nallowed-tools: Bash(*)\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result?.name).toBe('long-skill');
    expect(result?.description).toBe('Line one\nLine two');
  });
});
