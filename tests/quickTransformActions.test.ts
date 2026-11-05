import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class {}, MarkdownView: class {}, Modal: class {}, TFile: class {},
  Notice: vi.fn(), setIcon: vi.fn(),
}));

import { XiaohongshuWorkbenchView } from '../src/ui/xiaohongshuWorkbenchView';
import type { QuickTransformPlatformId } from '../src/quickTransform/selection';

class ElementStub {
  children: ElementStub[] = [];
  onclick?: () => void;
  disabled = false;
  value = 0;
  constructor(public options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {}
  createDiv(options = {}) { return this.add(options); }
  createSpan(options = {}) { return this.add(options); }
  createEl(_tag: string, options = {}) { return this.add(options); }
  add(options: ElementStub['options']) {
    const child = new ElementStub(options); this.children.push(child); return child;
  }
  prepend(child: ElementStub) {
    this.children = this.children.filter(existing => existing !== child);
    this.children.unshift(child);
  }
  all(): ElementStub[] { return [this, ...this.children.flatMap(child => child.all())]; }
  byClass(className: string): ElementStub {
    const result = this.all().find(element => element.options.cls?.split(' ').includes(className));
    if (!result) throw new Error(`Missing element ${className}`);
    return result;
  }
}

type TaskFixture = {
  targets: QuickTransformPlatformId[];
  platforms: Record<string, { status: 'ready' | 'queued' }>;
};

function fixture(currentExtension = true) {
  const connection = {
    connected: true, supportedPlatforms: ['xiaohongshu', 'jike-post'],
    capabilities: ['target-payloads-v1', 'compose-v1', ...(currentExtension ? ['dynamic-compose-v1'] : [])],
  };
  const state = {
    options: { bridge: { getConnectionState: () => connection } },
    quickTargets: new Set<QuickTransformPlatformId>(['xiaohongshu', 'jike-post']),
    quickSelectedImageIds: ['selected'], quickCopyMode: 'platform', quickOperation: false,
    quickCompleted: 0, quickPublishBusy: false, quickPublishTask: null as TaskFixture | null,
    quickErrors: {} as Partial<Record<QuickTransformPlatformId | 'general', string>>,
    generateQuickTransform: vi.fn().mockResolvedValue(undefined),
    startQuickPublish: vi.fn().mockResolvedValue(undefined),
    openQuickPublishTask: vi.fn().mockResolvedValue(undefined),
    renderQuickFooter: (_parent: HTMLElement): void => {},
  };
  const view = Object.assign(Object.create(XiaohongshuWorkbenchView.prototype) as typeof state, state);
  delete (view as Partial<typeof state>).renderQuickFooter;
  const root = new ElementStub();
  const render = () => {
    view.renderQuickFooter(root as unknown as HTMLElement);
    return {
      generate: root.byClass('wesight-quick-generate'),
      publish: root.byClass('wesight-quick-publish'),
    };
  };
  return { view, root, render };
}

afterEach(() => vi.clearAllMocks());

describe('independent quick transform actions', () => {
  test('offers independent generation and publishing before any AI generation', () => {
    const { view, render } = fixture();
    const { generate, publish } = render();
    expect(generate.disabled).toBe(false);
    expect(publish.disabled).toBe(false);
    generate.onclick?.();
    expect(view.generateQuickTransform).toHaveBeenCalledOnce();
    expect(view.startQuickPublish).not.toHaveBeenCalled();
    publish.onclick?.();
    expect(view.startQuickPublish).toHaveBeenCalledExactlyOnceWith(false);
    expect(view.generateQuickTransform).toHaveBeenCalledOnce();
  });

  test('keeps publishing available after one platform fails to generate', () => {
    const { view, render } = fixture();
    view.quickCompleted = 2;
    view.quickErrors['jike-post'] = '生成失败';
    const { generate, publish } = render();
    expect(generate.disabled).toBe(false);
    expect(publish.disabled).toBe(false);
    publish.onclick?.();
    expect(view.startQuickPublish).toHaveBeenCalledOnce();
    expect(view.generateQuickTransform).not.toHaveBeenCalled();
  });

  test.each(['generating', 'publishing', 'no-platforms', 'no-images'] as const)(
    'disables both actions when %s', condition => {
      const { view, render } = fixture();
      if (condition === 'generating') view.quickOperation = true;
      if (condition === 'publishing') view.quickPublishBusy = true;
      if (condition === 'no-platforms') view.quickTargets.clear();
      if (condition === 'no-images') view.quickSelectedImageIds = [];
      const { generate, publish } = render();
      expect(generate.disabled).toBe(true);
      expect(publish.disabled).toBe(true);
    },
  );

  test('allows generating while an old extension blocks publishing before generation', () => {
    const { render } = fixture(false);
    const { generate, publish } = render();
    expect(generate.disabled).toBe(false);
    expect(publish.disabled).toBe(true);
  });

  test.each(['ready', 'queued'] as const)('preserves the existing %s task action', status => {
    const { view, render } = fixture();
    view.quickPublishTask = {
      targets: ['xiaohongshu'], platforms: { xiaohongshu: { status } },
    };
    const { publish } = render();
    publish.onclick?.();
    expect(view.generateQuickTransform).not.toHaveBeenCalled();
    if (status === 'ready') {
      expect(view.startQuickPublish).toHaveBeenCalledExactlyOnceWith(false);
      expect(view.openQuickPublishTask).not.toHaveBeenCalled();
    } else {
      expect(view.openQuickPublishTask).toHaveBeenCalledOnce();
      expect(view.startQuickPublish).not.toHaveBeenCalled();
    }
  });
});
