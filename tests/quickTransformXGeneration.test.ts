import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class {}, MarkdownView: class {}, Modal: class {}, TFile: class {}, Notice: vi.fn(), setIcon: vi.fn(),
}));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn().mockResolvedValue(false) }));

import { XiaohongshuWorkbenchView } from '../src/ui/xiaohongshuWorkbenchView';
import { QUICK_TRANSFORM_PLATFORM_IDS } from '../src/quickTransform/selection';
import type { XPostCopyDraft } from '../src/xPost/types';

function fixture(shared = false, member = true) {
  const membership = { membership: { active: member } };
  const user = { userId: 'fixture' };
  const image = { id: 'image', vaultPath: '图.png', fileName: '图.png', mimeType: 'image/png', label: '配图', source: 'article' };
  const generationService = {
    recommend: vi.fn(),
    generateCopy: vi.fn().mockResolvedValue({ title: '统一标题', body: '保留完整的长文案。'.repeat(30), tags: ['AI'] }),
    generateXPostCopy: vi.fn().mockResolvedValue({ body: 'X 使用独立短句，保留核心观点。', topics: ['AI'] }),
  };
  const state = {
    options: { generationService, auth: {
      restoreSession: vi.fn().mockResolvedValue(user), getCurrentUser: () => user, getBillingSummary: () => membership,
      refreshBillingSummary: vi.fn().mockResolvedValue(membership),
    } },
    snapshot: { sourcePath: '文章.md', contentHash: 'a'.repeat(64), markdown: '原文' },
    quickOperation: false, quickTargets: new Set(QUICK_TRANSFORM_PLATFORM_IDS),
    quickCopyMode: shared ? 'shared' : 'platform', copyRequirement: '',
    quickXPostCopy: { body: '', topics: [] } as XPostCopyDraft,
    quickErrors: {} as Record<string, string>, quickCompleted: 0,
    quickPlatformStatus: {} as Record<string, string>, generationController: null,
    quickSelectedImages: () => [image], clearQuickPublishTask: vi.fn(), saveDraft: vi.fn(), render: vi.fn(),
    weiboPostWorkbench: {
      prepareQuickDraft: vi.fn(), setQuickDraft: vi.fn(), getQuickCopy: () => ({ body: '', topics: [], tone: 'news' }),
    },
    jikePostWorkbench: {
      prepareQuickDraft: vi.fn(), setQuickDraft: vi.fn(), getQuickCopy: () => ({ body: '', topics: [], tone: 'opinion', circle: 'AI 探索站' }),
    },
    generateQuickTransform: (): Promise<void> => Promise.resolve(), quickGenerationReady: () => false,
    refineRecommendation: (_silent: boolean): Promise<void> => Promise.resolve(),
  };
  const view = Object.assign(Object.create(XiaohongshuWorkbenchView.prototype) as typeof state, state);
  delete (view as Partial<typeof state>).generateQuickTransform;
  delete (view as Partial<typeof state>).quickGenerationReady;
  delete (view as Partial<typeof state>).refineRecommendation;
  return { view, generationService, membership };
}

afterEach(() => vi.clearAllMocks());

describe('Obsidian X quick generation', () => {
  test('generates the fourth platform independently and counts it toward completion', async () => {
    const { view, generationService } = fixture();
    await view.generateQuickTransform();
    expect(generationService.generateXPostCopy).toHaveBeenCalledOnce();
    expect(view.quickXPostCopy.body).toBe('X 使用独立短句，保留核心观点。');
    expect(view.quickCompleted).toBe(4);
    expect(view.quickPlatformStatus['x-post']).toBe('ready');
    expect(view.quickGenerationReady()).toBe(true);
    expect(view.weiboPostWorkbench.prepareQuickDraft).toHaveBeenCalledOnce();
    expect(view.jikePostWorkbench.prepareQuickDraft).toHaveBeenCalledOnce();
  });

  test('keeps a shared long draft intact and generates a complete X short version', async () => {
    const { view, generationService } = fixture(true);
    await view.generateQuickTransform();
    expect(generationService.generateCopy).toHaveBeenCalledOnce();
    expect(generationService.generateXPostCopy).toHaveBeenCalledOnce();
    const sharedWeibo = view.weiboPostWorkbench.setQuickDraft.mock.calls[0][0] as { body: string };
    expect(sharedWeibo.body).toBe('保留完整的长文案。'.repeat(30));
    expect(view.quickXPostCopy.body).toBe('X 使用独立短句，保留核心观点。');
    expect(view.quickCompleted).toBe(4);
    expect(view.quickGenerationReady()).toBe(true);
  });

  test.each([[['xiaohongshu']], [[...QUICK_TRANSFORM_PLATFORM_IDS]]])('requires membership before generating %j', async targets => {
    const { view, generationService } = fixture(false, false);
    view.quickTargets = new Set(targets as typeof QUICK_TRANSFORM_PLATFORM_IDS[number][]);
    const before = [...view.quickTargets];
    await view.generateQuickTransform();
    expect(generationService.generateCopy).not.toHaveBeenCalled();
    expect(generationService.generateXPostCopy).not.toHaveBeenCalled();
    expect(view.weiboPostWorkbench.prepareQuickDraft).not.toHaveBeenCalled();
    expect(view.saveDraft).not.toHaveBeenCalled();
    expect([...view.quickTargets]).toEqual(before);
    expect(view.quickOperation).toBe(false);
  });

  test('restoring a free workbench skips background AI analysis without a recharge prompt', async () => {
    const { view, generationService } = fixture(false, false);
    await view.refineRecommendation(true);
    expect(view.options.auth.refreshBillingSummary).not.toHaveBeenCalled();
    expect(generationService.recommend).not.toHaveBeenCalled();
    expect(view.saveDraft).not.toHaveBeenCalled();
  });

  test('rechecks cached membership before background analysis and skips revoked access', async () => {
    const { view, generationService, membership } = fixture();
    view.options.auth.refreshBillingSummary.mockImplementationOnce(async () => {
      membership.membership.active = false;
      return membership;
    });
    await view.refineRecommendation(true);
    expect(view.options.auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(generationService.recommend).not.toHaveBeenCalled();
    expect(view.saveDraft).not.toHaveBeenCalled();
  });
});
