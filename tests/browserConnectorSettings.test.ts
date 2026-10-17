import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ App: class {}, Notice: vi.fn(), setIcon: vi.fn() }));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn() }));

import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import type { MultiPublishBridge } from '../src/multiPublish/bridge';
import type { MultiPublishConnectionState } from '../src/multiPublish/types';
import type { CloudAuthService } from '../src/share/cloudAuth';
import type { CloudUser } from '../src/share/types';
import { BrowserConnectorSettings } from '../src/ui/browserConnectorSettings';
import { confirmShareAction } from '../src/ui/shareConfirm';

class Element {
  children: Element[] = [];
  text = '';
  tag = '';
  attrs: Record<string, string> = {};
  disabled = false;
  onclick: (() => void) | null = null;
  focus = vi.fn();
  scrollIntoView = vi.fn();
  createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    return this.append(tag, options);
  }
  private append(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> }): Element {
    const child = new Element();
    child.tag = tag;
    child.text = options.text ?? '';
    child.attrs = { ...options.attr, ...(options.cls ? { class: options.cls } : {}) };
    this.children.push(child);
    return child;
  }
  createDiv(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    return this.append('div', options);
  }
  createSpan(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    return this.append('span', options);
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  addClass(cls: string): void { this.attrs.class = `${this.attrs.class ?? ''} ${cls}`; }
  empty(): void { this.children = []; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  get textContent(): string { return this.all().map(node => node.text).join(' '); }
}

function fixture(initial: Partial<MultiPublishConnectionState> = {}) {
  let state: MultiPublishConnectionState = {
    running: true, paired: false, connected: false, baseUrl: 'http://127.0.0.1:1234',
    extensionVersion: null, supportedPlatforms: null, capabilities: null, ...initial,
  };
  const user: CloudUser = { userId: 'member', nickname: 'Member', avatarUrl: null };
  const auth = {
    restoreSession: vi.fn().mockResolvedValue(user),
    getCurrentUser: vi.fn().mockReturnValue(user),
    refreshBillingSummary: vi.fn().mockResolvedValue({ membership: { active: true, expiresAt: null } }),
    openBilling: vi.fn(),
    startLogin: vi.fn(),
  };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const bridge = {
    getConnectionState: () => state,
    createConnectionUrl: vi.fn().mockReturnValue('http://127.0.0.1:1234/wesight-bridge?connect=1#pairToken=test'),
    clearPairing: vi.fn().mockImplementation(async () => {
      state = { ...state, paired: false, connected: false, extensionVersion: null };
      listeners.forEach(listener => listener());
    }),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
  };
  const parent = new Element();
  const ui = new BrowserConnectorSettings({ app: {} as App, auth: auth as unknown as CloudAuthService, bridge: bridge as unknown as MultiPublishBridge });
  ui.render(parent as unknown as HTMLElement);
  ui.activate();
  return {
    ui, bridge, auth, parent, unsubscribe,
    update(next: Partial<MultiPublishConnectionState>) {
      state = { ...state, ...next };
      listeners.forEach(listener => listener());
    },
    async click(label: string) {
      const button = parent.all().find(node => node.tag === 'button' && node.text === label);
      expect(button, `Missing button ${label}`).toBeDefined();
      expect(button?.disabled).toBe(false);
      button?.onclick?.();
      for (let index = 0; index < 8; index++) await Promise.resolve();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { open: vi.fn(), setTimeout, clearTimeout });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.mocked(confirmShareAction).mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('browser publishing connector settings', () => {
  test('unpaired status gives installation guidance without claiming the extension is missing', () => {
    const { parent, ui } = fixture();
    expect(parent.textContent).toContain('连接浏览器');
    expect(parent.textContent).toContain('会员专享');
    expect(parent.textContent).toContain('安装或更新浏览器插件');
    expect(parent.textContent).toContain('Chrome / Arc');
    expect(parent.textContent).toContain('Edge');
    expect(parent.textContent).not.toContain('未安装');
    ui.dispose();
  });

  test('connect opens a task-free connection URL and updates when the extension responds', async () => {
    const f = fixture();
    await f.click('连接浏览器');
    expect(f.auth.refreshBillingSummary).toHaveBeenCalledWith(false);
    expect(f.bridge.createConnectionUrl).toHaveBeenCalledOnce();
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      'http://127.0.0.1:1234/wesight-bridge?connect=1#pairToken=test', '_blank', 'noopener,noreferrer',
    );
    expect(f.parent.textContent).toContain('等待连接');
    f.update({ paired: true, connected: true, extensionVersion: '1.2.3' });
    expect(f.parent.textContent).toContain('v1.2.3');
    expect(f.parent.textContent).toContain('检测连接');
    expect(vi.getTimerCount()).toBe(0);
    f.ui.dispose();
  });

  test('timeout stays unknown and offers retry without creating or clearing drafts', async () => {
    const f = fixture();
    await f.click('连接浏览器');
    vi.advanceTimersByTime(15_000);
    expect(f.parent.textContent).toContain('暂未检测到浏览器响应');
    expect(f.parent.textContent).not.toContain('未安装');
    expect(f.bridge.clearPairing).not.toHaveBeenCalled();
    await f.click('连接浏览器');
    expect(f.bridge.createConnectionUrl).toHaveBeenCalledTimes(2);
    f.ui.dispose();
  });

  test('saved but stale pairing can reconnect and explicit detection opens a fresh connection', async () => {
    const f = fixture({ paired: true });
    expect(f.parent.textContent).toContain('已配对，未连接');
    await f.click('重新连接');
    f.update({ connected: true });
    await f.click('检测连接');
    expect(f.auth.refreshBillingSummary).toHaveBeenCalledTimes(2);
    expect(f.bridge.createConnectionUrl).toHaveBeenCalledTimes(2);
    expect(f.bridge.clearPairing).not.toHaveBeenCalled();
    f.ui.dispose();
  });

  test('dispose cancels waiting and removes subscriptions', async () => {
    const f = fixture();
    await f.click('连接浏览器');
    const card = f.parent.children[0];
    f.ui.focus();
    expect(card.scrollIntoView).toHaveBeenCalledOnce();
    expect(card.focus).toHaveBeenCalledOnce();
    f.ui.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(f.parent.textContent).not.toContain('暂未检测到浏览器响应');
  });

  test('disconnect requires confirmation and explains that drafts stay available', async () => {
    const f = fixture({ paired: true, connected: true });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(false);
    await f.click('断开');
    expect(f.bridge.clearPairing).not.toHaveBeenCalled();
    expect(vi.mocked(confirmShareAction).mock.calls[0][1].message).toContain('草稿和已同步内容会保留');
    vi.mocked(confirmShareAction).mockResolvedValueOnce(true);
    await f.click('断开');
    expect(f.bridge.clearPairing).toHaveBeenCalledOnce();
    expect(f.parent.textContent).toContain('连接浏览器');
    expect(f.auth.refreshBillingSummary).not.toHaveBeenCalled();
    f.ui.dispose();
  });

  test('bridge failure and stopped service stay actionable without opening invalid pages', async () => {
    const f = fixture();
    f.bridge.createConnectionUrl.mockImplementation(() => { throw new Error('本地服务未启动'); });
    await f.click('连接浏览器');
    expect(f.parent.textContent).toContain('本地服务未启动');
    expect(window.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.update({ running: false });
    expect(f.parent.textContent).toContain('请关闭后重新启用');
    expect(f.parent.all().find(node => node.text === '连接浏览器')?.disabled).toBe(true);
    f.ui.dispose();
  });

  test.each([
    [{}, '连接浏览器'],
    [{ paired: true }, '重新连接'],
    [{ paired: true, connected: true }, '检测连接'],
  ])('non-members cannot start %s via %s', async (state, label) => {
    const f = fixture(state);
    f.auth.refreshBillingSummary.mockResolvedValue({ membership: { active: false, expiresAt: null } });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(true);
    await f.click(label);
    const prompt = vi.mocked(confirmShareAction).mock.calls.at(-1)?.[1];
    expect(prompt?.confirmText).toBe('去充值会员');
    expect(prompt?.message).toContain('尚未开通有效会员');
    expect(f.auth.openBilling).toHaveBeenCalledOnce();
    expect(f.bridge.createConnectionUrl).not.toHaveBeenCalled();
    expect(f.bridge.clearPairing).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.ui.dispose();
  });

  test('billing failure leaves the connection untouched and offers a retry', async () => {
    const f = fixture();
    f.auth.refreshBillingSummary.mockRejectedValueOnce(new Error('offline'));
    await f.click('连接浏览器');
    expect(Notice).toHaveBeenCalledWith('无法验证会员状态，请检查网络后重试。');
    expect(confirmShareAction).not.toHaveBeenCalled();
    expect(f.bridge.createConnectionUrl).not.toHaveBeenCalled();
    expect(f.auth.openBilling).not.toHaveBeenCalled();
    await f.click('连接浏览器');
    expect(f.bridge.createConnectionUrl).toHaveBeenCalledOnce();
    f.ui.dispose();
  });

  test('repeated clicks while checking share one check and dispose prevents opening a late connection', async () => {
    const f = fixture();
    let finish!: () => void;
    f.auth.refreshBillingSummary.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ membership: { active: true, expiresAt: null } });
    }));
    const button = f.parent.all().find(node => node.text === '连接浏览器');
    button?.onclick?.();
    button?.onclick?.();
    await Promise.resolve();
    expect(f.auth.refreshBillingSummary).toHaveBeenCalledOnce();
    expect(f.parent.all().find(node => node.text === '正在验证会员…')?.disabled).toBe(true);
    f.ui.dispose();
    finish();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(f.bridge.createConnectionUrl).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});
