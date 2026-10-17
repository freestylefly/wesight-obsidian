import { describe, expect, test } from 'vitest';

import {
  buildXhsCopyPrompt,
  buildXhsPageOutlines,
  buildXhsPostText,
  clampXhsCopy,
  clampXhsTitle,
  createDefaultXhsPageContents,
  createInitialXhsCopy,
  normalizeXhsTags,
  parseXhsCopyOutput,
  parseXhsPageContentsOutput,
  parseXhsSinglePageContentOutput,
  reconcileXhsPageContents,
  toXhsPlainText,
  XHS_BODY_LIMIT,
} from '../src/xiaohongshu/copy';
import type { MultiPublishSnapshot } from '../src/multiPublish/types';
import type { XhsPageContent } from '../src/xiaohongshu/types';

function snapshot(overrides: Partial<MultiPublishSnapshot> = {}): MultiPublishSnapshot {
  return {
    sourcePath: '文章.md',
    contentHash: 'abc123',
    title: '我用 Codex 重做了自己的内容工作流',
    digest: '',
    markdown: '# 为什么要重做\n\n- 信息分散\n- 效率很低\n\n# 新工作流\n\n1. 选题\n2. 写作\n3. 配图',
    html: '',
    coverAssetId: null,
    tags: ['AI 工具', '#内容创作'],
    assets: [],
    warnings: [],
    ...overrides,
  };
}

