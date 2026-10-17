import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ ItemView: class {}, MarkdownView: class {}, Modal: class {}, TFile: class {}, Notice: vi.fn(), setIcon: vi.fn() }));
vi.mock('../src/ui/memberFeatureGate', () => ({ requireMemberFeature: vi.fn().mockResolvedValue(true) }));

import type { MultiPublishBridge } from '../src/multiPublish/bridge';
import { requireBrowserConnection } from '../src/multiPublish/connection';
import { MultiPublishPanel } from '../src/ui/multiPublishPanel';
import { XiaohongshuWorkbenchView } from '../src/ui/xiaohongshuWorkbenchView';
import { WeiboPostWorkbench } from '../src/ui/weiboPostWorkbench';
import { JikePostWorkbench } from '../src/ui/jikePostWorkbench';

afterEach(() => vi.restoreAllMocks());

describe('browser connector preflight', () => {
  test('routes a disconnected or explicitly reconnecting action to settings', () => {
    const state = { connected: false };
    const bridge = { getConnectionState: () => state } as unknown as MultiPublishBridge;
    const settings = vi.fn();
    expect(requireBrowserConnection(bridge, settings)).toBe(false);
    state.connected = true;
    expect(requireBrowserConnection(bridge, settings)).toBe(true);
    expect(requireBrowserConnection(bridge, settings, true)).toBe(false);
    expect(settings).toHaveBeenCalledTimes(2);
  });

  test.each([
    [MultiPublishPanel.prototype, 'start'],
    [XiaohongshuWorkbenchView.prototype, 'startXiaohongshuPublish'],
    [WeiboPostWorkbench.prototype, 'startPublish'],
    [JikePostWorkbench.prototype, 'startPublish'],
  ] as const)('preserves the draft when %s opens connection settings', async (prototype, method) => {
    const openBrowserConnector = vi.fn();
    const createTask = vi.fn(), restoreSession = vi.fn();
    const copy = { body: '用户已编辑的文案' }, pages = [{ id: 'saved-image' }];
    const state = Object.assign(Object.create(prototype), {
      snapshot: {}, busy: false, publishBusy: false, copy, generatedPages: pages,
      options: { bridge: { getConnectionState: () => ({ connected: false }), createTask }, openBrowserConnector,
        auth: { restoreSession }, requestRender: vi.fn(), requestPosition: vi.fn() },
    }) as Record<string, (...args: unknown[]) => Promise<void>> & { copy: typeof copy; generatedPages: typeof pages };
    await state[method](false);
    expect(openBrowserConnector).toHaveBeenCalledOnce();
    expect(createTask).not.toHaveBeenCalled();
    expect(restoreSession).not.toHaveBeenCalled();
    expect(state.copy).toBe(copy);
    expect(state.generatedPages).toBe(pages);
  });
});
