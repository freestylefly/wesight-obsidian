export interface ParsedCssRule {
  selectors: string[];
  declarations: Array<{ property: string; value: string }>;
}

export interface ParsedCss {
  rules: ParsedCssRule[];
}

const UNSAFE_CSS = /(?:position\s*:\s*(?:fixed|sticky)|float\s*:|display\s*:\s*grid|var\s*\(\s*--|@media|@keyframes|@import|url\s*\()/i;

function stripCssComments(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseTopLevelBlocks(cssText: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  const text = stripCssComments(cssText);
  let index = 0;
  while (index < text.length) {
    let braceIndex = -1;
    let depth = 0;
    for (let scan = index; scan < text.length; scan += 1) {
      const char = text[scan];
      if (char === '{') {
        if (depth === 0) {
          braceIndex = scan;
          break;
        }
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (braceIndex === -1) break;
    let closeIndex = -1;
    depth = 1;
    for (let scan = braceIndex + 1; scan < text.length; scan += 1) {
      const char = text[scan];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = scan;
          break;
        }
      }
    }
    if (closeIndex === -1) {
      throw new Error('CSS 括号不匹配');
    }
    const selector = text.slice(index, braceIndex).trim();
    const body = text.slice(braceIndex + 1, closeIndex).trim();
    if (selector) {
      blocks.push({ selector, body });
    }
    index = closeIndex + 1;
  }
  return blocks;
}

export function parseTemplateThemeCss(cssText: string): ParsedCss {
  const rules: ParsedCssRule[] = [];
  for (const block of parseTopLevelBlocks(cssText)) {
    if (!block.selector) continue;
    const selectors = block.selector
      .split(',')
      .map(selector => selector.trim())
      .filter(Boolean);
    const declarations: Array<{ property: string; value: string }> = [];
    for (const declaration of block.body.split(';')) {
      const trimmed = declaration.trim();
      if (!trimmed) continue;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;
      const property = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      if (property && value) {
        declarations.push({ property, value });
      }
    }
    if (selectors.length && declarations.length) {
      rules.push({ selectors, declarations });
    }
  }
  return { rules };
}

export function validateTemplateThemeCss(cssText: string): string[] {
  const errors: string[] = [];
  if (!cssText.trim()) {
    errors.push('CSS 内容为空');
    return errors;
  }
  let parsed: ParsedCss;
  try {
    parsed = parseTemplateThemeCss(cssText);
  } catch (error) {
    errors.push(`CSS 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }
  for (const rule of parsed.rules) {
    for (const selector of rule.selectors) {
      if (selector.includes('@')) {
        errors.push(`CSS 不支持 @ 规则：${selector}`);
      }
    }
    for (const { property, value } of rule.declarations) {
      if (UNSAFE_CSS.test(`${property}:${value}`)) {
        errors.push(`CSS 包含不安全声明：${property}: ${value}`);
      }
    }
  }
  return errors;
}

export function inlineTemplateThemeCss(
  root: HTMLElement,
  cssText: string,
  containerClass: string,
): void {
  const parsed = parseTemplateThemeCss(cssText);
  for (const rule of parsed.rules) {
    for (const selector of rule.selectors) {
      let targets: HTMLElement[];
      if (selector === `.${containerClass}`) {
        targets = [root];
      } else {
        targets = Array.from(root.querySelectorAll<HTMLElement>(selector));
      }
      for (const element of targets) {
        for (const { property, value } of rule.declarations) {
          element.style.setProperty(property, value);
        }
      }
    }
  }
}

export function scopeTemplateThemeCss(
  cssText: string,
  containerClass: string,
): string {
  // 允许资源包直接写 .wesight-wechat-template-<id> 作用域；
  // 如果用户复制 note-to-mp 的 .note-to-mp 主题，可以在这里做替换。
  return cssText.replace(/\.note-to-mp\b/g, `.${containerClass}`);
}
