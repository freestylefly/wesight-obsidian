export const QUICK_TRANSFORM_PLATFORM_IDS = [
  'xiaohongshu',
  'weibo-post',
  'jike-post',
  'x-post',
] as const;

export type QuickTransformPlatformId = (typeof QUICK_TRANSFORM_PLATFORM_IDS)[number];

export type QuickTransformAccessState = 'login-required' | 'single-platform' | 'multi-platform';

export interface QuickTransformImageCandidate {
  id: string;
}

export function normalizeQuickTransformPlatformIds(
  values: readonly unknown[] | null | undefined,
): QuickTransformPlatformId[] {
  if (!values) return [];
  const selected = new Set(values);
  return QUICK_TRANSFORM_PLATFORM_IDS.filter(platformId => selected.has(platformId));
}

export function restoreQuickTransformPlatformIds(
  savedValues: readonly unknown[] | null | undefined,
  accessState: QuickTransformAccessState,
): QuickTransformPlatformId[] {
  const saved = normalizeQuickTransformPlatformIds(savedValues);
  if (saved.length) {
    return accessState === 'single-platform' ? saved.slice(0, 1) : saved;
  }
  return accessState === 'multi-platform'
    ? [...QUICK_TRANSFORM_PLATFORM_IDS]
    : ['xiaohongshu'];
}

export function hasExplicitQuickTransformPlatformSelection(input: {
  targets?: readonly unknown[] | null;
  targetsExplicit?: boolean;
} | null | undefined): boolean {
  if (!input) return false;
  if (typeof input.targetsExplicit === 'boolean') return input.targetsExplicit;

  const saved = normalizeQuickTransformPlatformIds(input.targets);
  return saved.length > 1 || (saved.length === 1 && saved[0] !== 'xiaohongshu');
}

export function recommendQuickTransformImageIds(
  candidates: QuickTransformImageCandidate[],
  limit = 3,
): string[] {
  const unique = Array.from(new Map(candidates.map(candidate => [candidate.id, candidate])).values());
  const count = Math.max(0, Math.min(Math.floor(limit), unique.length));
  if (count === 0) return [];
  if (count === 1) return [unique[0].id];

  const selected: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidateIndex = Math.round((index * (unique.length - 1)) / (count - 1));
    const id = unique[candidateIndex]?.id;
    if (id && !selected.includes(id)) selected.push(id);
  }

  for (const candidate of unique) {
    if (selected.length >= count) break;
    if (!selected.includes(candidate.id)) selected.push(candidate.id);
  }
  return selected;
}

export function reconcileQuickTransformImageIds(
  selectedIds: string[],
  candidates: QuickTransformImageCandidate[],
  limit = 9,
): string[] {
  const available = new Set(candidates.map(candidate => candidate.id));
  const selected: string[] = [];
  for (const id of selectedIds) {
    if (!available.has(id) || selected.includes(id)) continue;
    selected.push(id);
    if (selected.length >= Math.max(0, Math.floor(limit))) break;
  }
  return selected;
}