describe('Xiaohongshu copy transformation', () => {
  test('removes embedded HTML before previewing or outlining a note', () => {
    expect(toXhsPlainText('<center><span style="background:#d3f8b6">这是重点</span></center>\n正文')).toBe('这是重点\n正文');
  });

  test('clamps titles by Unicode characters', () => {
    expect(clampXhsTitle('一二三四五六七八九十一二三四五六七八九十甲乙')).toBe('一二三四五六七八九十一二三四五六七八九十');
    expect(clampXhsTitle('AI工作流🚀实战')).toBe('AI工作流🚀实战');
  });

  test('creates an editable initial draft from the article', () => {
    const copy = createInitialXhsCopy(snapshot());

    expect(Array.from(copy.title).length).toBeLessThanOrEqual(20);
    expect(copy.body).toContain('为什么要重做');
    expect(copy.tags).toEqual(['AI工具', '内容创作']);
  });

  test('parses fenced JSON and enforces title and tag limits', () => {
    const output = '```json\n{"title":"这是一个超过二十个字符的小红书标题需要被截断","body":"正文内容","tags":["#AI 工具","AI 工具","效率","创作","教程","复盘","体验","工作流","多余"]}\n```';
    const copy = parseXhsCopyOutput(output);

    expect(copy).not.toBeNull();
    expect(Array.from(copy?.title ?? '').length).toBeLessThanOrEqual(20);
    expect(copy?.tags).toHaveLength(8);
    expect(copy?.tags[0]).toBe('AI工具');
  });

  test('normalizes duplicate tags and removes whitespace', () => {
    expect(normalizeXhsTags(['#AI 工具', 'AI 工具', ' 内容创作 '])).toEqual(['AI工具', '内容创作']);
  });

  test('makes the complete post limit mandatory even for conflicting custom instructions', () => {
    const prompt = buildXhsCopyPrompt(snapshot(), '请写 3000 字的正文');

    expect(prompt).toContain('600 到 900 字');
    expect(prompt).toContain('不超过 1000 个 Unicode 字符');
    expect(prompt).toContain('正文与话题之间的两个换行也计入字数');
    expect(prompt.indexOf('此限制优先于用户自定义要求')).toBeGreaterThan(prompt.indexOf('请写 3000 字的正文'));
  });

  test('limits initial drafts including topics without splitting Unicode characters', () => {
    const copy = createInitialXhsCopy(snapshot({ markdown: '🚀'.repeat(1200) }));
    const text = buildXhsPostText(copy.body, copy.tags);

    expect(Array.from(text)).toHaveLength(XHS_BODY_LIMIT);
    expect(copy.body.endsWith('…')).toBe(true);
    expect(Array.from(copy.body).every(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0xd800 || codePoint > 0xdfff;
    })).toBe(true);
  });

  test('enforces the complete post limit when an AI response ignores the prompt', () => {
    const copy = parseXhsCopyOutput(JSON.stringify({
      title: '效率复盘',
      body: '正文'.repeat(800),
      tags: ['工作流', 'AI工具'],
    }));

    expect(copy?.body).toBeTruthy();
    expect(Array.from(buildXhsPostText(copy?.body ?? '', copy?.tags ?? []))).toHaveLength(XHS_BODY_LIMIT);
  });

  test('keeps an exactly 1000 character body unchanged when there are no topics', () => {
    const body = '字'.repeat(XHS_BODY_LIMIT);
    expect(clampXhsCopy({ title: '标题', body, tags: [] }).body).toBe(body);
  });

  test('budgets topic markers, spaces and the blank line as part of 1000 characters', () => {
    const tags = ['AI', '工作流'];
    const topicLength = Array.from('#AI #工作流').length;
    const bodyBudget = XHS_BODY_LIMIT - topicLength - 2;
    const exactBody = '字'.repeat(bodyBudget);
    const copy = clampXhsCopy({ title: '标题', body: `${exactBody}多`, tags });

    expect(buildXhsPostText(exactBody, tags)).toBe(`${exactBody}\n\n#AI #工作流`);
    expect(clampXhsCopy({ title: '标题', body: exactBody, tags }).body).toBe(exactBody);
    expect(Array.from(buildXhsPostText(copy.body, copy.tags))).toHaveLength(XHS_BODY_LIMIT);
    expect(copy.body.endsWith('…')).toBe(true);
  });

  test('caps oversized generated topics while preserving a nonempty body', () => {
    const copy = parseXhsCopyOutput(JSON.stringify({
      title: '标题',
      body: '正文内容',
      tags: Array.from({ length: 8 }, (_, index) => `${index}${'🚀'.repeat(1500)}`),
    }));

    expect(copy?.body).toBe('正文内容');
    expect(copy?.tags).toHaveLength(8);
    expect(copy?.tags.every(tag => Array.from(tag).length === 20)).toBe(true);
    expect(Array.from(buildXhsPostText(copy?.body ?? '', copy?.tags ?? []))).toHaveLength(181);
  });

  test('retains normal short paragraphs and counts existing manual topics in full', () => {
    const body = '第一段介绍问题。\n\n第二段讲清方法。\n保留这次换行。';
    const copy = parseXhsCopyOutput(JSON.stringify({ title: '标题', body, tags: ['效率'] }));

    expect(copy?.body).toBe(body);
    expect(buildXhsPostText('正文', ['字'.repeat(1200)])).toHaveLength(1205);
  });

  test('matches platform topic formatting without truncating or deduplicating manual topics', () => {
    expect(buildXhsPostText('  正文  ', ['#效率#', ' AI 工具 ', '', '效率']))
      .toBe('正文\n\n#效率 #AI 工具 #效率');
  });

  test('finishes an oversized generated body at a nearby sentence or paragraph boundary', () => {
    const sentence = `${'字'.repeat(900)}。`;
    const paragraph = `${'字'.repeat(900)}\n\n`;

    expect(clampXhsCopy({ title: '标题', body: `${sentence}${'余'.repeat(400)}`, tags: [] }).body).toBe(sentence);
    expect(clampXhsCopy({ title: '标题', body: `${paragraph}${'余'.repeat(400)}`, tags: [] }).body).toBe(paragraph.trimEnd());
  });

  test('rejects empty generated bodies even when topics are present', () => {
    expect(parseXhsCopyOutput(JSON.stringify({ title: '标题', body: ' \n ', tags: ['效率'] }))).toBeNull();
  });

  test('builds the requested number of carousel pages', () => {
    const pages = buildXhsPageOutlines({
      title: '内容工作流升级',
      body: '第一部分介绍问题。\n\n第二部分介绍方法。\n\n第三部分给出结果。\n\n第四部分总结经验。',
      tags: ['效率', 'AI工具'],
    }, 6);

    expect(pages).toHaveLength(6);
    expect(pages[0].label).toBe('封面');
    expect(pages[5].label).toBe('结尾');
    expect(pages[5].content).toContain('#效率');
  });

  test('creates page content defaults for old drafts without saved page content', () => {
    const copy = createInitialXhsCopy(snapshot());
    const pages = reconcileXhsPageContents(copy, 3, undefined);

    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({
      pageNumber: 1,
      text: copy.title,
      textSource: 'article',
    });
  });

  test('preserves independently edited page content when the visual style changes', () => {
    const copy = createInitialXhsCopy(snapshot());
    const saved = createDefaultXhsPageContents(copy, 3);
    saved[1] = {
      ...saved[1],
      text: '我手动调整的第二页\n这段文字需要跨样式保持',
      textSource: 'manual',
    };

    expect(reconcileXhsPageContents(copy, 3, saved)[1]).toMatchObject({
      text: '我手动调整的第二页\n这段文字需要跨样式保持',
      textSource: 'manual',
    });
  });

  test('migrates old main-text and quote fields into one page text without losing edits', () => {
    const copy = createInitialXhsCopy(snapshot());
    const legacyPages = [{
      pageNumber: 1,
      label: '封面',
      mainText: '旧主文字',
      mainTextSource: 'ai',
      quote: '旧补充文字',
      quoteSource: 'manual',
    }] as unknown as XhsPageContent[];

    expect(reconcileXhsPageContents(copy, 1, legacyPages)[0]).toMatchObject({
      text: '旧主文字\n旧补充文字',
      textSource: 'manual',
    });
  });

  test('parses an exact AI page-content set and rejects incomplete results', () => {
    const output = JSON.stringify({
      pages: [
        { pageNumber: 1, label: '封面', text: '先把问题讲清楚。' },
        { pageNumber: 2, label: '方法', text: '再拆解方法，给出具体步骤。' },
        { pageNumber: 3, label: '结尾', text: '最后收束全文。' },
      ],
    });

    const parsed = parseXhsPageContentsOutput(output, 3);
    expect(parsed).toHaveLength(3);
    expect(parsed?.every(page => page.textSource === 'ai')).toBe(true);
    expect(parseXhsPageContentsOutput(output, 4)).toBeNull();
  });

  test('regenerates only the expected page and enforces text limits', () => {
    const generated = parseXhsSinglePageContentOutput(JSON.stringify({
      pageNumber: 2,
      label: '第二页方法拆解',
      text: '图片文字'.repeat(40),
    }), 2);

    expect(generated?.pageNumber).toBe(2);
    expect(Array.from(generated?.text ?? '')).toHaveLength(100);
    expect(parseXhsSinglePageContentOutput('{"pageNumber":1,"label":"错页","text":"a"}', 2)).toBeNull();
  });
});
