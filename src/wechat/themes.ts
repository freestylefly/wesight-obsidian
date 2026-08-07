import { createHash } from 'crypto';

import type { WeChatPreviewSnapshot } from './types';

// 主题 id 不再使用联合类型：模板主题可以通过资源包动态注册。
export type WeChatThemeId = string;
export type BuiltInWeChatThemeId =
  | 'moyu-green'
  | 'red-white'
  | 'graphite-minimal'
  | 'zen-whitespace'
  | 'moyu-ticket'
  | 'olive-journal'
  | 'ai-custom';

export type WeChatThemeKind = 'template' | 'skill' | 'custom';

export interface WeChatThemeDefinition {
  id: WeChatThemeId;
  label: string;
  kind: WeChatThemeKind;
  color: string;
  skillReference?: string;
}

export interface WeChatCustomThemePreferences {
  name: string;
  description: string;
}

export interface WeChatThemeDocument {
  themeId: WeChatThemeId;
  sourceHash: string;
  contentHash: string;
  html: string | null;
  generatedAt: string | null;
  generatorSignature: string;
}

export const DEFAULT_WECHAT_THEME_ID: WeChatThemeId = 'canghe-style-tes';

export const WECHAT_THEME_DEFINITIONS: readonly WeChatThemeDefinition[] = [
  {
    id: 'moyu-green',
    label: '摸鱼绿',
    kind: 'skill',
    color: '#059669',
    skillReference: 'references/theme-moyu-green.md',
  },
  {
    id: 'red-white',
    label: '红白色系',
    kind: 'skill',
    color: '#dc2626',
    skillReference: 'references/theme-red-white.md',
  },
  {
    id: 'graphite-minimal',
    label: '石墨极简风',
    kind: 'skill',
    color: '#52525b',
    skillReference: 'references/theme-graphite-minimal.md',
  },
  {
    id: 'zen-whitespace',
    label: '留白禅意风',
    kind: 'skill',
    color: '#4a5d52',
    skillReference: 'references/theme-zen-whitespace.md',
  },
  {
    id: 'moyu-ticket',
    label: '摸鱼票据风',
    kind: 'skill',
    color: '#f0b84b',
    skillReference: 'references/theme-moyu-ticket.md',
  },
  {
    id: 'olive-journal',
    label: '橄榄手记',
    kind: 'skill',
    color: '#8a8f32',
    skillReference: 'references/theme-olive-journal.md',
  },
  {
    id: 'ai-custom',
    label: 'AI自定义主题',
    kind: 'custom',
    color: '#8b5cf6',
  },
] as const;

let templateThemeDefinitions: readonly WeChatThemeDefinition[] = [];

export function setTemplateThemeDefinitions(
  definitions: readonly WeChatThemeDefinition[],
): void {
  templateThemeDefinitions = [...definitions];
}

export function getAllWeChatThemeDefinitions(): readonly WeChatThemeDefinition[] {
  return [...WECHAT_THEME_DEFINITIONS, ...templateThemeDefinitions];
}

function themeById(): Map<WeChatThemeId, WeChatThemeDefinition> {
  return new Map(getAllWeChatThemeDefinitions().map(theme => [theme.id, theme]));
}

export function isWeChatThemeId(value: unknown): value is WeChatThemeId {
  return typeof value === 'string' && themeById().has(value);
}

export function getWeChatTheme(themeId: WeChatThemeId): WeChatThemeDefinition {
  const map = themeById();
  return (
    map.get(themeId) ??
    map.get(DEFAULT_WECHAT_THEME_ID) ??
    WECHAT_THEME_DEFINITIONS.find(theme => theme.kind === 'template') ??
    WECHAT_THEME_DEFINITIONS[0]
  );
}

export function listWeChatThemes(kind: WeChatThemeKind): WeChatThemeDefinition[] {
  return getAllWeChatThemeDefinitions().filter(theme => theme.kind === kind);
}

export function createTemplateThemeDocument(
  snapshot: WeChatPreviewSnapshot,
  themeId: WeChatThemeId = DEFAULT_WECHAT_THEME_ID,
): WeChatThemeDocument {
  return {
    themeId,
    sourceHash: snapshot.themeSourceHash,
    contentHash: snapshot.contentHash,
    html: null,
    generatedAt: null,
    generatorSignature: snapshot.rendererVersion,
  };
}

export function hashSkillThemeDocument(values: {
  sourceHash: string;
  themeId: string;
  html: string;
  generatorSignature: string;
}): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
