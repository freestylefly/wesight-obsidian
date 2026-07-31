import {
  demoteMarkdownHeadings,
  hashFeishuSnapshot,
  withFeishuSnapshotTitle,
} from '../src/feishu/markdown';
import type { FeishuAssetDraft, FeishuSnapshot } from '../src/feishu/types';

const asset: FeishuAssetDraft = {
  placeholder: 'WESIGHT_FEISHU_IMAGE_0001_abc',
  vaultPath: 'assets/demo.png',
  fileName: 'demo.png',
  mimeType: 'image/png',
  contentHash: 'abc',
  alt: 'demo',
};

describe('Feishu markdown transforms', () => {
  test('demotes headings while preserving fenced code', () => {
    const source = [
      '# Section',
      '## Detail',
      '',
      '```markdown',
      '# code heading',
      '```',
      '###### Stays at level six',
    ].join('\n');
    expect(demoteMarkdownHeadings(source)).toBe([
      '## Section',
      '### Detail',
      '',
      '```markdown',
      '# code heading',
      '```',
      '###### Stays at level six',
    ].join('\n'));
  });

  test('changes the hash when the title or attachment digest changes', () => {
    const markdown = '# Title\n\nBody\n';
    const first = hashFeishuSnapshot('Title', markdown, [asset]);
    expect(hashFeishuSnapshot('Renamed', '# Renamed\n\nBody\n', [asset])).not.toBe(first);
    expect(hashFeishuSnapshot('Title', markdown, [{ ...asset, contentHash: 'def' }]))
      .not.toBe(first);
  });

  test('updates the single document title and recalculates the hash', () => {
    const snapshot: FeishuSnapshot = {
      title: 'Old',
      markdown: '# Old\n\n## Body\n',
      contentHash: 'old-hash',
      assets: [asset],
      warnings: [],
      vaultBasePath: '/vault',
    };
    const updated = withFeishuSnapshotTitle(snapshot, 'New title');
    expect(updated.title).toBe('New title');
    expect(updated.markdown).toBe('# New title\n\n## Body\n');
    expect(updated.contentHash).not.toBe(snapshot.contentHash);
  });
});
