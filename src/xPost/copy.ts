import twitterText from 'twitter-text';

import type { MultiPublishSnapshot } from '../multiPublish/types';
import type { XPostCopyDraft } from './types';

export const X_POST_TEXT_LIMIT = 280;

export function normalizeXPostTopics(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.replace(/^#+|#+$/g, '').replace(/\s+/gu, '').trim())
    .filter(Boolean))).slice(0, 2);
}

export function buildXPostText(body: string, topics: string[]): string {
  return [body.trim(), normalizeXPostTopics(topics).map(topic => `#${topic}`).join(' ')]
    .filter(Boolean).join('\n\n').normalize('NFC');
}

export function xPostWeightedLength(text: string): number {
  return twitterText.parseTweet(text.normalize('NFC')).weightedLength;
}

export function validateXPostCopy(copy: XPostCopyDraft): string | null {
  const text = buildXPostText(copy.body, copy.topics);
  if (!copy.body.trim()) return '请先填写 X 动态正文';
  const parsed = twitterText.parseTweet(text);
  if (parsed.weightedLength > X_POST_TEXT_LIMIT) {
    return `X 动态正文和话题合计不能超过 ${X_POST_TEXT_LIMIT} 字符（中文通常计 2）`;
  }
  return parsed.valid ? null : 'X 文案包含无法发布的字符，请调整后重试';
}

export function buildXPostCopyPrompt(snapshot: MultiPublishSnapshot, customPrompt: string): string {
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    '请将下面的文章改写成一条适合 X 发布的简短图文动态。',
    '仅返回 JSON，格式：{"body":"动态正文","topics":["话题"]}。',
    '要求：',
    '- 正文用一至三句完整的话表达一个核心观点，保留原文的关键事实，避免机械截断长文章。',
    '- 正文建议为 70 到 100 个中文字；中文、日文和韩文通常每字计 2 字符，英文通常计 1，链接统一计 23。',
    '- 正文、话题、空格与空行合计必须在 X 的 280 加权字符以内，建议预留余量控制在 250 以内。',
    '- 不单独生成标题，不重复标题，不虚构数据或经历，不使用 Markdown 格式。',
    '- 话题可为空，最多 2 个，话题不要带 #；优先保留完整表达，再考虑话题。',
    '- 用户自定义要求不能放宽字符限制。',
    customPrompt.trim() ? `用户自定义要求：${customPrompt.trim()}` : '',
    '===== 原文 START =====', article, '===== 原文 END =====',
  ].filter(Boolean).join('\n');
}

export function parseXPostCopyOutput(output: string): XPostCopyDraft | null {
  const cleaned = output.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const body = typeof record.body === 'string' ? record.body.trim().normalize('NFC') : '';
    const topics = Array.isArray(record.topics)
      ? normalizeXPostTopics(record.topics.filter((topic): topic is string => typeof topic === 'string'))
      : [];
    const copy = { body, topics };
    // Keep complete sentences. An invalid or oversized response must be regenerated.
    return validateXPostCopy(copy) ? null : copy;
  } catch {
    return null;
  }
}
