import { createHash } from 'crypto';
import { App, Component, MarkdownRenderer } from 'obsidian';

import type { WeChatAssetDraft, WeChatPreviewSnapshot } from './types';

const ATOM_ONE_DARK: Record<string, string> = {
  'hljs-comment': '#5c6370',
  'hljs-quote': '#5c6370',
  'hljs-doctag': '#c678dd',
  'hljs-keyword': '#c678dd',
  'hljs-formula': '#c678dd',
  'hljs-section': '#e06c75',
  'hljs-name': '#e06c75',
  'hljs-selector-tag': '#e06c75',
  'hljs-deletion': '#e06c75',
  'hljs-subst': '#e06c75',
  'hljs-literal': '#56b6c2',
  'hljs-string': '#98c379',
  'hljs-regexp': '#98c379',
  'hljs-addition': '#98c379',
  'hljs-attribute': '#98c379',
  'hljs-meta-string': '#98c379',
  'hljs-built_in': '#e6c07b',
  'hljs-class': '#e6c07b',
  'hljs-title': '#61aeee',
  'hljs-attr': '#d19a66',
  'hljs-variable': '#d19a66',
  'hljs-template-variable': '#d19a66',
  'hljs-type': '#e6c07b',
  'hljs-number': '#d19a66',
  'hljs-symbol': '#61aeee',
  'hljs-bullet': '#61aeee',
  'hljs-link': '#61aeee',
  'hljs-meta': '#61aeee',
  'hljs-selector-id': '#61aeee',
  'hljs-selector-class': '#61aeee',
  'hljs-emphasis': '#c9d1d9',
  'hljs-strong': '#c9d1d9',
};

function styles(element: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, values);
}

function decorateCode(pre: HTMLElement): void {
  if (pre.parentElement?.classList.contains('wesight-wechat-code-section')) return;
  const wrapper = document.createElement('section');
  wrapper.className = 'wesight-wechat-code-section';
  styles(wrapper, {
    display: 'block',
    margin: '20px 0',
    border: '1px solid rgb(60, 66, 84)',
    backgroundColor: '#282c34',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)',
  });
  const header = document.createElement('section');
  header.setAttribute('aria-hidden', 'true');
  styles(header, {
    display: 'block',
    height: '30px',
    paddingLeft: '12px',
    lineHeight: '30px',
    letterSpacing: '0',
    backgroundColor: '#282c34',
  });
  for (const color of ['#ff5f56', '#ffbd2e', '#27c93f']) {
    const dot = document.createElement('span');
    dot.textContent = '●';
    styles(dot, {
      display: 'inline-block',
      marginRight: '7px',
      color,
      fontSize: '13px',
      lineHeight: '30px',
      letterSpacing: '0',
    });
    header.appendChild(dot);
  }
  pre.replaceWith(wrapper);
  wrapper.append(header, pre);
}

function decorateHeading(heading: HTMLElement): void {
  if (heading.tagName !== 'H2' || heading.querySelector(':scope > .wesight-wechat-h2-tail')) {
    return;
  }
  const tail = document.createElement('span');
  tail.className = 'wesight-wechat-h2-tail';
  tail.setAttribute('aria-hidden', 'true');
  styles(tail, {
    position: 'absolute',
    right: '0',
    bottom: '0',
    width: '20px',
    height: '10px',
    borderTopLeftRadius: '20px',
    borderTopRightRadius: '20px',
    backgroundColor: 'rgba(46, 167, 101, 0.5)',
  });
  heading.appendChild(tail);
}

function replaceTaskCheckbox(input: HTMLInputElement): void {
  const mark = document.createElement('span');
  mark.textContent = input.checked ? '☑' : '☐';
  styles(mark, {
    display: 'inline-block',
    marginRight: '6px',
    color: input.checked ? '#2ea765' : '#595959',
    fontSize: '16px',
  });
  input.replaceWith(mark);
}

function wrapTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('wesight-wechat-table-wrap')) continue;
    const wrapper = document.createElement('section');
    wrapper.className = 'wesight-wechat-table-wrap';
    styles(wrapper, {
      display: 'block',
      width: '100%',
      margin: '20px 0',
      overflowX: 'auto',
    });
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
}

