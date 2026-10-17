import { markdownToPlatformHtml, stripLeadingPublishDecoration } from '../src/multiPublish/content';

describe('multi-platform content conversion', () => {
  test('preserves common article structures', () => {
    const html = markdownToPlatformHtml([
      '# 标题',
      '',
      '正文含有 **重点** 和 [链接](https://example.com)。',
      '',
      '- 项目一',
      '- 项目二',
      '',
      '> 引用内容',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '![图片](wesight-asset://abc)',
    ].join('\n'));

    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('src="wesight-asset://abc"');
  });

  test('omits the leading publication badge without touching body examples', () => {
    const badge = '<center><span style="background:#d3f8b6">这是苍何的第 609 篇原创！</span></center>';
    expect(stripLeadingPublishDecoration(`${badge}\n\n正文`)).toBe('正文');
    expect(stripLeadingPublishDecoration(`正文\n\n${badge}`)).toContain(badge);
    expect(stripLeadingPublishDecoration(`<center>正文中的标题</center>\n正文`)).toContain('正文中的标题');
  });

  test('escapes raw executable HTML and unsafe links', () => {
    const html = markdownToPlatformHtml('<script>alert(1)</script> [危险](javascript:alert(1))');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
});
