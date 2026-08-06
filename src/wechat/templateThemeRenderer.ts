import { App, Component, MarkdownRenderer, sanitizeHTMLToDom } from 'obsidian';

import { assetMap, replaceAssetTokens } from './assetTokens';
import { inlineTemplateThemeCss } from './templateThemeCss';
import type { LoadedTemplateTheme } from './templateThemeTypes';
import { containerClassForTemplateThemeId } from './templateThemeService';
import type { WeChatPreviewSnapshot } from './types';

interface RenderTemplateThemeOptions {
  uploadedUrls?: Map<string, string>;
}

export function sanitizeTemplateRoot(root: HTMLElement): void {
  for (const forbidden of Array.from(
    root.querySelectorAll('script,style,iframe,object,embed,form,button'),
  )) {
    forbidden.remove();
  }
}

export function replaceTaskCheckboxes(root: HTMLElement): void {
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    const mark = root.createSpan();
    mark.className = 'wesight-wechat-task-checkbox';
    mark.setAttribute('data-checked', String(input.checked));
    mark.textContent = input.checked ? '☑' : '☐';
    input.replaceWith(mark);
  }
}

export function wrapTemplateTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll<HTMLElement>('table'))) {
    if (table.parentElement?.classList.contains('wesight-wechat-table-wrap')) continue;
    const wrapper = root.createEl('section');
    wrapper.className = 'wesight-wechat-table-wrap';
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
}

export function decorateTemplateCodeBlock(pre: HTMLElement): void {
  if (pre.parentElement?.classList.contains('wesight-wechat-code-section')) return;
  const source = pre.querySelector<HTMLElement>(':scope > code');
  const lines = source
    ? source.innerHTML.replace(/\n$/, '').split('\n')
    : [];
  source?.remove();
  for (const lineHtml of lines) {
    const line = pre.createEl('code');
    if (lineHtml) line.appendChild(sanitizeHTMLToDom(lineHtml));
    else line.createEl('br');
    pre.appendChild(line);
  }
  const wrapper = pre.createEl('section');
  wrapper.className = 'wesight-wechat-code-section';
  pre.replaceWith(wrapper);
  wrapper.appendChild(pre);
  const header = pre.createEl('section');
  header.className = 'wesight-wechat-code-header';
  header.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index += 1) {
    const dot = header.createSpan();
    dot.className = 'wesight-wechat-code-dot';
    dot.textContent = '●';
  }
  pre.prepend(header);
}

export function decorateTemplateHeading(heading: HTMLElement): void {
  if (heading.tagName !== 'H2' || heading.querySelector(':scope > .wesight-wechat-h2-tail')) {
    return;
  }
  const tail = heading.createSpan();
  tail.className = 'wesight-wechat-h2-tail';
  tail.setAttribute('aria-hidden', 'true');
}

export function applyTemplateThemeFeatures(
  root: HTMLElement,
  theme: LoadedTemplateTheme,
): void {
  const features = theme.features;
  if (features.replaceTaskCheckbox) replaceTaskCheckboxes(root);
  if (features.wrapTables) wrapTemplateTables(root);
  if (features.decorateCode) {
    for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) {
      decorateTemplateCodeBlock(pre);
    }
  }
  if (features.decorateHeading) {
    for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h2'))) {
      decorateTemplateHeading(heading);
    }
  }
}

export async function renderTemplateThemeArticle(
  app: App,
  component: Component,
  snapshot: WeChatPreviewSnapshot,
  container: HTMLElement,
  theme: LoadedTemplateTheme,
  options: RenderTemplateThemeOptions = {},
): Promise<void> {
  const containerClass = containerClassForTemplateThemeId(theme.manifest.id);
  container.className = containerClass;
  await MarkdownRenderer.render(
    app,
    replaceAssetTokens(snapshot.markdown, assetMap(snapshot, options.uploadedUrls)),
    container,
    snapshot.sourcePath,
    component,
  );
  sanitizeTemplateRoot(container);
  applyTemplateThemeFeatures(container, theme);
  inlineTemplateThemeCss(container, theme.cssText, containerClass);
}