export function applyCangheWechatStyles(root: HTMLElement): void {
  for (const forbidden of Array.from(root.querySelectorAll('script,style,iframe,object,embed,form'))) {
    forbidden.remove();
  }
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    replaceTaskCheckbox(input);
  }
  wrapTables(root);
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) decorateCode(pre);
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h2'))) decorateHeading(heading);

  styles(root, {
    display: 'block',
    boxSizing: 'border-box',
    padding: '8px',
    color: '#333333',
    fontFamily: 'Optima-Regular, Optima, PingFang SC, Microsoft YaHei, sans-serif',
    fontSize: '16px',
    letterSpacing: '1.5px',
    overflowWrap: 'break-word',
    backgroundColor: '#ffffff',
  });

  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'p') {
      styles(element, {
        margin: element.closest('blockquote') ? '0' : '30px 8px',
        fontFamily: 'Optima-Regular, Optima, PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: '16px',
        lineHeight: '32px',
        letterSpacing: '2px',
        wordSpacing: '2px',
      });
    } else if (tag === 'h1') {
      styles(element, {
        display: 'inline-block',
        maxWidth: '100%',
        minHeight: '40px',
        margin: '10px 0',
        padding: '0 30px',
        color: '#ffffff',
        backgroundColor: '#2ea765',
        borderBottomRightRadius: '100px',
        fontSize: '19px',
        fontWeight: '700',
        lineHeight: '40px',
        boxSizing: 'border-box',
      });
    } else if (tag === 'h2') {
      styles(element, {
        position: 'relative',
        display: 'block',
        margin: '16px 0 8px',
        paddingBottom: '6px',
        color: '#2ea765',
        borderBottom: '4px solid #2ea765',
        fontSize: '18px',
        fontWeight: '700',
        lineHeight: '1.3',
      });
    } else if (tag === 'h3') {
      styles(element, {
        margin: '17px 0 5px',
        padding: '6px 25px 5px 5px',
        color: '#2ea765',
        borderBottom: '1px solid #dddddd',
        fontSize: '17px',
        fontWeight: '700',
        lineHeight: '1.25',
        textDecoration: 'underline 3px #2ea765',
        textUnderlineOffset: '6px',
      });
    } else if (tag === 'h4') {
      styles(element, {
        margin: '16px 0 5px',
        padding: '6px 5px 5px',
        color: '#2ea765',
        borderBottom: '1px solid #dddddd',
        fontSize: '16px',
        fontWeight: '700',
        lineHeight: '1.25',
        textDecoration: 'underline 2px #2ea765',
        textUnderlineOffset: '5px',
      });
    } else if (tag === 'ul') {
      styles(element, {
        margin: '8px 0',
        paddingLeft: '28px',
        color: '#595959',
        fontSize: '15px',
        lineHeight: '1.8',
        listStyleType: 'circle',
      });
    } else if (tag === 'ol') {
      styles(element, {
        margin: '8px 0',
        padding: '8px 8px 8px 30px',
        color: '#595959',
        fontSize: '15px',
        lineHeight: '1.8',
      });
    } else if (tag === 'li') {
      styles(element, { marginBottom: '8px', fontSize: '16px' });
    } else if (tag === 'blockquote') {
      styles(element, {
        margin: '20px 0',
        padding: '10px 20px',
        color: '#2c3e50',
        backgroundColor: '#f0fdf4',
        borderLeft: '4px solid #42b983',
        borderRadius: '4px',
        fontSize: '16px',
        lineHeight: '1.6',
      });
      for (const paragraph of Array.from(element.querySelectorAll<HTMLElement>(':scope > p'))) {
        styles(paragraph, { margin: '0', padding: '0' });
      }
    } else if (tag === 'a') {
      styles(element, {
        color: '#399003',
        fontWeight: '400',
        textDecoration: 'none',
        borderBottom: '1px solid #42b983',
        overflowWrap: 'anywhere',
      });
    } else if (tag === 'strong') {
      styles(element, { color: '#2ea765', fontWeight: '700' });
    } else if (tag === 'em') {
      styles(element, { color: '#2ea765', fontStyle: 'italic', fontWeight: '700' });
    } else if (tag === 'del') {
      styles(element, { color: '#2ea765' });
    } else if (tag === 'hr') {
      styles(element, {
        height: '1px',
        margin: '24px 0',
        padding: '0',
        border: '0',
        borderTop: '2px solid #2ea765',
      });
    } else if (tag === 'img') {
      styles(element, {
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        margin: '20px auto 30px',
        borderRadius: '6px',
        objectFit: 'contain',
        boxShadow: '2px 4px 7px #999999',
      });
    } else if (tag === 'table') {
      styles(element, {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'auto',
        border: '1px solid #42b983',
        borderRadius: '8px',
        overflow: 'hidden',
        fontSize: '14px',
      });
    } else if (tag === 'th') {
      styles(element, {
        padding: '12px 8px',
        color: '#ffffff',
        backgroundColor: '#42b983',
        borderBottom: '2px solid #dddddd',
        fontWeight: '700',
        textAlign: 'center',
      });
    } else if (tag === 'td') {
      styles(element, {
        maxWidth: '300px',
        padding: '12px 8px',
        backgroundColor: element.parentElement instanceof HTMLTableRowElement
          && element.parentElement.rowIndex % 2
          ? '#f9f9f9'
          : '#ffffff',
        borderBottom: '1px solid #dddddd',
        textAlign: 'left',
        verticalAlign: 'top',
        overflowWrap: 'break-word',
      });
    } else if (tag === 'pre') {
      styles(element, {
        display: 'block',
        margin: '0',
        padding: '0',
        color: '#abb2bf',
        backgroundColor: '#282c34',
        borderRadius: '0 0 5px 5px',
        overflowX: 'auto',
        whiteSpace: 'pre',
      });
    } else if (tag === 'code') {
      const inBlock = Boolean(element.closest('pre'));
      styles(element, inBlock ? {
        display: 'block',
        padding: '0.9em',
        color: '#abb2bf',
        backgroundColor: 'transparent',
        fontFamily: 'Menlo, Monaco, Consolas, Courier New, monospace',
        fontSize: '13px',
        lineHeight: '1.6',
        letterSpacing: '0',
        whiteSpace: 'pre',
      } : {
        display: 'inline',
        padding: '2px 5px',
        color: '#2ea765',
        backgroundColor: '#f0fdf4',
        borderRadius: '4px',
        fontFamily: 'Menlo, Monaco, Consolas, Courier New, monospace',
        fontSize: '0.88em',
        letterSpacing: '0',
      });
    }
    for (const className of Array.from(element.classList)) {
      const color = ATOM_ONE_DARK[className];
      if (color) element.style.color = color;
    }
  }
}

