import { describe, expect, test } from 'vitest';

import { markdownToTencentMdx } from '../src/tencentDocs/markdownToMdx';

describe('Tencent Docs editable MDX conversion', () => {
  test('preserves headings and text while expressing nested inline styles as flat Mark components', () => {
    const mdx = markdownToTencentMdx('# 标题\n\n正文 **粗体 *斜体*** 和 ~~删除~~。');
    expect(mdx).toBe('# 标题\n\n正文 <Mark bold>粗体 </Mark><Mark bold italic>斜体</Mark> 和 <Mark strike>删除</Mark>。');
    expect(mdx).not.toContain('**');
  });

  test('converts uploaded image IDs to Image components rather than Markdown image links', () => {
    const mdx = markdownToTencentMdx('图片之前 ![说明 "内容"](uploaded+image/id) 图片之后');
    expect(mdx).toContain('<Image src="uploaded+image/id" alt="说明 &quot;内容&quot;" />');
    expect(mdx).not.toContain('![');
    expect(mdx).toContain('图片之前');
    expect(mdx).toContain('图片之后');
  });

  test('preserves image IDs and URL punctuation inside quoted attributes', () => {
    const mdx = markdownToTencentMdx('![图片](img_uploaded_123+abc/id) [链接](https://example.com/a_b?template={value}&page=1)');
    expect(mdx).toContain('<Image src="img_uploaded_123+abc/id" alt="图片" />');
    expect(mdx).toContain('<Link href="https://example.com/a_b?template={value}&amp;page=1">链接</Link>');
    expect(mdx.match(/<Image[^>]+>/)?.[0]).not.toContain('&#95;');
  });

  test('preserves a visible link destination when the service drops rich link attributes', () => {
    expect(markdownToTencentMdx('[文档](https://docs.qq.com/path)')).toBe('<Link href="https://docs.qq.com/path">文档</Link> (https://docs.qq.com/path)');
    expect(markdownToTencentMdx('<https://docs.qq.com/path>')).toBe('<Link href="https://docs.qq.com/path">https://docs.qq.com/path</Link>');
  });

  test('converts nested ordered, unordered and task list items with their text first', () => {
    const mdx = markdownToTencentMdx('1. 第一项\n   - 子项\n2. 第二项\n\n- [x] 已完成\n- [ ] 待处理');
    expect(mdx).toContain('<NumberedList>\n    第一项\n\n    <BulletedList>\n        子项\n    </BulletedList>\n</NumberedList>');
    expect(mdx).toContain('<Todo checked>\n    已完成\n</Todo>');
    expect(mdx).toContain('<Todo>\n    待处理\n</Todo>');
    expect(mdx).not.toContain('checked="true"');
  });

  test('uses Tencent table containers and converts styled text inside cells', () => {
    const mdx = markdownToTencentMdx('| 名称 | 状态 |\n| --- | --- |\n| **图片** | 完成 |');
    expect(mdx).toContain('<Table>\n    <TableRow>\n        <TableCell>\n            名称\n        </TableCell>');
    expect(mdx).toContain('<Mark bold>图片</Mark>');
    expect(mdx.match(/<TableRow>/g)).toHaveLength(2);
    expect(mdx.match(/<TableCell>/g)).toHaveLength(4);
  });

  test('preserves code fences and inline code without interpreting expressions or nested fences', () => {
    const mdx = markdownToTencentMdx('`const x = { a: 1 }`\n\n````ts\nconst x = { a: 1 };\n```\n````');
    expect(mdx).toContain('` const x = { a: 1 } `');
    expect(mdx).toContain('````ts\nconst x = { a: 1 };\n```\n````');
  });

  test('escapes expressions and user components while preserving styled HTML text as plain text', () => {
    const mdx = markdownToTencentMdx('<center><span style="background:red">正文 {unsafe()}</span></center>\n\n普通 <Unknown onclick="run()">文字</Unknown>\n\nexport const value = 1');
    expect(mdx).toContain('正文 &#123;unsafe()&#125;');
    expect(mdx).toContain('普通 文字');
    expect(mdx).toContain('&#101;xport const value = 1');
    expect(mdx).not.toMatch(/<(?:center|span|Unknown)/);
    expect(mdx).not.toContain('onclick');
  });

  test('converts links and quote blocks and drops executable link destinations', () => {
    const mdx = markdownToTencentMdx('> 引用 **强调**\n\n[正常](https://example.com?a=1&b=2) [危险](javascript:alert%281%29)');
    expect(mdx).toContain('<BlockQuote>\n    引用 <Mark bold>强调</Mark>\n</BlockQuote>');
    expect(mdx).toContain('<Link href="https://example.com?a=1&amp;b=2">正常</Link>');
    expect(mdx).toContain('危险');
    expect(mdx).not.toContain('javascript:');
  });
});
