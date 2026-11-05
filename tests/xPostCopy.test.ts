import { describe, expect, test, vi } from 'vitest';

import { buildXPostCopyPrompt, buildXPostText, createInitialXPostCopy, parseXPostCopyOutput, validateXPostCopy, xPostWeightedLength } from '../src/xPost/copy';
import { XiaohongshuGenerationService } from '../src/xiaohongshu/generationService';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';

const source = { markdown: '原文核心观点：为长期合作保留上下文。' } as MultiPublishSnapshot;

describe('X short-form copy', () => {
  test('initializes editable copy from cleaned article text and normalized topics', () => {
    const result = createInitialXPostCopy({
      ...source,
      title: '原文标题',
      markdown: '---\nprivate: true\n---\n# 文章标题\n\n**关键观点**与[参考链接](https://example.com)。\n\n<p>保留内容 &amp; 细节。</p>\n\n```js\nconsole.log("code");\n```',
      tags: ['#AI#', 'AI', '工作 效率', '更多话题'],
    });
    expect(result).toEqual({
      body: '文章标题\n\n关键观点与参考链接。\n\n保留内容 & 细节。',
      topics: ['AI', '工作效率'],
    });
  });

  test('uses the article title when cleaned body is empty', () => {
    expect(createInitialXPostCopy({
      ...source, title: '  标题里的核心观点  ', markdown: '```js\nconst value = 1;\n```', tags: [],
    })).toEqual({ body: '标题里的核心观点', topics: [] });
  });

  test('preserves complete initial text beyond the X limit for manual editing', () => {
    const body = '长'.repeat(300) + '，保留最后一句完整观点。';
    const result = createInitialXPostCopy({
      ...source, title: '长文章', markdown: `**${body}**`, tags: ['AI'],
    });
    expect(result).toEqual({ body, topics: ['AI'] });
    expect(validateXPostCopy(result)).toContain('280');
  });

  test('uses official weighted length for CJK, emoji families, normalized text and links', () => {
    expect(xPostWeightedLength('中'.repeat(140))).toBe(280);
    expect(validateXPostCopy({ body: '中'.repeat(141), topics: [] })).toContain('280');
    expect(xPostWeightedLength('👨‍👩‍👧‍👦')).toBe(2);
    expect(xPostWeightedLength('e\u0301')).toBe(1);
    expect(xPostWeightedLength('https://example.com/a-long-link?query=very-long')).toBe(23);
  });

  test('counts topics and separating whitespace and never truncates an oversized generated sentence', () => {
    const body = '中'.repeat(138) + '。';
    expect(parseXPostCopyOutput(JSON.stringify({ body, topics: ['效率'] }))).toBeNull();
    expect(body).toHaveLength(139);
    expect(buildXPostText(' 保留完整观点。 ', ['#AI', 'AI', '效率', '第三个话题'])).toBe('保留完整观点。\n\n#AI #效率');
    expect(parseXPostCopyOutput('```json\n{"body":"保留完整观点。","topics":["#AI"]}\n```'))
      .toEqual({ body: '保留完整观点。', topics: ['AI'] });
    expect(parseXPostCopyOutput('{"body":"坏\uffff字符"}')).toBeNull();
    expect(buildXPostCopyPrompt(source, '保留案例')).toContain('280');
  });

  test('regenerates complete short sentences once when the model exceeds the X budget', async () => {
    const service = Object.create(XiaohongshuGenerationService.prototype) as XiaohongshuGenerationService;
    const runText = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ body: '过'.repeat(141), topics: [] }))
      .mockResolvedValueOnce(JSON.stringify({ body: '一次保留上下文，下次就能接着做。', topics: ['AI'] }));
    Object.assign(service, { runText });
    const result = await service.generateXPostCopy(source, '简洁自然', new AbortController().signal);
    expect(result.body).toBe('一次保留上下文，下次就能接着做。');
    expect(runText).toHaveBeenCalledTimes(2);
    expect(runText.mock.calls[1][1]).toContain('重新组织完整短句');
    runText.mockReset().mockResolvedValue(JSON.stringify({ body: '长'.repeat(141) }));
    await expect(service.generateXPostCopy(source, '', new AbortController().signal)).rejects.toThrow('280');
    expect(runText).toHaveBeenCalledTimes(2);
  });
});
