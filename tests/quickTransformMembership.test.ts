import { describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class {}, MarkdownView: class {}, Modal: class {}, TFile: class {},
  Notice: vi.fn(), setIcon: vi.fn(),
}));

import { Notice } from 'obsidian';
import { XiaohongshuWorkbenchView } from '../src/ui/xiaohongshuWorkbenchView';
import type { QuickTransformPlatformId } from '../src/quickTransform/selection';

class ElementStub {
  children: ElementStub[] = [];
  onclick?: () => void;
  removed = false;
  constructor(public options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {}
  createDiv(options = {}) { return this.add(options); }
  createSpan(options = {}) { return this.add(options); }
  createEl(_tag: string, options = {}) { return this.add(options); }
  add(options: ElementStub['options']) {
    const child = new ElementStub(options); this.children.push(child); return child;
  }
  remove() { this.removed = true; }
  all(): ElementStub[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

function fixture(member = false, loggedIn = true) {
  const auth = {
    getCurrentUser: () => loggedIn ? { id: 'test' } : null,
    getBillingSummary: () => ({ membership: { active: member } }),
    startLogin: vi.fn(), openBilling: vi.fn(),
  };
  const state = {
    options: { auth }, quickTargets: new Set<QuickTransformPlatformId>(['xiaohongshu']),
    quickTargetsExplicit: false, quickMembershipNotice: false, quickMembershipReturnPending: false,
    quickOperation: false, quickPublishBusy: false, quickPreviewPlatform: 'xiaohongshu',
    copy: { title: '用户标题', body: '用户修改的文案', tags: ['标签'] },
    quickSelectedImageIds: ['three', 'one'], quickCompleted: 1,
    quickPlatformStatus: { xiaohongshu: 'ready' },
    resetQuickGeneration: vi.fn(), scheduleDraftSave: vi.fn(), render: vi.fn(),
    contentEl: { querySelector: () => ({ focus: vi.fn() }) },
    toggleQuickTarget: (_id: QuickTransformPlatformId) => {},
    renderQuickMembershipNotice: (_parent: HTMLElement) => {},
    enforceQuickTargetAccess: () => {},
  };
  const view = Object.assign(Object.create(XiaohongshuWorkbenchView.prototype) as typeof state, state);
  // Exercise production methods without constructing an Obsidian workspace leaf.
  for (const method of ['toggleQuickTarget', 'renderQuickMembershipNotice', 'enforceQuickTargetAccess'] as const) {
    delete (view as Partial<typeof state>)[method];
  }
  return { view, auth };
}

describe('quick transform inline membership prompt', () => {
  test('blocks a second free platform without resetting edited content or progress', () => {
    const { view } = fixture();
    const before = JSON.stringify([view.copy, view.quickSelectedImageIds, view.quickPlatformStatus]);
    view.toggleQuickTarget('weibo-post');
    expect([...view.quickTargets]).toEqual(['xiaohongshu']);
    expect(view.quickMembershipNotice).toBe(true);
    expect(view.resetQuickGeneration).not.toHaveBeenCalled();
    expect(view.scheduleDraftSave).not.toHaveBeenCalled();
    expect(JSON.stringify([view.copy, view.quickSelectedImageIds, view.quickPlatformStatus])).toBe(before);
    expect(view.quickCompleted).toBe(1);
  });

  test('allows members to select all four platforms without a prompt', () => {
    const { view } = fixture(true);
    view.toggleQuickTarget('weibo-post'); view.toggleQuickTarget('jike-post'); view.toggleQuickTarget('x-post');
    expect(view.quickTargets.size).toBe(4);
    expect(view.quickMembershipNotice).toBe(false);
  });

  test('routes logged-out users to login instead of membership', () => {
    const { view, auth } = fixture(false, false);
    view.toggleQuickTarget('weibo-post');
    expect(auth.startLogin).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalled();
    expect(auth.openBilling).not.toHaveBeenCalled();
    expect(view.quickMembershipNotice).toBe(false);
  });

  test('allows free users to deselect and switch platforms', () => {
    const { view } = fixture();
    view.toggleQuickTarget('weibo-post');
    view.toggleQuickTarget('xiaohongshu'); view.toggleQuickTarget('jike-post');
    expect([...view.quickTargets]).toEqual(['jike-post']);
    expect(view.quickMembershipNotice).toBe(false);
  });

  test('does not change selection during generation or publish preparation', () => {
    const { view } = fixture(true);
    view.quickOperation = true; view.toggleQuickTarget('weibo-post');
    view.quickOperation = false; view.quickPublishBusy = true; view.toggleQuickTarget('weibo-post');
    expect([...view.quickTargets]).toEqual(['xiaohongshu']);
  });

  test('dismisses inline without rerendering or erasing drafts and can reopen', () => {
    const { view } = fixture();
    view.quickMembershipNotice = true;
    const root = new ElementStub();
    view.renderQuickMembershipNotice(root as unknown as HTMLElement);
    expect(root.children[0].options.attr).toMatchObject({ role: 'status', 'aria-live': 'polite' });
    root.all().find(el => el.options.text === '稍后再说')!.onclick!();
    expect(view.quickMembershipNotice).toBe(false);
    expect(root.children[0].removed).toBe(true);
    expect(view.render).not.toHaveBeenCalled();
    expect(view.copy.body).toBe('用户修改的文案');
    view.toggleQuickTarget('weibo-post');
    expect(view.quickMembershipNotice).toBe(true);
  });

  test('opens the existing billing destination and keeps the current selection explicit', () => {
    const { view, auth } = fixture();
    const root = new ElementStub();
    view.renderQuickMembershipNotice(root as unknown as HTMLElement);
    root.all().find(el => el.options.text === '去充值会员')!.onclick!();
    expect(auth.openBilling).toHaveBeenCalledOnce();
    expect(view.quickTargetsExplicit).toBe(true);
    expect(view.quickMembershipReturnPending).toBe(true);
    expect([...view.quickTargets]).toEqual(['xiaohongshu']);
    expect(view.resetQuickGeneration).not.toHaveBeenCalled();
  });

  test('background membership reconciliation keeps one platform without a proactive upsell', () => {
    const { view } = fixture();
    view.quickTargets.add('weibo-post');
    view.enforceQuickTargetAccess();
    expect([...view.quickTargets]).toEqual(['xiaohongshu']);
    expect(view.quickMembershipNotice).toBe(false);
    expect(view.copy.body).toBe('用户修改的文案');
    expect(view.quickSelectedImageIds).toEqual(['three', 'one']);
  });
});
