import {
  clampJikePostBody,
  normalizeJikeTopics,
} from '../jikePost/copy';
import type { JikePostCopyDraft } from '../jikePost/types';
import {
  clampWeiboPostBody,
  normalizeWeiboTopics,
} from '../weiboPost/copy';
import type { WeiboPostCopyDraft } from '../weiboPost/types';
import type { XhsCopyDraft } from '../xiaohongshu/types';
import { XHS_BODY_LIMIT } from '../xiaohongshu/copy';

export const QUICK_TRANSFORM_COPY_MODES = ['shared', 'platform'] as const;

export type QuickTransformCopyMode = (typeof QUICK_TRANSFORM_COPY_MODES)[number];

export function sharedCopyRequirement(requirement: string): string {
  return [
    '这套文案会同时发布到小红书、微博和即刻，请使用三个平台都适合的自然表达。',
    '正文保持平台中性，不使用“姐妹们”等单一平台专属称呼。',
    requirement.trim(),
  ].filter(Boolean).join('\n');
}

export function sharedCopyToWeibo(
  shared: XhsCopyDraft,
  current: WeiboPostCopyDraft,
): WeiboPostCopyDraft {
  const topics = normalizeWeiboTopics(shared.tags);
  return {
    body: clampSharedBody(clampWeiboPostBody(shared.body), topics),
    topics,
    tone: current.tone,
  };
}

export function sharedCopyToJike(
  shared: XhsCopyDraft,
  current: JikePostCopyDraft,
): JikePostCopyDraft {
  const topics = normalizeJikeTopics(shared.tags);
  return {
    body: clampSharedBody(clampJikePostBody(shared.body), topics),
    topics,
    tone: current.tone,
    circle: current.circle,
  };
}

function clampSharedBody(body: string, topics: string[]): string {
  const suffix = topics.map(topic => `#${topic}#`).join(' ');
  const budget = XHS_BODY_LIMIT - (suffix ? Array.from(suffix).length + 2 : 0);
  return Array.from(body).slice(0, Math.max(0, budget)).join('').trim();
}

export function parseQuickTopics(value: string): string[] {
  return value
    .split(/[#\s，,]+/u)
    .map(topic => topic.trim())
    .filter(Boolean);
}