function assetMap(snapshot: WeChatPreviewSnapshot, urls?: Map<string, string>): Map<string, string> {
  return new Map(snapshot.assets.map((asset) => [
    asset.token,
    urls?.get(asset.token) || asset.previewUrl,
  ]));
}

function replaceAssetTokens(
  markdown: string,
  replacements: Map<string, string>,
): string {
  let result = markdown;
  for (const [token, url] of replacements) result = result.split(token).join(url);
  return result;
}

export async function renderWeChatArticle(
  app: App,
  component: Component,
  snapshot: WeChatPreviewSnapshot,
  container: HTMLElement,
  uploadedUrls?: Map<string, string>,
): Promise<void> {
  container.empty();
  container.classList.add('wesight-wechat-canghe-article');
  await MarkdownRenderer.render(
    app,
    replaceAssetTokens(snapshot.markdown, assetMap(snapshot, uploadedUrls)),
    container,
    snapshot.sourcePath,
    component,
  );
  applyCangheWechatStyles(container);
}

function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('公式图片渲染失败'));
    image.src = url;
  });
}

async function svgToPng(svg: SVGElement): Promise<ArrayBuffer> {
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const viewBox = clone.getAttribute('viewBox')?.split(/\s+/).map(Number);
  const width = Math.max(1, Number(clone.getAttribute('width')) || viewBox?.[2] || 800);
  const height = Math.max(1, Number(clone.getAttribute('height')) || viewBox?.[3] || 80);
  const source = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  try {
    const image = await imageFromUrl(url);
    const scale = Math.min(3, Math.max(1, 1200 / width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建公式画布');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('公式图片生成失败')), 'image/png');
    });
    return blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function replaceFormulaSvgs(
  root: HTMLElement,
  upload: (asset: WeChatAssetDraft) => Promise<string>,
): Promise<void> {
  const formulas = Array.from(root.querySelectorAll<SVGElement>('mjx-container svg, .math svg'));
  for (let index = 0; index < formulas.length; index += 1) {
    const svg = formulas[index];
    if (!svg.isConnected) continue;
    const body = await svgToPng(svg);
    const contentHash = createHash('sha256').update(Buffer.from(body)).digest('hex');
    const asset: WeChatAssetDraft = {
      token: `wesight-wechat-formula://${contentHash}`,
      source: `formula-${index + 1}`,
      fileName: `formula-${contentHash.slice(0, 12)}.png`,
      mimeType: 'image/png',
      contentHash,
      body,
      previewUrl: '',
    };
    const url = await upload(asset);
    const image = document.createElement('img');
    image.src = url;
    image.alt = '公式';
    const target = svg.closest('mjx-container, .math') ?? svg;
    target.replaceWith(image);
  }
  applyCangheWechatStyles(root);
}

export function serializeWeChatArticle(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (!['href', 'src', 'alt', 'title', 'style', 'width', 'height'].includes(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute('href') || '';
      if (!/^(?:https?:|mailto:)/i.test(href)) element.removeAttribute('href');
    }
    if (element instanceof HTMLImageElement) {
      const src = element.getAttribute('src') || '';
      if (!/^https:\/\//i.test(src)) {
        const notice = document.createElement('span');
        notice.textContent = element.alt ? `图片：${element.alt}` : '图片无法随文章发布';
        styles(notice, {
          display: 'block',
          margin: '20px 0',
          color: '#888888',
          fontSize: '13px',
          textAlign: 'center',
        });
        element.replaceWith(notice);
      }
    }
  }
  return clone.innerHTML;
}
