import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  expandKnowledgeCitationPaths,
  parseKnowledgeHealthReport,
  normalizeKnowledgeCitationLinks,
  sanitizeKnowledgeLogDetails,
  scanKnowledgeRecovery,
  validateKnowledgeCitations,
} from '../../src/knowledgeBrain/service';

describe('knowledge health and recovery parsing', () => {
  test('maps upstream lint categories and summary fields', () => {
    const report = parseKnowledgeHealthReport({
      summary: { pages_scanned: 12, links_scanned: 31, issues_found: 4, category_counts: { dead_links: 1 } },
      configuration_errors: [{ path: '.claude-obsidian.json', message: 'bad config' }],
      dead_links: [{ source: 'wiki/A.md', line: 7, target: 'Missing' }],
      orphans: [{ page: 'wiki/Alone.md' }],
      empty_sections: [{ file: 'wiki/Empty.md', line: 4 }],
    }, true, null, false);

    expect(report).toMatchObject({ ok: false, pages: 12, links: 31, recoveryPending: false });
    expect(report.findings.map(item => [item.rule, item.severity])).toEqual([
      ['configuration_errors', 'high'],
      ['dead_links', 'medium'],
      ['orphans', 'low'],
      ['empty_sections', 'low'],
    ]);
    expect(report.findings[1]).toMatchObject({ path: 'wiki/A.md', line: 7, target: 'Missing' });
  });

  test('recognizes nested unfinished journals and ignores completed operations', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-recovery-'));
    try {
      const transactions = path.join(vault, '.vault-meta', 'transactions');
      fs.mkdirSync(path.join(transactions, 'complete-op'), { recursive: true });
      fs.writeFileSync(path.join(transactions, 'complete-op', 'journal.json'), JSON.stringify({ state: 'complete' }));
      expect(await scanKnowledgeRecovery(vault)).toEqual({ pending: false, corrupt: false });

      fs.mkdirSync(path.join(transactions, 'pending-op'));
      fs.writeFileSync(path.join(transactions, 'pending-op', 'journal.json'), JSON.stringify({ state: 'applying' }));
      expect(await scanKnowledgeRecovery(vault)).toEqual({ pending: true, corrupt: false });
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('flags malformed journals and strips privacy canaries from log details', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-recovery-'));
    try {
      const operation = path.join(vault, '.vault-meta', 'transactions', 'bad-op');
      fs.mkdirSync(operation, { recursive: true });
      fs.writeFileSync(path.join(operation, 'journal.json'), '{bad json');
      expect(await scanKnowledgeRecovery(vault)).toEqual({ pending: true, corrupt: true });
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }

    const canary = 'SENSITIVE_KB_CANARY';
    const sanitized = sanitizeKnowledgeLogDetails({
      durationMs: 42,
      ok: false,
      errorCode: 'transaction-conflict',
      noteContent: canary,
      question: canary,
      answer: canary,
      vaultPath: `/private/${canary}`,
      messageId: canary,
      transaction: { content: canary },
    });
    expect(sanitized).toEqual({ durationMs: 42, ok: false, errorCode: 'transaction-conflict' });
    expect(JSON.stringify(sanitized)).not.toContain(canary);
  });

  test('accepts existing wikilinks, rejects missing targets, and permits an explicit evidence gap', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-citations-'));
    try {
      fs.mkdirSync(path.join(vault, 'wiki', 'concepts'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'wiki', 'concepts', 'Trusted.md'), '# Trusted\n');
      await expect(validateKnowledgeCitations(vault, '结论见 [[Trusted#Evidence|可信来源]]。')).resolves.toEqual({
        ok: true, paths: ['wiki/concepts/Trusted.md'], error: null,
      });
      await expect(validateKnowledgeCitations(vault, '结论见 [[Missing]]。')).resolves.toMatchObject({ ok: false });
      fs.mkdirSync(path.join(vault, 'wiki', 'sources'));
      fs.writeFileSync(path.join(vault, 'wiki', 'sources', 'Trusted.md'), '# Other Trusted\n');
      await expect(validateKnowledgeCitations(vault, '结论见 [[Trusted]]。')).resolves.toMatchObject({ ok: false });
      await expect(validateKnowledgeCitations(vault, '结论见 [[concepts/Trusted]]。')).resolves.toMatchObject({ ok: true });

      const captured = path.join(vault, '.raw', 'captured');
      fs.mkdirSync(captured, { recursive: true });
      fs.writeFileSync(path.join(captured, 'source.md'), '# Source\n');
      const relativeRawLink = '结论见 [[../../.raw/captured/source.md|原始资料]]。';
      expect(normalizeKnowledgeCitationLinks(relativeRawLink)).toBe('结论见 [[.raw/captured/source.md|原始资料]]。');
      await expect(validateKnowledgeCitations(vault, relativeRawLink)).resolves.toEqual({
        ok: true, paths: ['.raw/captured/source.md'], error: null,
      });

      fs.writeFileSync(path.join(vault, '.raw', '.manifest.json'), JSON.stringify({
        version: 1,
        sources: {
          '.raw/captured/source.md': {
            hash: 'bc0f7a2bc3aaaa2629e0a72f483f8ca62fcee7f5933dc776dd567a68a8b258e9',
            pages_created: ['wiki/concepts/Trusted.md'],
          },
        },
      }));
      await expect(expandKnowledgeCitationPaths(vault, ['wiki/concepts/Trusted.md'])).resolves.toEqual([
        { path: 'wiki/concepts/Trusted.md', kind: 'knowledge' },
        { path: '.raw/captured/source.md', kind: 'source' },
      ]);
      fs.writeFileSync(path.join(vault, 'Original.md'), '# Source\n');
      await expect(expandKnowledgeCitationPaths(vault, ['wiki/concepts/Trusted.md'])).resolves.toEqual([
        { path: 'wiki/concepts/Trusted.md', kind: 'knowledge' },
        { path: 'Original.md', kind: 'source' },
      ]);
      await expect(validateKnowledgeCitations(vault, '结论见 [[../../.raw/captured/missing.md]]。')).resolves.toMatchObject({ ok: false });
      await expect(validateKnowledgeCitations(vault, '结论见 [[../../../outside.md]]。')).resolves.toMatchObject({ ok: false });

      await expect(validateKnowledgeCitations(vault, '现有材料不足，缺少可验证证据。')).resolves.toEqual({ ok: true, paths: [], error: null });
      await expect(validateKnowledgeCitations(vault, '这是一个没有引用的结论。')).resolves.toMatchObject({ ok: false });
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
