import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class {}, MarkdownView: class {}, Modal: class {}, TFile: class {},
  Notice: vi.fn(), setIcon: vi.fn(),
}));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn().mockResolvedValue(false) }));
vi.mock('../src/xiaohongshu/publish', () => ({
  buildXiaohongshuPublishSnapshot: vi.fn(),
  validateXiaohongshuPublishInput: vi.fn(),
}));

import { XiaohongshuWorkbenchView } from '../src/ui/xiaohongshuWorkbenchView';
import { confirmShareAction } from '../src/ui/shareConfirm';
import { buildXiaohongshuPublishSnapshot } from '../src/xiaohongshu/publish';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';
import type { QuickTransformPlatformId } from '../src/quickTransform/selection';
import type { XhsDraftRecord, XhsGeneratedPage } from '../src/xiaohongshu/types';

function draft(platform: string): MultiPublishSnapshot {
  return {
    sourcePath: '文章/测试.md', contentHash: platform, title: `${platform} 标题`, digest: '',
    markdown: `${platform} 独立文案`, html: `<p>${platform} 独立文案</p>`,
    coverAssetId: null, tags: [], assets: [], warnings: [],
  };
}

function fixture(options: { loggedIn?: boolean; member?: boolean; currentExtension?: boolean; connected?: boolean; includeX?: boolean } = {}) {
  const user = options.loggedIn === false ? null : { userId: 'user' };
  const billing = { membership: { active: options.member !== false } };
  const targets: QuickTransformPlatformId[] = ['xiaohongshu', 'weibo-post', 'jike-post', ...(options.includeX ? ['x-post' as const] : [])];
  const task = { taskId: 'dynamic-task', targets: [...targets], compose: true };
  const auth = {
    restoreSession: vi.fn().mockResolvedValue(user), startLogin: vi.fn(),
    getCurrentUser: () => user, openBilling: vi.fn(),
    getBillingSummary: () => billing, refreshBillingSummary: vi.fn().mockResolvedValue(billing),
  };
  const bridge = {
    getConnectionState: () => ({ connected: options.connected !== false, supportedPlatforms: [...targets], capabilities: [
      'target-payloads-v1', 'compose-v1', ...(options.currentExtension === false ? [] : ['dynamic-compose-v1']),
    ] }),
    createDynamicComposeTask: vi.fn().mockReturnValue({ task, handoffUrl: 'http://127.0.0.1:1234/wesight-bridge?compose=1' }),
    createTask: vi.fn(), clearPairing: vi.fn(),
  };
  const open = vi.fn();
  const openBrowserConnector = vi.fn();
  const generationService = { generateCopy: vi.fn(), generateXPostCopy: vi.fn() };
  const image = {
    id: 'selected-image', vaultPath: '图片/选中.png', fileName: '选中.png', mimeType: 'image/png',
    label: '选中配图', source: 'article' as 'article' | 'generated',
  };
  vi.stubGlobal('window', { open });
  vi.mocked(buildXiaohongshuPublishSnapshot).mockResolvedValue(draft('xiaohongshu'));
  const state = {
    options: { auth, bridge, openBrowserConnector, generationService }, snapshot: draft('source'), quickTargets: new Set(targets),
    quickOperation: false, quickCompleted: 0,
    quickPublishBusy: false, quickErrors: {} as Partial<Record<QuickTransformPlatformId | 'general', string>>, quickPublishTask: null,
    copy: { title: '手动标题', body: '当前手动编辑的正文', tags: ['标签'] },
    pageCount: 6, generatedPages: [] as XhsGeneratedPage[], publishLoginPending: false, quickMembershipNotice: false,
    quickXPostCopy: { body: 'X 保留完整的短句。', topics: ['AI'] },
    quickStateSourcePath: '', quickArticleImages: () => [image], quickGeneratedImages: () => [],
    clearQuickPublishTask: vi.fn(),
    quickSelectedImageIds: ['selected-image', 'second-image'], quickCopyMode: 'platform' as 'platform' | 'shared',
    scheduleDraftSave: vi.fn(), resetQuickGeneration: vi.fn(),
    quickSelectedImages: vi.fn(() => [image]), readPublishImage: vi.fn(async (_reference: string) => new Uint8Array([1, 2]).buffer),
    quickGenerationReady: () => false, render: vi.fn(), saveDraft: vi.fn(),
    enforceQuickTargetAccess: vi.fn(),
    weiboPostWorkbench: { buildQuickPublishSnapshot: vi.fn().mockResolvedValue(draft('weibo-post')), setQuickPublishTask: vi.fn() },
    jikePostWorkbench: { buildQuickPublishSnapshot: vi.fn().mockResolvedValue(draft('jike-post')), setQuickPublishTask: vi.fn() },
    startQuickPublish: (_forcePair: boolean): Promise<void> => Promise.resolve(),
    initializeQuickState: (_saved: Pick<XhsDraftRecord, 'quickTransform'> | null): void => {},
    toggleQuickImage: (_id: string): void => {},
    moveQuickImage: (_source: string, _target: string): void => {},
    setQuickCopyMode: (_mode: 'platform' | 'shared'): void => {},
    toggleQuickTarget: (_target: QuickTransformPlatformId): void => {},
  };
  const view = Object.assign(Object.create(XiaohongshuWorkbenchView.prototype) as typeof state, state);
  for (const method of ['startQuickPublish', 'initializeQuickState', 'toggleQuickImage', 'moveQuickImage', 'setQuickCopyMode', 'toggleQuickTarget'] as const) {
    delete (view as Partial<typeof state>)[method];
  }
  return { view, bridge, auth, open, openBrowserConnector };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('quick transform dynamic center handoff', () => {
  test.each(['', '用户编辑后的 X 正文'])('restores a saved X draft including an intentionally empty body: %j', body => {
    const { view } = fixture();
    view.initializeQuickState({
      quickTransform: {
        targets: ['x-post'], targetsExplicit: true, copyMode: 'platform',
        selectedImageIds: ['selected-image'], previewPlatform: 'x-post',
        xPostCopy: { body, topics: ['保留话题'] },
      },
    });
    expect(view.quickXPostCopy).toEqual({ body, topics: ['保留话题'] });
    expect(view.options.generationService.generateXPostCopy).not.toHaveBeenCalled();
  });

  test('initializes an unsaved X draft from the article without AI generation', () => {
    const { view } = fixture();
    view.initializeQuickState(null);
    expect(view.quickXPostCopy.body).toBe(view.snapshot.markdown);
    expect(view.options.generationService.generateXPostCopy).not.toHaveBeenCalled();
  });

  test('locks selection and prevents duplicate publishing while membership validation is pending', async () => {
    const { view, bridge, auth, open } = fixture();
    let releaseMembership!: (user: ReturnType<typeof auth.getCurrentUser>) => void;
    auth.restoreSession.mockReturnValueOnce(new Promise(resolve => { releaseMembership = resolve; }));
    const before = {
      images: [...view.quickSelectedImageIds], mode: view.quickCopyMode, targets: [...view.quickTargets],
    };

    const firstPublish = view.startQuickPublish(false);
    expect(view.quickPublishBusy).toBe(true);
    view.toggleQuickImage('selected-image');
    view.moveQuickImage('second-image', 'selected-image');
    view.setQuickCopyMode('shared');
    view.toggleQuickTarget('xiaohongshu');
    await view.startQuickPublish(false);

    expect({ images: view.quickSelectedImageIds, mode: view.quickCopyMode, targets: [...view.quickTargets] }).toEqual(before);
    expect(view.resetQuickGeneration).not.toHaveBeenCalled();
    expect(view.scheduleDraftSave).not.toHaveBeenCalled();
    expect(auth.restoreSession).toHaveBeenCalledOnce();
    expect(bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    releaseMembership(auth.getCurrentUser());
    await firstPublish;
    expect(bridge.createDynamicComposeTask).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(view.quickPublishBusy).toBe(false);
  });

  test('routes an unconnected publish attempt to connector settings before exporting or changing generated copy', async () => {
    const { view, bridge, auth, open, openBrowserConnector } = fixture({ connected: false });
    const copy = view.copy, pages = view.generatedPages, targets = [...view.quickTargets];
    await view.startQuickPublish(false);
    expect(openBrowserConnector).toHaveBeenCalledOnce();
    expect(bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(buildXiaohongshuPublishSnapshot).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(view.copy).toBe(copy);
    expect(view.generatedPages).toBe(pages);
    expect([...view.quickTargets]).toEqual(targets);
    expect(view.quickPublishBusy).toBe(false);
  });

  test('opens one dynamic composer with current platform copy without requiring AI generation', async () => {
    const { view, bridge, auth, open } = fixture();
    await view.startQuickPublish(false);

    expect(auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(bridge.createTask).not.toHaveBeenCalled();
    expect(bridge.createDynamicComposeTask).toHaveBeenCalledOnce();
    const [batch, targets, access] = bridge.createDynamicComposeTask.mock.calls[0] as [
      MultiPublishSnapshot, string[], { maxTargets: number | null },
    ];
    expect(targets).toEqual(['xiaohongshu', 'weibo-post', 'jike-post']);
    expect(access.maxTargets).toBeNull();
    for (const platformId of ['xiaohongshu', 'weibo-post', 'jike-post'] as const) {
      expect(batch.targetPayloads?.[platformId]?.article.markdown).toBe(`${platformId} 独立文案`);
    }
    expect(open).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:1234/wesight-bridge?compose=1', '_blank', 'noopener,noreferrer');
    expect(view.weiboPostWorkbench.setQuickPublishTask).not.toHaveBeenCalled();
    expect(view.jikePostWorkbench.setQuickPublishTask).not.toHaveBeenCalled();
    expect(view.quickPublishBusy).toBe(false);
    expect(view.quickCompleted).toBe(0);
    expect(view.options.generationService.generateCopy).not.toHaveBeenCalled();
    expect(view.options.generationService.generateXPostCopy).not.toHaveBeenCalled();
    expect(buildXiaohongshuPublishSnapshot).toHaveBeenCalledWith(expect.objectContaining({ copy: view.copy }));
  });

  test('allows a generation failure to be bypassed with the current drafts', async () => {
    const { view, bridge, open } = fixture();
    view.quickCompleted = 3;
    view.quickErrors = { 'jike-post': '生成失败', general: '一个平台生成失败' };
    await view.startQuickPublish(false);
    expect(bridge.createDynamicComposeTask).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(view.quickErrors['jike-post']).toBe('生成失败');
  });

  test('publishes the current image selection and order without replacing edited drafts or generated pages', async () => {
    const { view, bridge } = fixture();
    const selected = [
      { id: 'generated', vaultPath: '图片/生成.png', fileName: '生成.png', mimeType: 'image/png', label: '生成图', source: 'generated' as const },
      { id: 'article', vaultPath: '图片/原文.png', fileName: '原文.png', mimeType: 'image/png', label: '原文图', source: 'article' as const },
    ];
    view.quickSelectedImages.mockReturnValue(selected);
    view.generatedPages = [{ id: 'old', type: 'image', vaultPath: '旧.png', mimeType: 'image/png', createdAt: 1, pageNumber: 1, label: '旧图' }];
    const copy = view.copy, generatedPages = view.generatedPages;
    await view.startQuickPublish(false);
    expect(bridge.createDynamicComposeTask).toHaveBeenCalledOnce();
    const input = vi.mocked(buildXiaohongshuPublishSnapshot).mock.calls[0][0];
    expect(input.copy).toBe(copy);
    expect(input.pageCount).toBe(2);
    expect(input.pages.map(page => [page.vaultPath, page.pageNumber])).toEqual([
      ['图片/生成.png', 1], ['图片/原文.png', 2],
    ]);
    for (const workbench of [view.weiboPostWorkbench, view.jikePostWorkbench]) {
      expect(workbench.buildQuickPublishSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'generated', vaultPath: '图片/生成.png', source: 'xiaohongshu' }),
        expect.objectContaining({ id: 'article', vaultPath: '图片/原文.png', source: 'article' }),
      ]);
    }
    expect(view.copy).toBe(copy);
    expect(view.generatedPages).toBe(generatedPages);
    expect(view.pageCount).toBe(6);
  });

  test.each(['no-targets', 'no-images', 'generating', 'publishing'] as const)(
    'does not start a publish task when %s', async condition => {
      const { view, bridge, open } = fixture();
      if (condition === 'no-targets') view.quickTargets.clear();
      if (condition === 'no-images') view.quickSelectedImages.mockReturnValue([]);
      if (condition === 'generating') view.quickOperation = true;
      if (condition === 'publishing') view.quickPublishBusy = true;
      await view.startQuickPublish(false);
      expect(bridge.createDynamicComposeTask).not.toHaveBeenCalled();
      expect(buildXiaohongshuPublishSnapshot).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  test.each([
    { body: '', topics: [], message: '请先填写 X 动态正文' },
    { body: '长'.repeat(141), topics: [], message: '不能超过 280' },
  ])('keeps X content validation before creating a task: $message', async ({ body, topics, message }) => {
    const { view, bridge, open } = fixture({ includeX: true });
    view.quickXPostCopy = { body, topics };
    await view.startQuickPublish(false);
    expect(view.quickErrors.general).toContain(message);
    expect(bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(view.quickPublishBusy).toBe(false);
  });

  test('requires the dynamic composer capability before exporting drafts', async () => {
    const { view, bridge, open } = fixture({ currentExtension: false });
    await view.startQuickPublish(false);
    expect(view.quickErrors.general).toContain('动态发布中心');
    expect(bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(buildXiaohongshuPublishSnapshot).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test('includes an independent X payload when the fourth platform is selected', async () => {
    const { view, bridge, open } = fixture({ includeX: true });
    await view.startQuickPublish(false);
    expect(bridge.createDynamicComposeTask).toHaveBeenCalledOnce();
    const [batch, targets] = bridge.createDynamicComposeTask.mock.calls[0] as [MultiPublishSnapshot, string[]];
    expect(targets).toEqual(['xiaohongshu', 'weibo-post', 'jike-post', 'x-post']);
    expect(batch.targetPayloads?.['x-post']?.article.markdown).toBe('X 保留完整的短句。');
    expect(batch.targetPayloads?.['x-post']?.targetOptions?.xPost?.includeTitle).toBe(false);
    expect(open).toHaveBeenCalledOnce();
  });

  test('retains login and membership gating', async () => {
    const loggedOut = fixture({ loggedIn: false });
    await loggedOut.view.startQuickPublish(false);
    expect(loggedOut.auth.startLogin).toHaveBeenCalledOnce();
    expect(loggedOut.bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    const free = fixture({ member: false });
    await free.view.startQuickPublish(false);
    expect(confirmShareAction).toHaveBeenCalledWith(undefined, expect.objectContaining({ confirmText: '去充值会员' }));
    expect(free.view.enforceQuickTargetAccess).not.toHaveBeenCalled();
    expect(free.bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(free.open).not.toHaveBeenCalled();
  });

  test.each([true, false])('blocks a free user before connection or export, connected=%s', async connected => {
    const f = fixture({ member: false, connected });
    f.view.quickTargets = new Set(['xiaohongshu']);
    const before = [f.view.copy, f.view.generatedPages, [...f.view.quickTargets]];
    await f.view.startQuickPublish(false);
    expect(f.openBrowserConnector).not.toHaveBeenCalled();
    expect(buildXiaohongshuPublishSnapshot).not.toHaveBeenCalled();
    expect(f.bridge.createDynamicComposeTask).not.toHaveBeenCalled();
    expect(f.auth.openBilling).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect([f.view.copy, f.view.generatedPages, [...f.view.quickTargets]]).toEqual(before);
  });

  test('offers membership recharge without exporting the draft', async () => {
    const f = fixture({ member: false });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(true);
    await f.view.startQuickPublish(false);
    expect(f.auth.openBilling).toHaveBeenCalledOnce();
    expect(buildXiaohongshuPublishSnapshot).not.toHaveBeenCalled();
    expect(f.bridge.createDynamicComposeTask).not.toHaveBeenCalled();
  });
});
