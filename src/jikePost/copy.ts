import type { MultiPublishSnapshot } from '../multiPublish/types';
import { toXhsPlainText } from '../xiaohongshu/copy';
import type { JikePostCopyDraft, JikePostTone } from './types';

export const JIKE_POST_BODY_LIMIT = 2000;
export const JIKE_POST_GENERATED_COPY_LIMIT = 1000;
export const JIKE_POST_PREVIEW_LIMIT = 520;
export const JIKE_POST_MAX_TOPICS = 6;
export const JIKE_POST_TOPIC_LIMIT = 20;
export const JIKE_POST_TOPICS_CHAR_LIMIT = 60;
export const JIKE_POST_CIRCLE_LIMIT = 30;
export const JIKE_DEFAULT_CIRCLE = 'AI 探索站';

const TONE_INSTRUCTIONS: Record<JikePostTone, string> = {
  opinion: '用一句清楚判断开场，随后给出两个来自原文的依据，结尾留下一个自然、具体的问题。',
  experience: '从真实体验或观察切入，保留必要细节，表达克制且有个人感受。',
  casual: '像和熟悉的即友聊天，轻松自然，段落短，结尾方便继续讨论。',
};

export function clampJikePostBody(value: string): string {
  return Array.from(value).slice(0, JIKE_POST_BODY_LIMIT).join('');
}

export function clampJikeCircle(value: string): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, JIKE_POST_CIRCLE_LIMIT).join('');
}

export function normalizeJikeTopics(values: string[]): string[] {
  const topics: string[] = [];
  for (const value of values) {
    const topic = Array.from(value.replace(/^#+|#+$/g, '').trim().replace(/\s+/g, ''))
      .slice(0, JIKE_POST_TOPIC_LIMIT)
      .join('');
    if (!topic || topics.includes(topic)) continue;
    const next = [...topics, topic];
    const renderedLength = Array.from(next.map(item => `#${item}#`).join(' ')).length;
    if (renderedLength > JIKE_POST_TOPICS_CHAR_LIMIT) continue;
    topics.push(topic);
    if (topics.length >= JIKE_POST_MAX_TOPICS) break;
  }
  return topics;
}

export function buildJikePostText(body: string, topics: string[]): string {
  const topicText = normalizeJikeTopics(topics).map(topic => `#${topic}#`).join(' ');
  return [body.trim(), topicText].filter(Boolean).join('\n\n');
}

export function createInitialJikePostCopy(snapshot: MultiPublishSnapshot): JikePostCopyDraft {
  const plain = toXhsPlainText(snapshot.markdown);
  const body = clampJikePostBody(plain.length > 760 ? `${plain.slice(0, 760).trim()}…` : plain);
  return {
    body,
    topics: normalizeJikeTopics(snapshot.tags),
    tone: 'opinion',
    circle: JIKE_DEFAULT_CIRCLE,
  };
}

export function buildJikePostCopyPrompt(
  snapshot: MultiPublishSnapshot,
  tone: JikePostTone,
  customPrompt: string,
): string {
  const article = snapshot.markdown.length > 16_000
    ? `${snapshot.markdown.slice(0, 16_000)}\n（后文已省略）`
    : snapshot.markdown;
  return [
    '请将下面的长文章改写成一条适合即刻社区发布的图文动态。',
    '仅返回 JSON，不要使用 Markdown 代码围栏。',
    'JSON 格式：{"body":"动态正文","topics":["话题1","话题2"],"circle":"推荐圈子"}',
    '要求：',
    '- 文案建议保持在 600 到 900 字，表达简洁，避免为了凑字数扩写。',
    `- 正文、最终话题及其间空格和空行合计不超过 ${JIKE_POST_GENERATED_COPY_LIMIT} 个 Unicode 字符。`,
    '- 用户自定义要求不能放宽字数限制。',
    `- 当前表达方式：${TONE_INSTRUCTIONS[tone]}`,
    '- 优先使用“一句判断、两个依据、一个开放问题”的结构，结构不适合原文时可自然调整。',
    '- 开头直接进入观点或具体体验，不复述文章标题。',
    '- 使用短段落，保留原文事实和关键细节，避免营销口吻。',
    '- 话题 2 到 5 个，不要带 #。',
    '- 推荐一个贴近内容的即刻圈子名称；不确定时返回“AI 探索站”。',
    '- 不虚构数据、经历、品牌或结论。',
    customPrompt.trim() ? `用户自定义要求：${customPrompt.trim()}` : '',
    '===== 原文 START =====',
    article,
    '===== 原文 END =====',
  ].filter(Boolean).join('\n');
}

export function parseJikePostCopyOutput(
  output: string,
  tone: JikePostTone,
): JikePostCopyDraft | null {
  const cleaned = output.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const topics = Array.isArray(record.topics)
      ? normalizeJikeTopics(record.topics.filter((item): item is string => typeof item === 'string'))
      : [];
    const topicText = topics.map(topic => `#${topic}#`).join(' ');
    const bodyLimit = Math.max(0, JIKE_POST_GENERATED_COPY_LIMIT - Array.from(topicText).length - (topicText ? 2 : 0));
    const body = typeof record.body === 'string'
      ? Array.from(record.body).slice(0, bodyLimit).join('')
      : '';
    if (!body.trim()) return null;
    const circle = typeof record.circle === 'string'
      ? clampJikeCircle(record.circle) || JIKE_DEFAULT_CIRCLE
      : JIKE_DEFAULT_CIRCLE;
    return { body, topics, tone, circle };
  } catch {
    return null;
  }
}

export function jikePostPreview(body: string): string {
  return Array.from(body.trim()).slice(0, JIKE_POST_PREVIEW_LIMIT).join('');
}
