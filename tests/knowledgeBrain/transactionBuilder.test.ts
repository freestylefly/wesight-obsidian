import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildTransactionFromDraft,
  KNOWLEDGE_DRAFT_BEGIN,
  KNOWLEDGE_DRAFT_END,
  normalizeIngestRawSnapshot,
  parseKnowledgeDraft,
  type KnowledgeDraftV1,
} from '../../src/knowledgeBrain/transactionBuilder';

describe('knowledge transaction builder', () => {
  let root: string;
  let vault: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-transaction-'));
    vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
    priorHome = process.env.WESIGHT_HOME;
    process.env.WESIGHT_HOME = path.join(root, 'home');
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.WESIGHT_HOME;
    else process.env.WESIGHT_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('parses one bounded draft between fixed markers', () => {
    const text = `${KNOWLEDGE_DRAFT_BEGIN}\n${JSON.stringify({
      schema: 'wesight.knowledge-draft.v1',
      operationType: 'save',
      writes: [{ path: 'wiki/Answer.md', mode: 'create', content: '# Answer\n' }],
    })}\n${KNOWLEDGE_DRAFT_END}`;

    expect(parseKnowledgeDraft(text, 'save').writes).toEqual([
      { path: 'wiki/Answer.md', mode: 'create', content: '# Answer\n', purpose: undefined },
    ]);
    expect(() => parseKnowledgeDraft(`${text}\n${KNOWLEDGE_DRAFT_BEGIN}`, 'save')).toThrow('多个开始标记');
  });

  test('builds upstream create and replace writes with exact preconditions and new content hashes', async () => {
    const oldContent = '# Existing\nold\n';
    const newContent = '# Existing\nnew\n';
    fs.writeFileSync(path.join(vault, 'wiki', 'Existing.md'), oldContent);
    const draft: KnowledgeDraftV1 = {
      schema: 'wesight.knowledge-draft.v1',
      operationType: 'save',
      writes: [
        { path: 'wiki/Existing.md', mode: 'replace', content: newContent },
        { path: 'wiki/New.md', mode: 'create', content: '# New\n' },
      ],
    };

    const result = await buildTransactionFromDraft(vault, draft);
    const operation = JSON.parse(fs.readFileSync(result.bundlePath, 'utf8')) as {
      schema: string;
      operation_type: string;
      expected_hashes: Record<string, string | null>;
      writes: Array<{ path: string; mode: string; content: string; sha256: string }>;
    };
    expect(operation.schema).toBe('claude-obsidian.transaction.v1');
    expect(operation.operation_type).toBe('save');
    expect(operation.expected_hashes).toEqual({
      'wiki/Existing.md': crypto.createHash('sha256').update(oldContent).digest('hex'),
      'wiki/New.md': null,
    });
    expect(operation.writes[0]).toMatchObject({ path: 'wiki/Existing.md', mode: 'replace', content: newContent });
    expect(operation.writes[0].sha256).toBe(crypto.createHash('sha256').update(newContent).digest('hex'));
    expect(fs.statSync(result.bundlePath).mode & 0o777).toBe(0o600);
  });

  test('rejects traversal, invalid create/replace state, raw replacement, and save writes outside wiki', async () => {
    const base = (operationType: 'ingest' | 'save', write: KnowledgeDraftV1['writes'][number]): KnowledgeDraftV1 => ({
      schema: 'wesight.knowledge-draft.v1', operationType, writes: [write],
    });
    await expect(buildTransactionFromDraft(vault, base('ingest', { path: '../escape.md', mode: 'create', content: 'x' }))).rejects.toThrow('越界');
    await expect(buildTransactionFromDraft(vault, base('ingest', { path: 'outside.md', mode: 'create', content: 'x' }))).rejects.toThrow('只能写入 wiki/ 或 .raw/');
    await expect(buildTransactionFromDraft(vault, base('save', { path: '.raw/a.md', mode: 'create', content: 'x' }))).rejects.toThrow('只能写入 wiki');
    await expect(buildTransactionFromDraft(vault, base('ingest', { path: '.raw/a.md', mode: 'replace', content: 'x' }))).rejects.toThrow('原始资料只能新增');
    await expect(buildTransactionFromDraft(vault, base('save', { path: 'wiki/missing.md', mode: 'replace', content: 'x' }))).rejects.toThrow('更新目标不存在');
  });

  test('rejects duplicate paths under portable case folding', () => {
    const text = `${KNOWLEDGE_DRAFT_BEGIN}\n${JSON.stringify({
      schema: 'wesight.knowledge-draft.v1',
      operationType: 'ingest',
      writes: [
        { path: 'wiki/Foo.md', mode: 'create', content: 'a' },
        { path: 'WIKI/foo.md', mode: 'create', content: 'b' },
      ],
    })}\n${KNOWLEDGE_DRAFT_END}`;
    expect(() => parseKnowledgeDraft(text, 'ingest')).toThrow('重复路径');
  });

  test('accepts an upstream source manifest update keyed by source identity', () => {
    const sourceId = 'a'.repeat(64);
    const text = `${KNOWLEDGE_DRAFT_BEGIN}\n${JSON.stringify({
      schema: 'wesight.knowledge-draft.v1',
      operationType: 'ingest',
      writes: [{ path: 'wiki/Source.md', mode: 'create', content: '# Source\n' }],
      sourceManifestUpdates: {
        [sourceId]: { hash: sourceId, pages_created: ['wiki/Source.md'] },
      },
    })}\n${KNOWLEDGE_DRAFT_END}`;

    expect(parseKnowledgeDraft(text, 'ingest').sourceManifestUpdates).toEqual({
      [sourceId]: { hash: sourceId, pages_created: ['wiki/Source.md'] },
    });
  });

  test('replaces model-authored raw snapshot bytes with the exact source bytes', () => {
    const draft: KnowledgeDraftV1 = {
      schema: 'wesight.knowledge-draft.v1',
      operationType: 'ingest',
      writes: [{ path: '.raw/captured/source.md', mode: 'replace', content: 'model rewrite' }],
    };

    const sourceSha256 = 'a'.repeat(64);
    normalizeIngestRawSnapshot(draft, '.raw/captured/source.md', 'exact source\n', false, sourceSha256);

    expect(draft.writes[0]).toMatchObject({
      path: '.raw/captured/source.md',
      mode: 'create',
      content: 'exact source\n',
    });
    expect(draft.sourceManifestUpdates).toEqual({
      '.raw/captured/source.md': { hash: sourceSha256, pages_created: [] },
    });
  });
});
