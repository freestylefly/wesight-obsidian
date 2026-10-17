import type { MultiPublishSnapshot } from '../multiPublish/types';
import type {
  XhsCopyDraft,
  XhsPageContent,
  XhsPageContentSource,
  XhsPageOutline,
} from './types';

export const XHS_TITLE_LIMIT = 20;
export const XHS_BODY_LIMIT = 1000;
export const XHS_MAX_TAGS = 8;
export const XHS_PAGE_TEXT_LIMIT = 100;
const XHS_TAG_LIMIT = 20;

export function toXhsPlainText(value: string): string {
  return value
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)、]\s+)/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clampXhsTitle(value: string): string {
  return Array.from(value.trim()).slice(0, XHS_TITLE_LIMIT).join('');
}

export function normalizeXhsTags(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const tag = value.replace(/^#+/, '').trim().replace(/\s+/g, '');
    if (!tag || result.includes(tag)) continue;
    result.push(tag);
    if (result.length >= XHS_MAX_TAGS) break;
  }
  return result;
}

/** The exact text sent to the Xiaohongshu body editor, including topic markers. */
export function buildXhsPostText(body: string, tags: string[]): string {
  const topics = tags.map(tag => tag.replace(/^#+|#+$/g, '').trim())
    .filter(Boolean).map(tag => `#${tag}`).join(' ');
  return [body.trim(), topics].filter(Boolean).join('\n\n');
}

/** Keep generated copy within the platform limit even when the model ignores it. */
export function clampXhsCopy(copy: XhsCopyDraft): XhsCopyDraft {
  const tags = normalizeXhsTags(normalizeXhsTags(copy.tags)
    .map(tag => Array.from(tag).slice(0, XHS_TAG_LIMIT).join('')));
  const tagLength = Array.from(buildXhsPostText('', tags)).length;
  const bodyBudget = XHS_BODY_LIMIT - tagLength - (tags.length ? 2 : 0);
  const body = clampXhsBody(copy.body.trim(), bodyBudget);
  return { ...copy, title: clampXhsTitle(copy.title), body, tags };
}

function clampXhsBody(body: string, budget: number): string {
  const characters = Array.from(body);
  if (characters.length <= budget) return body;
  const prefix = characters.slice(0, budget - 1).join('').trimEnd();
  const minimumBoundary = Math.floor(budget * 0.6);
  const boundaries = [
    ...Array.from(prefix.matchAll(/\n\s*\n/g), match => match.index),
    ...Array.from(prefix.matchAll(/[。！？!?](?:[”’」』）)\]]*)/g), match => match.index + match[0].length),
  ];
  const boundary = boundaries.filter(index => Array.from(prefix.slice(0, index)).length >= minimumBoundary)
    .sort((a, b) => b - a)[0];
  return boundary === undefined ? `${prefix}…` : prefix.slice(0, boundary).trimEnd();
}

export function createInitialXhsCopy(snapshot: MultiPublishSnapshot): XhsCopyDraft {
  const plain = toXhsPlainText(snapshot.markdown);
  const tags = normalizeXhsTags(snapshot.tags.length ? snapshot.tags : inferTags(snapshot.markdown));
  return clampXhsCopy({
    title: clampXhsTitle(snapshot.title),
    body: plain,
    tags,
  });
}

