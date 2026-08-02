const STREAMING_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src https: http: data: blob: app:",
  "style-src 'unsafe-inline'",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const UNSAFE_STREAMING_STYLE = /(?:position\s*:\s*(?:fixed|absolute|sticky)|float\s*:|display\s*:\s*grid|var\s*\(\s*--|@media|@keyframes|@import|url\s*\()/i;

export function sanitizeStreamingThemeHtml(html: string): string {
  return html
    .replace(/<(?:script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?(?:<\/(?:script|style|iframe|object|embed|svg)\s*>|$)/gi, '')
    .replace(/<\/?(?:script|style|link|meta|base|iframe|object|embed|form|button|input|textarea|select|video|audio|canvas|svg)\b[^>]*>/gi, '')
    .replace(/\s(?:class|id|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(["'])\s*(?:javascript|data:text\/html):[\s\S]*?\1/gi, '')
    .replace(/\sstyle\s*=\s*"([^"]*)"/gi, (attribute, value: string) => (
      UNSAFE_STREAMING_STYLE.test(value) ? '' : attribute
    ))
    .replace(/\sstyle\s*=\s*'([^']*)'/gi, (attribute, value: string) => (
      UNSAFE_STREAMING_STYLE.test(value) ? '' : attribute
    ));
}

export function buildStreamingThemePreviewDocument(html: string): string {
  const body = sanitizeStreamingThemeHtml(html);
  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${STREAMING_PREVIEW_CSP}">`,
    '<style>html,body{margin:0;padding:0;background:transparent;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}body{overflow:hidden;}img{max-width:100%;height:auto;}</style>',
    '</head><body>',
    body || '<p style="margin:24px 0;text-align:center;color:#8b949e;font-size:13px;">正在读取主题并生成排版…</p>',
    '</body></html>',
  ].join('');
}
