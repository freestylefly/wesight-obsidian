/* eslint obsidianmd/no-global-this: off -- Test-only Obsidian DOM helpers. */
import fs from 'fs';

vi.mock('obsidian', () => ({
  App: class {},
  Component: class {},
  MarkdownRenderer: { render: vi.fn() },
  sanitizeHTMLToDom: vi.fn(),
}));

import { replaceFormulaSvgs } from '../src/wechat/renderer';
import { inlineTemplateThemeCss } from '../src/wechat/templateThemeCss';
import type { LoadedTemplateTheme } from '../src/wechat/templateThemeTypes';
import type { WeChatAssetDraft } from '../src/wechat/types';

class TestElement {
  readonly tagName: string;
  readonly children: TestElement[] = [];
  parentElement: TestElement | null = null;
  className = '';
  src = '';
  alt = '';
  readonly attributes: Record<string, string> = {};
  readonly style = {
    setProperty(property: string, value: string) {
      Object.assign(this, { [property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())]: value });
    },
  } as CSSStyleDeclaration;
  readonly classList = {
    contains: (value: string) => this.className.split(' ').includes(value),
  };

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get isConnected(): boolean { return this.parentElement !== null; }
  appendChild(child: TestElement): TestElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceWith(replacement: TestElement): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1, replacement);
    replacement.parentElement = parent;
    this.parentElement = null;
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  cloneNode(): TestElement {
    const clone = new TestElement(this.tagName);
    Object.assign(clone.attributes, this.attributes);
    return clone;
  }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }
  querySelector(selector: string): TestElement | null {
    if (selector === ':scope > .wesight-wechat-h2-tail') {
      return this.children.find(child => child.classList.contains('wesight-wechat-h2-tail')) ?? null;
    }
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  private matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const segments = part.trim().split(/\s+/);
      const last = segments.pop() ?? '';
      if (!this.matchesSimple(last)) return false;
      let ancestor = this.parentElement;
      for (const segment of segments.reverse()) {
        while (ancestor && !ancestor.matchesSimple(segment)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  private matchesSimple(selector: string): boolean {
    if (selector === '*') return true;
    if (/^\.[\w-]+$/.test(selector)) return this.classList.contains(selector.slice(1));
    return /^[\w-]+$/.test(selector) && this.tagName.toLowerCase() === selector;
  }
}

function asElement(element: TestElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function loadTheme(id: string, color: string): LoadedTemplateTheme {
  return {
    packId: 'canghe-demos',
    manifest: { id, label: id, color, cssFile: `themes/${id}.css` },
    definition: { id, label: id, color, kind: 'template' },
    cssText: fs.readFileSync(new URL(`../assets/theme/canghe-demos/themes/${id}.css.txt`, import.meta.url), 'utf8'),
    features: {},
    absoluteBasePath: '',
  };
}

function makeArticle(theme: LoadedTemplateTheme, withFormula: boolean) {
  const root = new TestElement('section');
  root.className = `wesight-wechat-template-${theme.manifest.id}`;
  const heading = root.appendChild(new TestElement('h2'));
  const tail = heading.appendChild(new TestElement('span'));
  tail.className = 'wesight-wechat-h2-tail';
  const quote = root.appendChild(new TestElement('blockquote'));
  const strong = root.appendChild(new TestElement('strong'));
  if (withFormula) {
    const wrapper = root.appendChild(new TestElement('mjx-container'));
    const svg = wrapper.appendChild(new TestElement('svg'));
    svg.setAttribute('viewBox', '0 0 100 30');
  }
  inlineTemplateThemeCss(asElement(root), theme.cssText, root.className);
  return { root, heading, quote, strong };
}

function colors(article: ReturnType<typeof makeArticle>) {
  return {
    heading: article.heading.style.color,
    border: article.heading.style.borderBottom,
    quote: article.quote.style.backgroundColor,
    strong: article.strong.style.color,
  };
}

beforeEach(() => {
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal('XMLSerializer', class {
    serializeToString() { return '<svg xmlns="http://www.w3.org/2000/svg"/>'; }
  });
  vi.stubGlobal('createEl', (tag: string) => tag === 'canvas' ? {
    getContext: () => ({ scale: vi.fn(), drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['formula-png'], { type: 'image/png' })),
  } : new TestElement(tag));
});

afterEach(() => vi.unstubAllGlobals());

describe('WeChat formula conversion preserves the selected theme', () => {
  test.each([
    ['canghe-violet', '#7c3aed'],
    ['canghe-orange', '#f97316'],
  ])('%s keeps article colors with and without formulas', async (id, color) => {
    const theme = loadTheme(id, color);
    for (const withFormula of [false, true]) {
      const article = makeArticle(theme, withFormula);
      const before = colors(article);
      const upload = vi.fn(async (_asset: WeChatAssetDraft) => 'https://mmbiz.qpic.cn/formula.png');
      expect(before.heading).toBe(color);

      await replaceFormulaSvgs(asElement(article.root), upload, theme);

      expect(colors(article)).toEqual(before);
      expect(upload).toHaveBeenCalledTimes(withFormula ? 1 : 0);
      expect(article.root.querySelectorAll('svg')).toHaveLength(0);
      const image = article.root.querySelector('img');
      if (withFormula) {
        expect(upload.mock.calls[0]?.[0].mimeType).toBe('image/png');
        expect(upload.mock.calls[0]?.[0].body).toBeInstanceOf(ArrayBuffer);
        expect(image?.src).toBe('https://mmbiz.qpic.cn/formula.png');
        expect(image?.alt).toBe('公式');
        expect(image?.style.maxWidth).toBe('100%');
        expect(image?.style.margin).toBe('20px auto 30px');
      } else {
        expect(image).toBeNull();
      }
    }
  });

  test('keeps generated Skill and custom theme styles during formula conversion', async () => {
    const article = makeArticle(loadTheme('canghe-violet', '#7c3aed'), true);
    article.root.className = 'wesight-wechat-skill-article';
    const before = colors(article);

    await replaceFormulaSvgs(asElement(article.root), async () => 'https://mmbiz.qpic.cn/formula.png');

    expect(colors(article)).toEqual(before);
    expect(article.root.querySelector('img')?.src).toBe('https://mmbiz.qpic.cn/formula.png');
  });

  test('skips formulas that disconnected before conversion', async () => {
    const theme = loadTheme('canghe-violet', '#7c3aed');
    const article = makeArticle(theme, true);
    const svg = article.root.querySelector('svg');
    Object.defineProperty(svg, 'isConnected', { value: false });
    const before = colors(article);
    const upload = vi.fn(async (_asset: WeChatAssetDraft) => 'https://mmbiz.qpic.cn/formula.png');

    await replaceFormulaSvgs(asElement(article.root), upload, theme);

    expect(upload).not.toHaveBeenCalled();
    expect(colors(article)).toEqual(before);
    expect(article.root.querySelector('img')).toBeNull();
  });

  test('retains image layout for the legacy Canghe fallback', async () => {
    const article = makeArticle(loadTheme('canghe-style-tes', '#2ea765'), true);
    article.root.className = 'wesight-wechat-canghe-article';

    await replaceFormulaSvgs(asElement(article.root), async () => 'https://mmbiz.qpic.cn/formula.png');

    expect(article.heading.style.color).toBe('#2ea765');
    expect(article.root.querySelector('img')?.style.maxWidth).toBe('100%');
    expect(article.root.querySelector('img')?.style.margin).toBe('20px auto 30px');
  });
});