function inferTags(markdown: string): string[] {
  const headings = Array.from(markdown.matchAll(/^#{1,3}\s+(.+)$/gm))
    .map(match => match[1].replace(/[\d.、：:]/g, '').trim())
    .filter(value => value.length >= 2 && value.length <= 10);
  return headings.slice(0, 5);
}

export function buildXhsCopyPrompt(snapshot: MultiPublishSnapshot, requirement: string): string {
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    '请将下面的长文章改写成一篇可编辑的小红书图文笔记文案。',
    '仅返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 格式：{"title":"不超过20个字符","body":"正文","tags":["标签1","标签2"]}',
    '要求：',
    '- 标题必须不超过 20 个 Unicode 字符。',
    '- 正文保留原文事实与核心观点，语言自然、具体、适合小红书阅读。',
    '- 正文建议 600 到 900 字，内容较少时保持简洁，不为凑字数扩写。',
    '- 正文分段清楚，可使用少量自然的符号增强节奏。',
    '- 标签 3 到 8 个，每个不超过 20 个 Unicode 字符，不要带 #。',
    '- 不虚构原文没有的数据、经历或结论。',
    requirement.trim() ? `用户自定义要求：${requirement.trim()}` : '',
    `硬性限制：正文与话题拼接后的总字数必须不超过 ${XHS_BODY_LIMIT} 个 Unicode 字符；话题的 #、空格及正文与话题之间的两个换行也计入字数。此限制优先于用户自定义要求。`,
    '===== 原文 START =====',
    article,
    '===== 原文 END =====',
  ].filter(Boolean).join('\n');
}

export function parseXhsCopyOutput(output: string): XhsCopyDraft | null {
  const parsed = parseJsonObject(output);
  if (!parsed) return null;
  const title = typeof parsed.title === 'string' ? clampXhsTitle(parsed.title) : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  const tags = Array.isArray(parsed.tags)
    ? normalizeXhsTags(parsed.tags.filter((value): value is string => typeof value === 'string'))
    : [];
  if (!title || !body) return null;
  return clampXhsCopy({ title, body, tags });
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const cleaned = output.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function buildXhsPageOutlines(copy: XhsCopyDraft, pageCount: number): XhsPageOutline[] {
  const count = Math.max(1, Math.min(9, Math.round(pageCount)));
  const plainBody = toXhsPlainText(copy.body);
  if (count === 1) {
    return [{ id: 'page-1', label: '封面', content: `${copy.title}\n${plainBody.slice(0, 120)}` }];
  }
  const paragraphs = plainBody
    .split(/\n{2,}|(?=^#{1,3}\s+)/m)
    .map(value => value.trim())
    .filter(Boolean);
  const bodySlots = Math.max(1, count - 2);
  const groups: string[][] = Array.from({ length: bodySlots }, () => []);
  paragraphs.forEach((paragraph, index) => {
    groups[Math.min(bodySlots - 1, Math.floor(index * bodySlots / Math.max(1, paragraphs.length)))].push(paragraph);
  });
  const pages: XhsPageOutline[] = [
    { id: 'page-1', label: '封面', content: copy.title },
  ];
  for (let index = 0; index < bodySlots; index += 1) {
    const content = groups[index].join('\n\n').trim() || plainBody.slice(index * 120, (index + 1) * 120);
    const firstLine = content.split('\n', 1)[0].replace(/^#{1,6}\s*/, '').trim();
    pages.push({
      id: `page-${index + 2}`,
      label: firstLine.slice(0, 12) || `正文 ${index + 1}`,
      content,
    });
  }
  pages.push({
    id: `page-${count}`,
    label: '结尾',
    content: `${copy.body.slice(-180)}\n\n${copy.tags.map(tag => `#${tag}`).join(' ')}`.trim(),
  });
  return pages.slice(0, count);
}

export function createDefaultXhsPageContents(
  copy: XhsCopyDraft,
  pageCount: number,
): XhsPageContent[] {
  return buildXhsPageOutlines(copy, pageCount).map((outline, index) => ({
    pageNumber: index + 1,
    label: outline.label,
    text: clampPageText(index === 0 ? copy.title : outline.content, XHS_PAGE_TEXT_LIMIT),
    textSource: 'article',
  }));
}

export function reconcileXhsPageContents(
  copy: XhsCopyDraft,
  pageCount: number,
  current: XhsPageContent[] | undefined,
): XhsPageContent[] {
  const defaults = createDefaultXhsPageContents(copy, pageCount);
  if (!Array.isArray(current) || current.length === 0) return defaults;
  const byPage = new Map(current.map(page => [page.pageNumber, page]));
  return defaults.map(fallback => {
    const saved = byPage.get(fallback.pageNumber);
    if (!saved) return fallback;
    const record = saved as unknown as Record<string, unknown>;
    const legacyMainText = typeof record.mainText === 'string' ? record.mainText.trim() : '';
    const legacyQuote = typeof record.quote === 'string' ? record.quote.trim() : '';
    const legacyText = legacyMainText && legacyQuote && legacyMainText !== legacyQuote
      ? `${legacyMainText}\n${legacyQuote}`
      : legacyMainText || legacyQuote;
    return {
      pageNumber: fallback.pageNumber,
      label: typeof record.label === 'string' && record.label.trim()
        ? clampPageText(record.label, 16)
        : fallback.label,
      text: typeof record.text === 'string'
        ? clampPageText(record.text, XHS_PAGE_TEXT_LIMIT)
        : legacyText
          ? clampPageText(legacyText, XHS_PAGE_TEXT_LIMIT)
          : fallback.text,
      textSource: isXhsPageContentSource(record.textSource)
        ? record.textSource
        : strongestPageContentSource(record.mainTextSource, record.quoteSource)
          ?? fallback.textSource,
    };
  });
}

export function buildXhsPageContentsPrompt(
  snapshot: MultiPublishSnapshot,
  copy: XhsCopyDraft,
  pageCount: number,
): string {
  const count = Math.max(1, Math.min(9, Math.round(pageCount)));
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    `请为一组 ${count} 张的小红书图片生成逐页文字。`,
    '仅返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 格式：{"pages":[{"pageNumber":1,"label":"封面","text":"图片文字"}]}',
    '要求：',
    `- pages 必须正好包含 ${count} 项，pageNumber 从 1 连续到 ${count}。`,
    `- text 每项不超过 ${XHS_PAGE_TEXT_LIMIT} 个 Unicode 字符，适合手机缩略图阅读。`,
    '- 每页只有一份图片文字，可以是一句话或一段话，不要拆成标题、正文、金句等语义层级。',
    '- 第一张负责吸引阅读，中间页拆解文章结构，最后一张总结收束。',
    '- 各页内容互相衔接，避免重复句式。',
    '- 仅使用原文事实与现有小红书文案，不虚构数据、经历、品牌或结论。',
    `小红书标题：${copy.title}`,
    '小红书正文：',
    copy.body,
    '===== 原文 START =====',
    article,
    '===== 原文 END =====',
  ].join('\n');
}

export function buildXhsSinglePageContentPrompt(
  snapshot: MultiPublishSnapshot,
  copy: XhsCopyDraft,
  page: XhsPageContent,
  pageCount: number,
): string {
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    `请重新生成小红书图片第 ${page.pageNumber}/${pageCount} 张的逐页文字。`,
    '仅返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 格式：{"pageNumber":1,"label":"页面主题","text":"图片文字"}',
    `- text 不超过 ${XHS_PAGE_TEXT_LIMIT} 个 Unicode 字符。`,
    '- 这一页只有一份图片文字，可以是一句话或一段话，不要拆成多个文字层级。',
    '- 内容必须适合该页在整组图片中的位置，并与文章结构一致。',
    '- 仅使用原文事实，不虚构数据、经历、品牌或结论。',
    `小红书标题：${copy.title}`,
    `当前页面主题：${page.label}`,
    `当前图片文字：${page.text}`,
    '===== 原文 START =====',
    article,
    '===== 原文 END =====',
  ].join('\n');
}

export function parseXhsPageContentsOutput(
  output: string,
  pageCount: number,
): XhsPageContent[] | null {
  const parsed = parseJsonObject(output);
  if (!parsed || !Array.isArray(parsed.pages)) return null;
  const count = Math.max(1, Math.min(9, Math.round(pageCount)));
  if (parsed.pages.length !== count) return null;
  const pages = parsed.pages.map((value, index) => parsePageContent(value, index + 1));
  if (pages.some(page => page === null)) return null;
  return pages as XhsPageContent[];
}

export function parseXhsSinglePageContentOutput(
  output: string,
  expectedPageNumber: number,
): XhsPageContent | null {
  return parsePageContent(parseJsonObject(output), expectedPageNumber);
}

function parsePageContent(value: unknown, expectedPageNumber: number): XhsPageContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.pageNumber !== expectedPageNumber) return null;
  const label = typeof record.label === 'string' ? clampPageText(record.label, 16) : '';
  const text = typeof record.text === 'string'
    ? clampPageText(record.text, XHS_PAGE_TEXT_LIMIT)
    : '';
  if (!label || !text) return null;
  return {
    pageNumber: expectedPageNumber,
    label,
    text,
    textSource: 'ai',
  };
}

function clampPageText(value: string, limit: number): string {
  const normalized = toXhsPlainText(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(normalized).slice(0, limit).join('');
}

function isXhsPageContentSource(value: unknown): value is XhsPageContentSource {
  return value === 'article' || value === 'ai' || value === 'manual';
}

function strongestPageContentSource(...values: unknown[]): XhsPageContentSource | null {
  if (values.includes('manual')) return 'manual';
  if (values.includes('ai')) return 'ai';
  if (values.includes('article')) return 'article';
  return null;
}
