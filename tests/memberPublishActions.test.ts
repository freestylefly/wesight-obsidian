import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Modal: class {}, TFile: class {}, Notice: vi.fn(), setIcon: vi.fn(),
}));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn() }));
vi.mock('../src/multiPublish/snapshot', () => ({ buildMultiPublishSnapshot: vi.fn() }));

import { buildMultiPublishSnapshot } from '../src/multiPublish/snapshot';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';
import { JikePostWorkbench, type JikePostWorkbenchOptions } from '../src/ui/jikePostWorkbench';
import { MultiPublishPanel } from '../src/ui/multiPublishPanel';
import { confirmShareAction } from '../src/ui/shareConfirm';
import { WeiboPostWorkbench, type WeiboPostWorkbenchOptions } from '../src/ui/weiboPostWorkbench';

interface WorkbenchActions {
  copy: { body: string; topics: string[]; tone: string; circle: string };
  images: unknown[];
  publishBusy: boolean;
  startPublish(forcePair: boolean): Promise<void>;
  retryTask(): Promise<void>;
  openTask(): Promise<void>;
  generateCopy(): Promise<void>;
  dispose(): void;
}

interface PanelActions {
  snapshot: MultiPublishSnapshot;
  task: { taskId: string };
  activate(force?: boolean): Promise<void>;
  start(forcePair: boolean): Promise<void>;
  reopen(): Promise<void>;
  reimport(): Promise<void>;
  dispose(): void;
}

const snapshot: MultiPublishSnapshot = {
  sourcePath: 'article.md', contentHash: 'source-hash', title: '当前文章',
  digest: '文章摘要', markdown: '文章正文', html: '<p>文章正文</p>',
  coverAssetId: null, tags: [], assets: [], warnings: [],
};

function fixture(member: boolean, connected = true) {
  const user = { userId: 'creator', nickname: '创作者', avatarUrl: null };
  const summary = {
    membership: { active: member, expiresAt: member ? '2099-01-01T00:00:00Z' : null },
  };
  const auth = {
    restoreSession: vi.fn(async () => user), getCurrentUser: vi.fn(() => user),
    refreshBillingSummary: vi.fn(async () => summary), getBillingSummary: vi.fn(() => summary),
    openBilling: vi.fn(), startLogin: vi.fn(),
  };
  const app = { vault: { adapter: { readBinary: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) } } };
  const result = { task: { taskId: 'publish-task' }, handoffUrl: 'https://publish.test/compose' };
  const bridge = {
    getConnectionState: vi.fn(() => ({ connected })),
    createTask: vi.fn(() => result), createComposeTask: vi.fn(() => result),
    createRetryUrl: vi.fn(() => 'https://publish.test/retry'),
    createOpenUrl: vi.fn(() => 'https://publish.test/open'),
    createOpenTaskUrl: vi.fn(() => 'https://publish.test/open-task'),
    getLatestComposeTask: vi.fn(() => null), onChange: vi.fn(() => vi.fn()),
  };
  const options = {
    app, auth, bridge, file: { path: snapshot.sourcePath },
    getSettings: vi.fn(), saveSettings: vi.fn(),
    requestRender: vi.fn(), requestPosition: vi.fn(), openBrowserConnector: vi.fn(),
    showSection: vi.fn(), getXiaohongshuImages: vi.fn(() => []),
    draftStore: { save: vi.fn(async () => {}), load: vi.fn() },
    generationService: {
      generateWeiboPostCopy: vi.fn(async () => ({ body: '生成文案', topics: [], tone: 'opinion' })),
      generateJikePostCopy: vi.fn(async () => ({ body: '生成文案', topics: [], tone: 'opinion', circle: 'AI 探索站' })),
    },
  };
  return { options, auth, bridge, app };
}

