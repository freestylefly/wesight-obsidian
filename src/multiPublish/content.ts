function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeUrl(value: string, image = false): string | null {
  const decoded = value.trim();
  if (image && /^(?:wesight-asset|https?):\/\//i.test(decoded)) return decoded;
  if (/^(?:https?:\/\/|mailto:|#)/i.test(decoded)) return decoded;
  return null;
}

function inlineMarkdown(value: string): string {
  const codeTokens: string[] = [];
  let result = value.replace(/`([^`]+)`/g, (_full, code: string) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  result = escapeHtml(result);
  result = result.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_full, alt: string, url: string) => {
    const source = safeUrl(url, true);
    return source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}">` : escapeHtml(_full);
  });
  result = result.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_full, label: string, url: string) => {
    const href = safeUrl(url);
    return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  });
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  for (let index = 0; index < codeTokens.length; index += 1) {
    result = result.replace(`\u0000CODE${index}\u0000`, codeTokens[index]);
  }
  return result;
}

export function markdownToPlatformHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let quote: string[] = [];
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    output.push(`<blockquote><p>${inlineMarkdown(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };

  for (const line of lines) {
    const fence = /^```\s*([\w+-]*)/.exec(line);
    if (code) {
      if (/^```\s*$/.test(line)) {
        output.push(`<pre><code${code.language ? ` class="language-${escapeHtml(code.language)}"` : ''}>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      closeList();
      flushQuote();
      code = { language: fence[1] ?? '', lines: [] };
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      flushQuote();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^(?:[-*+]\s+|(\d+)\.\s+)(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      flushQuote();
      const nextList = item[1] ? 'ol' : 'ul';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${inlineMarkdown(item[2])}</li>`);
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      closeList();
      quote.push(quoted[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      flushQuote();
      continue;
    }
    closeList();
    flushQuote();
    paragraph.push(line.trim());
  }
  if (code) output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  flushParagraph();
  closeList();
  flushQuote();
  return output.join('\n');
}

/** Remove only the article's leading publication decoration, keeping HTML examples in the body. */
export function stripLeadingPublishDecoration(markdown: string): string {
  let result = markdown.replace(/^\uFEFF/, '').trimStart();
  const badge = /^(?:<center\b[^>]*>[\s\S]*?<\/center>|<p\b[^>]*(?:text-align\s*:\s*center|align=["']?center)[^>]*>[\s\S]*?<\/p>|<span\b[^>]*style=["'][^"']*background[^"']*["'][^>]*>[\s\S]*?<\/span>)\s*/i;
  while (true) {
    const match = badge.exec(result);
    if (!match) break;
    const plain = match[0].replace(/<[^>]+>/g, '').trim();
    const styled = /<span\b[^>]*style=["'][^"']*background/i.test(match[0]);
    if (!/第\s*\d+\s*篇.*原创/.test(plain) && !(styled && plain.length <= 120)) break;
    result = result.slice(match[0].length).trimStart();
  }
  return result;
}
