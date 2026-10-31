import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

// smartcanvas.edit accepts the components defined by the official MDX reference,
// rather than the Markdown format accepted by create_smartcanvas_by_mdx.
// https://cdn.addon.tencentsuite.com/static/tencent-docs.zip (smartcanvas/mdx_references.md)
function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][\da-zA-Z]*);)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')
    .replace(/[\\*_`]/g, character => `&#${character.charCodeAt(0)};`)
    .replace(/^(import|export)(?=\s)/gm, word => `&#${word.charCodeAt(0)};${word.slice(1)}`);
}

function attribute(value: string): string {
  // Quoted attribute values are literal: Markdown escaping would alter image IDs.
  return value.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
}

function htmlText(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|center|h[1-6]|li)>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

function indent(value: string): string {
  return value.split('\n').map(line => line ? `    ${line}` : '').join('\n');
}

function component(name: string, content: string, attributes = ''): string {
  return `<${name}${attributes}>\n${indent(content.trim())}\n</${name}>`;
}

function plainInline(tokens: Token[]): string {
  return tokens.map(raw => {
    const token = raw as MarkedToken;
    if ('tokens' in token && token.tokens) return plainInline(token.tokens);
    if (token.type === 'html') return htmlText(token.text);
    return 'text' in token ? token.text : '';
  }).join('');
}

function styledText(value: string, style: TextStyle): string {
  const content = escapeText(value);
  const attributes = ['bold', 'italic', 'strike'].filter(key => style[key as keyof TextStyle]);
  return attributes.length && content.trim()
    ? `<Mark ${attributes.join(' ')}>${content.replace(/\r?\n/g, ' ')}</Mark>`
    : content;
}

function renderInline(tokens: Token[], style: TextStyle = {}): string {
  return tokens.map(raw => {
    const token = raw as MarkedToken;
    switch (token.type) {
      case 'strong': return renderInline(token.tokens, { ...style, bold: true });
      case 'em': return renderInline(token.tokens, { ...style, italic: true });
      case 'del': return renderInline(token.tokens, { ...style, strike: true });
      case 'link': {
        const label = plainInline(token.tokens).replace(/\r?\n/g, ' ');
        // Avoid active links with executable schemes when converting user content.
        if (/^(?:javascript|vbscript|data):/i.test(token.href.trim())) return styledText(label, style);
        // Current edit responses discard Link destinations, including Markdown links.
        // Preserve a visible address as well so updating never drops the target.
        const address = label === token.href ? '' : ` (${escapeText(token.href)})`;
        return `<Link href="${attribute(token.href)}">${escapeText(label)}</Link>${address}`;
      }
      case 'image': return `\n\n<Image src="${attribute(token.href)}" alt="${attribute(plainInline(token.tokens))}" />\n\n`;
      case 'codespan': {
        const longest = Math.max(0, ...Array.from(token.text.matchAll(/`+/g), match => match[0].length));
        const fence = '`'.repeat(longest + 1);
        return `${fence} ${token.text} ${fence}`;
      }
      case 'br': return '\n';
      case 'html': return styledText(htmlText(token.text), style);
      case 'escape': return styledText(token.text, style);
      case 'text': return token.tokens ? renderInline(token.tokens, style) : styledText(token.text, style);
      default: return 'text' in token ? styledText(String(token.text), style) : '';
    }
  }).join('');
}

function renderList(token: Tokens.List): string {
  return token.items.map(item => {
    const name = item.task ? 'Todo' : token.ordered ? 'NumberedList' : 'BulletedList';
    // The first child of a list item must be text; nested lists follow that text.
    const content = renderBlocks(item.tokens.filter(child => child.type !== 'checkbox'));
    return component(name, content, item.task && item.checked ? ' checked' : '');
  }).join('\n');
}

function renderTable(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows].map(row => component('TableRow', row.map(cell => component('TableCell', renderInline(cell.tokens))).join('\n')));
  return component('Table', rows.join('\n'));
}

function renderBlocks(tokens: Token[]): string {
  return tokens.map(raw => {
    const token = raw as MarkedToken;
    switch (token.type) {
      case 'space': case 'def': case 'checkbox': return '';
      case 'heading': return `${'#'.repeat(token.depth)} ${renderInline(token.tokens)}`;
      case 'paragraph': return renderInline(token.tokens).trim();
      case 'text': return token.tokens ? renderInline(token.tokens).trim() : escapeText(token.text);
      case 'hr': return '---';
      case 'blockquote': return component('BlockQuote', renderBlocks(token.tokens));
      case 'list': return renderList(token);
      case 'table': return renderTable(token);
      case 'code': {
        const longest = Math.max(2, ...Array.from(token.text.matchAll(/`+/g), match => match[0].length));
        const fence = '`'.repeat(longest + 1);
        const language = token.lang?.split(/\s/, 1)[0].replace(/[^\w+-]/g, '') ?? '';
        return `${fence}${language}\n${token.text}\n${fence}`;
      }
      case 'html': return escapeText(htmlText(token.text)).trim();
      default: return renderInline([token]).trim();
    }
  }).filter(Boolean).join('\n\n');
}

/** Convert a prepared share Markdown body to Tencent's editable MDX subset. */
export function markdownToTencentMdx(markdown: string): string {
  return renderBlocks(Lexer.lex(markdown, { gfm: true }));
}
