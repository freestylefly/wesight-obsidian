import {
  buildStreamingThemePreviewDocument,
  sanitizeStreamingThemeHtml,
} from '../src/wechat/streamingPreview';

describe('WeChat streaming theme preview', () => {
  test('keeps compatible partial markup while removing active content', () => {
    const sanitized = sanitizeStreamingThemeHtml([
      '<section id="unsafe" style="color:#123">',
      '<p onclick="alert(1)"><span leaf="">安全正文</span></p>',
      '<script>globalThis.compromised = true</script>',
      '<iframe src="https://example.com"></iframe>',
      '<a href="javascript:alert(1)"><span leaf="">链接</span></a>',
      '<img src="https://cdn.example.com/image.png" onerror="alert(1)">',
    ].join(''));

    expect(sanitized).toContain('<section style="color:#123">');
    expect(sanitized).toContain('安全正文');
    expect(sanitized).toContain('https://cdn.example.com/image.png');
    expect(sanitized).not.toMatch(/script|iframe|onclick|onerror|javascript:/i);
  });

  test('removes unsafe CSS from partial HTML', () => {
    const sanitized = sanitizeStreamingThemeHtml([
      '<section style="position:fixed;color:red">危险</section>',
      '<section style="color:#07c160">安全</section>',
    ].join(''));

    expect(sanitized).not.toContain('position:fixed');
    expect(sanitized).toContain('style="color:#07c160"');
  });

  test('wraps streaming HTML in a no-script CSP document', () => {
    const document = buildStreamingThemePreviewDocument('<section><p>正文');

    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain('<section><p>正文');
  });
});
