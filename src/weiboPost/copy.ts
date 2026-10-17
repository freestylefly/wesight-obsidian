import type { MultiPublishSnapshot } from '../multiPublish/types';
import { toXhsPlainText } from '../xiaohongshu/copy';
import type { WeiboPostCopyDraft, WeiboPostTone } from './types';

export const WEIBO_POST_BODY_LIMIT = 2000;
export const WEIBO_POST_GENERATED_COPY_LIMIT = 1000;
export const WEIBO_POST_PREVIEW_LIMIT = 140;
export const WEIBO_POST_MAX_TOPICS = 10;
export const WEIBO_POST_TOPIC_LIMIT = 20;
export const WEIBO_POST_TOPICS_CHAR_LIMIT = 60;

const TONE_INSTRUCTIONS: Record<WeiboPostTone, string> = {
  opinion: '观点明确，开头直接给出判断，随后用原文事实支撑，结尾留下一个自然讨论问题。',
  news: '先交代核心信息，再补充背景和影响，表达客观清楚，避免夸张。',
  casual: '像向熟悉的朋友分享新发现，语气自然轻松，同时保留关键事实。',
};

export function clampWeiboPostBody(value: string): string {
  return Array.from(value).slice(0, WEIBO_POST_BODY_LIMIT).join('');
}

export function buildWeiboPostText(body: string, topics: string[]): string {
  const topicText = normalizeWeiboTopics(topics).map(topic => `#${topic}#`).join(' ');
  return [body.trim(), topicText].filter(Boolean).join('\n\n');
}

export function normalizeWeiboTopics(values: string[]): string[] {
  const topics: string[] = [];
  for (const value of values) {
    const topic = Array.from(value.replace(/^#+|#+$/g, '').trim().replace(/\s+/g, ''))
      .slice(0, WEIBO_POST_TOPIC_LIMIT)
      .join('');
    if (!topic || topics.includes(topic)) continue;
    const next = [...topics, topic];
    const renderedLength = Array.from(next.map(item => `#${item}#`).join(' ')).length;
    if (renderedLength > WEIBO_POST_TOPICS_CHAR_LIMIT) continue;
    topics.push(topic);
    if (topics.length >= WEIBO_POST_MAX_TOPICS) break;
  }
  return topics;
}

export function createInitialWeiboPostCopy(snapshot: MultiPublishSnapshot): WeiboPostCopyDraft {
  const plain = toXhsPlainText(snapshot.markdown);
  const body = clampWeiboPostBody(plain.length > 900 ? `${plain.slice(0, 900).trim()}…` : plain);
  return {
    body,
    topics: normalizeWeiboTopics(snapshot.tags),
    tone: 'opinion',
  };
}

export function buildWeiboPostCopyPrompt(
  snapshot: MultiPublishSnapshot,
  tone: WeiboPostTone,
  customPrompt: string,
): string {
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    '请将下面的文章改写成一条适合微博信息流阅读的图文动态。',
    '仅返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 格式：{"body":"微博正文","topics":["话题1","话题2"]}',
    '要求：',
    '- 文案建议保持在 600 到 900 字，表达简洁，避免为了凑字数扩写。',
    `- 正文、最终话题及其间空格和空行合计不超过 ${WEIBO_POST_GENERATED_COPY_LIMIT} 个 Unicode 字符。`,
    '- 用户自定义要求不能放宽字数限制。',
    `- 当前语气：${TONE_INSTRUCTIONS[tone]}`,
    '- 前 140 字独立成立，用户收起正文时仍能理解核心信息。',
    '- 分段清楚，可使用少量自然符号增强阅读节奏。',
    '- 话题 2 到 6 个，不要带 #。',
    '- 保留原文事实与核心观点，不虚构数据、经历、品牌或结论。',
    customPrompt.trim() ? `用户自定义要求：${customPrompt.trim()}` : '',
    '===== 原文 START =====',
    article,
    '===== 原文 END =====',
  ].filter(Boolean).join('\n');
}

export function parseWeiboPostCopyOutput(
  output: string,
  tone: WeiboPostTone,
): WeiboPostCopyDraft | null {
  const cleaned = output.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const topics = Array.isArray(record.topics)
      ? normalizeWeiboTopics(record.topics.filter((item): item is string => typeof item === 'string'))
      : [];
    const topicText = topics.map(topic => `#${topic}#`).join(' ');
    const separatorLength = topicText ? 2 : 0;
    const bodyLimit = Math.max(0, WEIBO_POST_GENERATED_COPY_LIMIT - Array.from(topicText).length - separatorLength);
    const body = typeof record.body === 'string'
      ? Array.from(record.body).slice(0, bodyLimit).join('')
      : '';
    if (!body) return null;
    return { body, topics, tone };
  } catch {
    return null;
  }
}

export function weiboPostPreview(body: string): string {
  return Array.from(body.trim()).slice(0, WEIBO_POST_PREVIEW_LIMIT).join('');
}
