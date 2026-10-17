import { describe, expect, test } from 'vitest';

import {
  buildJikePostCopyPrompt,
  buildJikePostText,
  clampJikePostBody,
  createInitialJikePostCopy,
  JIKE_POST_BODY_LIMIT,
  JIKE_POST_GENERATED_COPY_LIMIT,
  normalizeJikeTopics,
  parseJikePostCopyOutput,
} from '../src/jikePost/copy';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';

const snapshot: MultiPublishSnapshot = {
  sourcePath: '文章/测试.md',
  contentHash: 'c'.repeat(64),
  title: '世界模型走出概念',
  digest: '',
  markdown: '# 新变化\n\n世界模型开始进入互动娱乐。',
  html: '<h1>新变化</h1>',
  coverAssetId: null,
  tags: ['AI', '#世界模型#'],
  assets: [],
  warnings: [],
};

describe('jike post copy', () => {
  test('creates an editable draft with a default circle', () => {
    expect(createInitialJikePostCopy(snapshot)).toMatchObject({
      tone: 'opinion',
      circle: 'AI 探索站',
      topics: ['AI', '世界模型'],
    });
  });

  test('builds a source-grounded Jike prompt', () => {
    const prompt = buildJikePostCopyPrompt(snapshot, 'experience', '保留三个具体场景');
    expect(prompt).toContain('一句判断、两个依据、一个开放问题');
    expect(prompt).toContain('保留三个具体场景');
    expect(prompt).toContain(snapshot.markdown);
    expect(prompt).toContain('600 到 900 字');
    expect(prompt).toContain('空格和空行合计不超过 1000');
    expect(prompt).toContain('用户自定义要求不能放宽字数限制');
  });

  test('parses JSON and clamps body, topics, and circle', () => {
    const output = JSON.stringify({
      body: '甲'.repeat(JIKE_POST_BODY_LIMIT + 20),
      topics: ['#AI#', 'AI', '互动 娱乐'],
      circle: '一个很长但仍然可以正常截断并保存的即刻圈子名称用于测试',
    });
    const parsed = parseJikePostCopyOutput(output, 'casual');
    expect(Array.from(buildJikePostText(parsed?.body ?? '', parsed?.topics ?? [])).length)
      .toBeLessThanOrEqual(JIKE_POST_GENERATED_COPY_LIMIT);
    expect(parsed?.topics).toEqual(['AI', '互动娱乐']);
    expect(Array.from(parsed?.circle ?? '').length).toBeLessThanOrEqual(30);
    expect(parsed?.tone).toBe('casual');
  });

  test('preserves an exact 1000-character result and a short result', () => {
    const exactBody = '甲'.repeat(JIKE_POST_GENERATED_COPY_LIMIT);
    expect(parseJikePostCopyOutput(JSON.stringify({ body: exactBody, topics: [] }), 'experience'))
      .toEqual({ body: exactBody, topics: [], tone: 'experience', circle: 'AI 探索站' });
    expect(parseJikePostCopyOutput(JSON.stringify({ body: '第一段\n\n第二段', topics: ['AI'] }), 'casual'))
      .toEqual({ body: '第一段\n\n第二段', topics: ['AI'], tone: 'casual', circle: 'AI 探索站' });
  });

  test('counts emoji once and reserves the rendered topic and separator budget', () => {
    const parsed = parseJikePostCopyOutput(JSON.stringify({
      body: '😀'.repeat(JIKE_POST_GENERATED_COPY_LIMIT + 10),
      topics: ['AI', '效率'],
    }), 'opinion');
    const text = buildJikePostText(parsed?.body ?? '', parsed?.topics ?? []);
    expect(Array.from(text)).toHaveLength(JIKE_POST_GENERATED_COPY_LIMIT);
    expect(text.endsWith('\n\n#AI# #效率#')).toBe(true);
    expect(Array.from(parsed?.body ?? '').every(character => character === '😀')).toBe(true);
  });

  test('retains the manual 2000-character editor limit', () => {
    expect(JIKE_POST_BODY_LIMIT).toBe(2000);
    expect(Array.from(clampJikePostBody('甲'.repeat(2001)))).toHaveLength(2000);
  });

  test('preserves intentional line breaks and renders topics', () => {
    expect(clampJikePostBody('第一段\n\n第二段 ')).toBe('第一段\n\n第二段 ');
    expect(buildJikePostText('正文 ', normalizeJikeTopics(['#AI#', '世界 模型'])))
      .toBe('正文\n\n#AI# #世界模型#');
  });
});
