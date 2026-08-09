import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { KnowledgeBrain } from '../../src/knowledgeBrain/service';
import type { KnowledgeBrainAccessStatus, KnowledgeRuntimeEvent } from '../../src/knowledgeBrain/types';

const denied: KnowledgeBrainAccessStatus = {
  state: 'membership-required',
  allowed: false,
  verifiedOnline: true,
  expiresAt: null,
  reason: '知识大脑内测仅向 WeSight 有效会员开放。',
};

describe('Knowledge Brain service entitlement gate', () => {
  let root: string;
  let previousHome: string | undefined;
  let requireCoreAccess = vi.fn(async (): Promise<KnowledgeBrainAccessStatus> => denied);
  let service: KnowledgeBrain;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-entitlement-gate-'));
    previousHome = process.env.WESIGHT_HOME;
    process.env.WESIGHT_HOME = path.join(root, 'home');
    requireCoreAccess = vi.fn(async (): Promise<KnowledgeBrainAccessStatus> => {
      throw new Error(denied.reason!);
    });
    service = new KnowledgeBrain({
      getVaultPath: () => path.join(root, 'vault'),
      getMaxContextChars: () => 10_000,
      runtimeManager: {
        resolveStatus: vi.fn(() => ({ found: false })),
      } as never,
      entitlement: {
        probe: vi.fn(async () => denied),
        requireCoreAccess,
        clear: vi.fn(),
        onChange: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.WESIGHT_HOME;
    else process.env.WESIGHT_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('blocks enable before any runtime installation', async () => {
    const result = await service.enable();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('有效会员');
    expect(fs.existsSync(path.join(root, 'home', 'knowledge-brain', 'runtimes'))).toBe(false);
  });

  test('blocks collection, answer saving, and query before planning or agent work', async () => {
    await expect(service.planCollectCurrentNote({ extension: 'md', path: 'secret.md' }, 'claude'))
      .rejects.toThrow('有效会员');
    await expect(service.planSaveAnswer({
      conversationId: 'conversation-canary',
      messageId: 'message-canary',
      question: 'question-canary',
      answer: 'answer-canary',
      agentId: 'codex',
    })).rejects.toThrow('有效会员');

    const events: KnowledgeRuntimeEvent[] = [];
    await service.query({
      conversationId: 'conversation-canary',
      question: 'question-canary',
      agentId: 'claude',
    }, event => events.push(event));
    expect(events).toEqual([
      { type: 'error', message: denied.reason },
      { type: 'done' },
    ]);
  });

  test('blocks applying a pending preview and discards it', async () => {
    const pending = (service as unknown as {
      pendingPreviews: Map<string, unknown>;
    }).pendingPreviews;
    pending.set('preview-1', {
      preview: { previewId: 'preview-1' },
      bundlePath: path.join(root, 'missing-transaction.json'),
      approvalHash: 'hash',
      vaultPath: path.join(root, 'vault'),
    });

    await expect(service.applyPreview('preview-1')).resolves.toMatchObject({
      ok: false,
      changedPaths: [],
      error: denied.reason,
    });
    expect(pending.has('preview-1')).toBe(false);
  });

  test('keeps maintenance health checks available after access loss', async () => {
    requireCoreAccess.mockClear();
    const report = await service.runHealthCheck();

    expect(report.ok).toBe(false);
    expect(report.error).toContain('未就绪');
    expect(requireCoreAccess).not.toHaveBeenCalled();
  });
});