function workbench(Workbench: typeof WeiboPostWorkbench | typeof JikePostWorkbench, member: boolean) {
  const context = fixture(member);
  const state = new Workbench(
    context.options as unknown as WeiboPostWorkbenchOptions & JikePostWorkbenchOptions,
  ) as unknown as WorkbenchActions;
  Object.assign(state, {
    snapshot, copy: { body: '用户已编辑的文案', topics: ['AI'], tone: 'opinion', circle: 'AI 探索站' },
    images: [{ id: 'image-1', vaultPath: 'images/one.png', fileName: 'one.png', mimeType: 'image/png' }],
    publishTask: { taskId: 'saved-task' },
  });
  return { ...context, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(confirmShareAction).mockResolvedValue(true);
  vi.mocked(buildMultiPublishSnapshot).mockResolvedValue(snapshot);
  vi.stubGlobal('window', { open: vi.fn(), clearTimeout: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['微博', WeiboPostWorkbench, 'weibo-post', 'generateWeiboPostCopy'],
  ['即刻', JikePostWorkbench, 'jike-post', 'generateJikePostCopy'],
] as const)('%s 会员发布动作', (_name, Workbench, platform, generateMethod) => {
  test('扩展已连接的非会员无法建任务、重试或打开已有任务，文案与图片保留', async () => {
    const { state, options, auth, bridge, app } = workbench(Workbench, false);
    const originalCopy = state.copy, originalImages = state.images;
    await state.startPublish(false);
    await state.retryTask();
    await state.openTask();
    expect(confirmShareAction).toHaveBeenCalledTimes(3);
    expect(auth.openBilling).toHaveBeenCalledTimes(3);
    expect(options.openBrowserConnector).not.toHaveBeenCalled();
    expect(bridge.getConnectionState).not.toHaveBeenCalled();
    expect(bridge.createTask).not.toHaveBeenCalled();
    expect(bridge.createRetryUrl).not.toHaveBeenCalled();
    expect(bridge.createOpenUrl).not.toHaveBeenCalled();
    expect(app.vault.adapter.readBinary).not.toHaveBeenCalled();
    expect(options.draftStore.save).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(state.copy).toBe(originalCopy);
    expect(state.images).toBe(originalImages);
    expect(state.publishBusy).toBe(false);
  });

  test('会员正常保存、读取配图并创建单平台任务', async () => {
    const { state, options, bridge, app, auth } = workbench(Workbench, true);
    await state.startPublish(false);
    expect(auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(options.draftStore.save).toHaveBeenCalledOnce();
    expect(app.vault.adapter.readBinary).toHaveBeenCalledWith('images/one.png');
    expect(bridge.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: '用户已编辑的文案', assets: [expect.objectContaining({ fileName: 'one.png' })] }),
      [platform], false,
    );
    expect(window.open).toHaveBeenCalledWith('https://publish.test/compose', '_blank', 'noopener,noreferrer');
    expect(confirmShareAction).not.toHaveBeenCalled();
  });

  test('已打开的工作台生成文案同样要求会员', async () => {
    const free = workbench(Workbench, false);
    await free.state.generateCopy();
    expect(free.options.generationService[generateMethod]).not.toHaveBeenCalled();
    expect(free.options.draftStore.save).not.toHaveBeenCalled();
    const confirmation = vi.mocked(confirmShareAction).mock.calls.at(-1);
    expect(confirmation?.[0]).toBe(free.options.app);
    expect(confirmation?.[1].message).toContain('转为图文');
    expect(confirmation?.[1].confirmText).toBe('去充值会员');
    const member = workbench(Workbench, true);
    await member.state.generateCopy();
    expect(member.options.generationService[generateMethod]).toHaveBeenCalledOnce();
    expect(member.options.draftStore.save).toHaveBeenCalledOnce();
  });

  test('会员校验等待期间重复点击只创建一次任务', async () => {
    const { state, auth, bridge } = workbench(Workbench, true);
    let finishCheck!: (value: Awaited<ReturnType<typeof auth.refreshBillingSummary>>) => void;
    auth.refreshBillingSummary.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    const first = state.startPublish(false);
    await vi.waitFor(() => expect(auth.refreshBillingSummary).toHaveBeenCalledOnce());
    await state.startPublish(false);
    expect(bridge.createTask).not.toHaveBeenCalled();
    finishCheck(auth.getBillingSummary());
    await first;
    expect(bridge.createTask).toHaveBeenCalledOnce();
    expect(state.publishBusy).toBe(false);
  });

  test.each(['startPublish', 'retryTask', 'openTask', 'generateCopy'] as const)(
    '关闭工作台会取消等待会员校验的 %s 动作', async method => {
      const { state, options, app, auth, bridge } = workbench(Workbench, true);
      let finishCheck!: (value: Awaited<ReturnType<typeof auth.refreshBillingSummary>>) => void;
      auth.refreshBillingSummary.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
      const actions = {
        startPublish: () => state.startPublish(false), retryTask: () => state.retryTask(),
        openTask: () => state.openTask(), generateCopy: () => state.generateCopy(),
      };
      const action = actions[method]();
      await vi.waitFor(() => expect(auth.refreshBillingSummary).toHaveBeenCalledOnce());
      state.dispose();
      finishCheck(auth.getBillingSummary());
      await action;
      expect(options.generationService[generateMethod]).not.toHaveBeenCalled();
      expect(options.draftStore.save).not.toHaveBeenCalled();
      expect(app.vault.adapter.readBinary).not.toHaveBeenCalled();
      expect(bridge.createTask).not.toHaveBeenCalled();
      expect(bridge.createRetryUrl).not.toHaveBeenCalled();
      expect(bridge.createOpenUrl).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );
});

describe('多平台文章会员动作', () => {
  test.each([true, false])('扩展连接状态为 %s 时非会员均先提示充值，保留现有任务且不读取快照', async connected => {
    const { options, bridge, auth } = fixture(false, connected);
    const panel = new MultiPublishPanel(
      options as unknown as ConstructorParameters<typeof MultiPublishPanel>[0],
    ) as unknown as PanelActions;
    const task = { taskId: 'existing-task' };
    Object.assign(panel, { snapshot, task });
    await panel.activate(true);
    await panel.start(false);
    await panel.reopen();
    await panel.reimport();
    expect(auth.openBilling).toHaveBeenCalledTimes(4);
    expect(buildMultiPublishSnapshot).not.toHaveBeenCalled();
    expect(options.openBrowserConnector).not.toHaveBeenCalled();
    expect(bridge.getConnectionState).not.toHaveBeenCalled();
    expect(bridge.createComposeTask).not.toHaveBeenCalled();
    expect(bridge.createOpenTaskUrl).not.toHaveBeenCalled();
    expect(panel.task).toBe(task);
  });

  test.each(['activate', 'start', 'reopen', 'reimport'] as const)('关闭浮层会取消等待会员校验的 %s 动作', async method => {
    const { options, bridge, auth } = fixture(true);
    const panel = new MultiPublishPanel(
      options as unknown as ConstructorParameters<typeof MultiPublishPanel>[0],
    ) as unknown as PanelActions;
    Object.assign(panel, { snapshot, task: { taskId: 'existing-task' } });
    let finishCheck!: (value: Awaited<ReturnType<typeof auth.refreshBillingSummary>>) => void;
    auth.refreshBillingSummary.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    const actions = {
      activate: () => panel.activate(false), start: () => panel.start(false),
      reopen: () => panel.reopen(), reimport: () => panel.reimport(),
    };
    const action = actions[method]();
    await vi.waitFor(() => expect(auth.refreshBillingSummary).toHaveBeenCalledOnce());
    panel.dispose();
    finishCheck(auth.getBillingSummary());
    await action;
    expect(bridge.onChange).not.toHaveBeenCalled();
    expect(buildMultiPublishSnapshot).not.toHaveBeenCalled();
    expect(bridge.createComposeTask).not.toHaveBeenCalled();
    expect(bridge.createOpenTaskUrl).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  test('会员按无限平台权限交接文章，复用刚校验的会员信息', async () => {
    const { options, bridge, auth } = fixture(true);
    const panel = new MultiPublishPanel(
      options as unknown as ConstructorParameters<typeof MultiPublishPanel>[0],
    ) as unknown as PanelActions;
    panel.snapshot = snapshot;
    await panel.start(false);
    expect(auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(bridge.createComposeTask).toHaveBeenCalledWith(snapshot, { state: 'multi-platform', maxTargets: null }, false);
    expect(window.open).toHaveBeenCalledWith('https://publish.test/compose', '_blank', 'noopener,noreferrer');
    await panel.reopen();
    expect(bridge.createOpenTaskUrl).toHaveBeenCalledWith('publish-task');
  });
});
