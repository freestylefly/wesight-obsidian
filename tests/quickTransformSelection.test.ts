import { describe, expect, test } from 'vitest';

import {
  QUICK_TRANSFORM_PLATFORM_IDS,
  hasExplicitQuickTransformPlatformSelection,
  normalizeQuickTransformPlatformIds,
  recommendQuickTransformImageIds,
  reconcileQuickTransformImageIds,
  restoreQuickTransformPlatformIds,
} from '../src/quickTransform/selection';

describe('quick transform selection', () => {
  test('defines all four short-form platforms in the intended order', () => {
    expect(QUICK_TRANSFORM_PLATFORM_IDS).toEqual(['xiaohongshu', 'weibo-post', 'jike-post', 'x-post']);
  });

  test('restores a saved three-platform choice while login details are still loading', () => {
    expect(restoreQuickTransformPlatformIds(
      ['jike-post', 'xiaohongshu', 'weibo-post'],
      'login-required',
    )).toEqual(['xiaohongshu', 'weibo-post', 'jike-post']);
  });

  test('limits a saved choice only after a free membership state is known', () => {
    expect(restoreQuickTransformPlatformIds(
      ['xiaohongshu', 'weibo-post', 'jike-post'],
      'single-platform',
    )).toEqual(['xiaohongshu']);
    expect(restoreQuickTransformPlatformIds(undefined, 'multi-platform'))
      .toEqual(['xiaohongshu', 'weibo-post', 'jike-post', 'x-post']);
  });

  test('removes unsupported and duplicate saved platform ids', () => {
    expect(normalizeQuickTransformPlatformIds([
      'jike-post', 'unknown', 'jike-post', 'xiaohongshu',
    ])).toEqual(['xiaohongshu', 'jike-post']);
  });

  test('distinguishes automatic defaults from a saved user choice', () => {
    expect(hasExplicitQuickTransformPlatformSelection(undefined)).toBe(false);
    expect(hasExplicitQuickTransformPlatformSelection({
      targets: ['xiaohongshu'],
      targetsExplicit: false,
    })).toBe(false);
    expect(hasExplicitQuickTransformPlatformSelection({
      targets: ['xiaohongshu'],
      targetsExplicit: true,
    })).toBe(true);
  });

  test('migrates legacy multi-platform and non-default single-platform choices', () => {
    expect(hasExplicitQuickTransformPlatformSelection({
      targets: ['xiaohongshu'],
    })).toBe(false);
    expect(hasExplicitQuickTransformPlatformSelection({
      targets: ['xiaohongshu', 'weibo-post', 'jike-post'],
    })).toBe(true);
    expect(hasExplicitQuickTransformPlatformSelection({
      targets: ['jike-post'],
    })).toBe(true);
  });

  test('recommends three images distributed across the article', () => {
    const images = Array.from({ length: 8 }, (_, index) => ({ id: `image-${index + 1}` }));
    expect(recommendQuickTransformImageIds(images)).toEqual(['image-1', 'image-5', 'image-8']);
  });

  test('handles small articles and removes duplicate candidates', () => {
    expect(recommendQuickTransformImageIds([
      { id: 'cover' },
      { id: 'cover' },
      { id: 'body' },
    ])).toEqual(['cover', 'body']);
  });

  test('keeps the chosen order while removing missing and duplicate images', () => {
    expect(reconcileQuickTransformImageIds(
      ['three', 'missing', 'one', 'three', 'two'],
      [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
      2,
    )).toEqual(['three', 'one']);
  });
});
