import { describe, expect, test, vi } from 'vitest';

import { buildXPostCopyPrompt, buildXPostText, parseXPostCopyOutput, validateXPostCopy, xPostWeightedLength } from '../src/xPost/copy';
import { XiaohongshuGenerationService } from '../src/xiaohongshu/generationService';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';

const source = { markdown: '原文核心观点：为长期合作保留上下文。' } as MultiPublishSnapshot;

describe('X short-form copy', () => {
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
