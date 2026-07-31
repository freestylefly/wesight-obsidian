import {
  omitMermaidBlocks,
  stripShareFrontmatter,
  transformWikiLinks,
} from '../src/share/markdownTransforms';

describe('share markdown transforms', () => {
  test('extracts the share id without publishing it', () => {
    const source = [
      '---',
      'title: Shared note',
      'wesight-share-id: "8b216bea-d74d-4f2f-82e2-dba398d41fd3"',
      'tags:',
      '  - public',
      '---',
      '# Hello',
    ].join('\n');
    expect(stripShareFrontmatter(source)).toEqual({
      shareId: '8b216bea-d74d-4f2f-82e2-dba398d41fd3',
      markdown: '# Hello',
    });
  });

  test('removes an otherwise empty share frontmatter block', () => {
    expect(stripShareFrontmatter([
      '---',
      'wesight-share-id: share_1',
      '---',
      'Article',
    ].join('\n'))).toEqual({
      shareId: 'share_1',
      markdown: 'Article',
    });
  });

  test('turns wiki links into their visible labels', () => {
    expect(transformWikiLinks('See [[Folder/Note|Readable title]] and [[Plain note]].'))
      .toBe('See Readable title and Plain note.');
  });

  test('omits Mermaid source and leaves a visible placeholder', () => {
    expect(omitMermaidBlocks('Before\n\n```mermaid\ngraph TD\n```\n\nAfter')).toEqual({
      found: true,
      markdown: 'Before\n\n> Mermaid 图表未随分享发布。\n\nAfter',
    });
  });
});
