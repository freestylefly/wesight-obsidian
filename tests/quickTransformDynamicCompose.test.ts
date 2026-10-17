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
  vi.stubGlobal('window', { open });
  vi.mocked(buildXiaohongshuPublishSnapshot).mockResolvedValue(draft('xiaohongshu'));
  const state = {
    options: { auth, bridge, openBrowserConnector }, snapshot: draft('source'), quickTargets: new Set(targets),
    quickPublishBusy: false, quickErrors: {} as { general?: string }, quickPublishTask: null,
    copy: {}, pageCount: 0, generatedPages: [], publishLoginPending: false, quickMembershipNotice: false,
    quickXPostCopy: { body: 'X 保留完整的短句。', topics: ['AI'] },
    quickSelectedImages: () => [], readPublishImage: vi.fn(),
    quickGenerationReady: () => true, render: vi.fn(), saveDraft: vi.fn(),
    enforceQuickTargetAccess: vi.fn(),
    weiboPostWorkbench: { buildQuickPublishSnapshot: vi.fn().mockResolvedValue(draft('weibo-post')), setQuickPublishTask: vi.fn() },
    jikePostWorkbench: { buildQuickPublishSnapshot: vi.fn().mockResolvedValue(draft('jike-post')), setQuickPublishTask: vi.fn() },
    startQuickPublish: (_forcePair: boolean): Promise<void> => Promise.resolve(),
  };
  const view = Object.assign(Object.create(XiaohongshuWorkbenchView.prototype) as typeof state, state);
  delete (view as Partial<typeof state>).startQuickPublish;
  return { view, bridge, auth, open, openBrowserConnector };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('quick transform dynamic center handoff', () => {
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

  test('opens one dynamic composer with all generated platform copy instead of starting a direct task', async () => {
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
