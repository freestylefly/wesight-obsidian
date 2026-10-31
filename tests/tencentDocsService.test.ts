import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
vi.mock('../src/tencentDocs/imageUpload', () => ({ prepareTencentDocsImage: vi.fn(async (body: ArrayBuffer, fileName: string) => ({ body, fileName })) }));

import { prepareTencentDocsImage } from '../src/tencentDocs/imageUpload';

import { requestUrl, type RequestUrlParam } from 'obsidian';
import { TencentDocsService, TENCENT_DOCS_MCP_URL, TENCENT_DOCS_TOKEN_SECRET_ID } from '../src/tencentDocs/service';

interface FixtureOptions {
  legacy?: boolean;
  sse?: boolean;
  imageId?: string;
  uploadStatus?: number;
  omitTools?: string[];
  pages?: Array<{ id: string; type: string; children: string[] }>;
  failInsert?: boolean;
  noopInsert?: boolean;
  failDeleteId?: string;
  browserAuth?: ConstructorParameters<typeof TencentDocsService>[1];
}

function fixture(options: FixtureOptions = {}) {
  const values = new Map<string, string>();
  const secrets = {
    getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => { values.set(id, value); },
  };
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const requests: RequestUrlParam[] = [];
  const service = new TencentDocsService(secrets, options.browserAuth);
  let inserted = false;
  vi.mocked(requestUrl).mockImplementation((async (input: string | RequestUrlParam) => {
    const request = input as RequestUrlParam;
    requests.push(request);
    if (request.url !== TENCENT_DOCS_MCP_URL) return {
      status: 200, headers: { 'content-type': 'image/png' }, arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
    } as never;
    const body = JSON.parse(request.body as string) as { id: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
    if (body.method === 'notifications/initialized') return { status: 202, headers: {}, text: '' } as never;
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tencent-docs', version: '1.0' } };
    else if (body.method === 'tools/list') result = { tools: [
      { name: options.legacy ? 'create_smartcanvas_by_markdown' : 'create_smartcanvas_by_mdx' }, { name: 'upload_image' },
      { name: 'smartcanvas.get_top_level_pages' }, { name: 'smartcanvas.read' }, { name: 'smartcanvas.edit' }, { name: 'manage.rename_file_title' },
    ].filter(tool => !options.omitTools?.includes(tool.name)) };
    else {
      calls.push(body.params);
      if (body.params.name === 'upload_image' && options.uploadStatus) return { status: options.uploadStatus, headers: {}, text: 'private upstream details' } as never;
      let data: Record<string, unknown>;
      if (body.params.name === 'upload_image') data = { image_id: options.imageId ?? 'img_uploaded', error: '' };
      else if (body.params.name === 'smartcanvas.get_top_level_pages') data = {
        top_level_pages: (options.pages ?? [{ id: 'page', type: 'page', children: ['old1', 'old2'] }]).map(page => ({ ...page, children: inserted ? ['newchild', ...page.children] : page.children })), error: '',
      };
      else if (body.params.name === 'smartcanvas.read') data = { content: '<Paragraph id="old1">旧正文</Paragraph>\n<Paragraph id="old2">另一段</Paragraph>', error: '' };
      else if (body.params.name === 'smartcanvas.edit') {
        const inserting = String(body.params.arguments.action).startsWith('INSERT');
        if (inserting && !options.failInsert && !options.noopInsert) inserted = true;
        data = {
          error: options.failInsert && String(body.params.arguments.action).startsWith('INSERT')
            || body.params.arguments.action === 'DELETE' && body.params.arguments.id === options.failDeleteId
            ? 'upstream failed with personal-token' : '',
        };
      }
      else if (body.params.name === 'manage.rename_file_title') data = { file_id: body.params.arguments.file_id, title: body.params.arguments.title, error: '' };
      else data = { file_id: 'file_123', url: 'https://docs.qq.com/aio/test', error: '' };
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    const envelope = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return { status: 200, headers: { 'mcp-session-id': 'session_123' }, text: options.sse ? `event: message\ndata: ${envelope}\n\n` : envelope } as never;
  }) as unknown as typeof requestUrl);
  return { service, secrets, values, calls, requests };
}

beforeEach(() => vi.clearAllMocks());

describe('Tencent Docs connector', () => {
  test('stays local without stored authorization', async () => {
    const { service } = fixture();
    expect(await service.getConnectionState()).toMatchObject({ status: 'needs-auth', connected: false });
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test('validates authorization before storing it and carries MCP session headers', async () => {
    const { service, values, requests } = fixture();
    expect(await service.connect('  personal-token  ')).toMatchObject({ connected: true });
    expect(values.get(TENCENT_DOCS_TOKEN_SECRET_ID)).toBe('personal-token');
    expect(requests[0].headers?.Authorization).toBe('personal-token');
    expect(requests[2].headers).toMatchObject({ 'Mcp-Session-Id': 'session_123', 'MCP-Protocol-Version': '2025-03-26' });
    expect(requests.map(request => (JSON.parse(request.body as string) as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  test('validates and saves credentials received from browser authorization', async () => {
    const info = { verificationUrl: 'https://docs.qq.com/scenario/open-claw.html?authType=1&code=test' };
    const browserAuth = {
      authorize: vi.fn(async (notify: (value: typeof info) => void) => {
        notify(info);
        return 'browser-token';
      }),
      cancel: vi.fn(),
    };
    const { service, values, requests } = fixture({ browserAuth });
    const onVerification = vi.fn();
    expect(await service.login(onVerification)).toMatchObject({ connected: true });
    expect(onVerification).toHaveBeenCalledExactlyOnceWith(info);
    expect(requests[0].headers?.Authorization).toBe('browser-token');
    expect(values.get(TENCENT_DOCS_TOKEN_SECRET_ID)).toBe('browser-token');
  });

  test('does not save browser credentials rejected by the MCP service', async () => {
    const browserAuth = { authorize: vi.fn().mockResolvedValue('rejected-token'), cancel: vi.fn() };
    const { service, values } = fixture({ browserAuth });
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 401, headers: {}, text: '' } as never);
    await expect(service.login(vi.fn())).rejects.toMatchObject({ code: 'auth' });
    expect(values.size).toBe(0);
  });

  test('ignores browser credentials arriving after disconnect', async () => {
    let finish!: (token: string) => void;
    const browserAuth = {
      authorize: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })),
      cancel: vi.fn(),
    };
    const { service, values, requests } = fixture({ browserAuth });
    const login = service.login(vi.fn());
    await service.disconnect();
    finish('late-token');
    await expect(login).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toHaveLength(0);
    expect(values.get(TENCENT_DOCS_TOKEN_SECRET_ID)).toBe('');
  });

  test('creates a smartcanvas from Markdown and uploads local images using image IDs', async () => {
    const { service, secrets, calls } = fixture({ sse: true });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    const result = await service.publish({ title: '笔记', markdown: '# 笔记\n![图](wesight-asset:local)', assets: [{
      token: 'wesight-asset:local', fileName: 'image.png', vaultPath: 'image.png', mimeType: 'image/png', contentHash: 'hash', body: new Uint8Array([1, 2, 3]).buffer,
    }] });
    expect(calls).toEqual([
      { name: 'upload_image', arguments: { image_base64: 'AQID', file_name: 'image.png' } },
      { name: 'create_smartcanvas_by_mdx', arguments: { title: '笔记', mdx: '# 笔记\n![图](img_uploaded)', content_format: 'markdown' } },
    ]);
    expect(result).toEqual({ documentId: 'file_123', url: 'https://docs.qq.com/aio/test' });
  });

  test('does not alter existing content when conversion produces no document body', async () => {
    const { service, secrets, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ title: '空白', markdown: '<!-- comment only -->', documentId: 'existing', url: 'https://docs.qq.com/aio/existing' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls.map(call => call.name)).toEqual(['smartcanvas.get_top_level_pages']);
  });

  test('negotiates the legacy Markdown creation tool', async () => {
    const { service, secrets, calls } = fixture({ legacy: true });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await service.publish({ title: '笔记', markdown: '# 内容' });
    expect(calls[0]).toEqual({ name: 'create_smartcanvas_by_markdown', arguments: { title: '笔记', markdown: '# 内容' } });
  });

  test('selects Markdown parsing for the MDX tool instead of its default MDX format', async () => {
    const { service, secrets, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await service.publish({ title: '笔记', markdown: '# 内容\n\n正文' });
    expect(calls[0]).toEqual({
      name: 'create_smartcanvas_by_mdx',
      arguments: { title: '笔记', mdx: '# 内容\n\n正文', content_format: 'markdown' },
    });
  });

  test('uploads network images without sending credentials to the image host', async () => {
    const { service, secrets, requests, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await service.publish({ title: '笔记', markdown: '![图](https://example.com/image.png)' });
    expect(requests.find(request => request.url === 'https://example.com/image.png')?.headers).toBeUndefined();
    expect(calls[1].arguments.mdx).toBe('![图](img_uploaded)');
  });

  test('prepares large images and sends the resulting bytes and extension', async () => {
    const { service, secrets, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    vi.mocked(prepareTencentDocsImage).mockResolvedValueOnce({ body: new Uint8Array([4, 5]).buffer, fileName: 'image.jpg' });
    const body = new ArrayBuffer(2 * 1024 * 1024);
    await service.publish({ title: '笔记', markdown: '![图](wesight-asset:large)', assets: [{ token: 'wesight-asset:large', body, fileName: 'image.png', vaultPath: 'image.png', mimeType: 'image/png', contentHash: 'large' }] });
    expect(prepareTencentDocsImage).toHaveBeenCalledWith(body, 'image.png');
    expect(calls[0]).toEqual({ name: 'upload_image', arguments: { image_base64: 'BAU=', file_name: 'image.jpg' } });
  });

  test('does not download uploaded URL IDs again and accepts bracketed network URLs', async () => {
    const { service, secrets, requests, calls } = fixture({ imageId: 'https://docs.qq.com/image/uploaded' });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await service.publish({ title: '笔记', markdown: '![图](<https://example.com/image(1).png>)\n![重复](https://example.com/image(1).png)\n![本地](wesight-asset:local)', assets: [{ token: 'wesight-asset:local', body: new Uint8Array([1]).buffer, fileName: 'image.png', vaultPath: 'image.png', mimeType: 'image/png', contentHash: 'local' }] });
    expect(requests.filter(request => request.method === 'GET').map(request => request.url)).toEqual(['https://example.com/image(1).png']);
    expect(calls.at(-1)?.arguments.mdx).toBe('![图](https://docs.qq.com/image/uploaded)\n![重复](https://docs.qq.com/image/uploaded)\n![本地](https://docs.qq.com/image/uploaded)');
  });

  test('identifies image transport failures without exposing server details or creating a document', async () => {
    const { service, secrets, calls } = fixture({ uploadStatus: 413 });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ title: '笔记', markdown: '![图](https://example.com/image.png)' })).rejects.toThrow('图片“image.png”上传失败：图片超出腾讯文档单次传输限制');
    expect(calls.map(call => call.name)).toEqual(['upload_image']);
  });

  test('updates the same document, replaces original blocks after inserting images, and renames it', async () => {
    const { service, secrets, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    const existing = { documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing' };
    const result = await service.publish({
      ...existing, title: '更新标题', markdown: '新增正文\n\n![新图片](wesight-asset:local)',
      assets: [{ token: 'wesight-asset:local', fileName: 'new.png', vaultPath: 'new.png', mimeType: 'image/png', contentHash: 'new', body: new Uint8Array([1, 2, 3]).buffer }],
    });
    const writes = calls.filter(call => ['smartcanvas.edit', 'manage.rename_file_title'].includes(call.name));
    expect(writes).toHaveLength(4);
    expect(writes[0]).toMatchObject({ name: 'smartcanvas.edit', arguments: { file_id: 'existing_123', action: 'INSERT_BEFORE', id: 'old1' } });
    expect(writes[0].arguments.content).toEqual(expect.stringContaining('新增正文'));
    expect(writes[0].arguments.content).toMatch(/<Image[^>]*src="img_uploaded"/);
    expect(writes[0].arguments.content).not.toContain('wesight-asset:');
    expect(writes.slice(1)).toEqual([
      { name: 'smartcanvas.edit', arguments: { file_id: 'existing_123', action: 'DELETE', id: 'old1' } },
      { name: 'smartcanvas.edit', arguments: { file_id: 'existing_123', action: 'DELETE', id: 'old2' } },
      { name: 'manage.rename_file_title', arguments: { file_id: 'existing_123', title: '更新标题' } },
    ]);
    expect(calls.findIndex(call => call.name === 'upload_image')).toBeLessThan(calls.findIndex(call => call.name === 'smartcanvas.edit'));
    expect(calls.some(call => call.name.startsWith('create_'))).toBe(false);
    expect(result).toEqual(existing);
  });

  test('updates an empty page without inventing a block anchor', async () => {
    const { service, secrets, calls } = fixture({ pages: [{ id: 'page', type: 'page', children: [] }] });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '新正文', markdown: '新正文' });
    const edits = calls.filter(call => call.name === 'smartcanvas.edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].arguments).toMatchObject({ file_id: 'existing_123', action: 'INSERT_AFTER' });
    expect(edits[0].arguments.id).toBeUndefined();
  });

  test('does not edit existing content when an image upload fails', async () => {
    const { service, secrets, calls } = fixture({ uploadStatus: 413 });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '![图](https://example.com/image.png)' })).rejects.toThrow();
    expect(calls.filter(call => ['smartcanvas.edit', 'manage.rename_file_title'].includes(call.name))).toEqual([]);
  });

  test('preserves old blocks and title when inserting new content fails', async () => {
    const { service, secrets, calls } = fixture({ failInsert: true });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '新正文' })).rejects.toThrow();
    expect(calls.filter(call => call.arguments.action === 'DELETE' || call.name === 'manage.rename_file_title')).toEqual([]);
  });

  test('preserves original content when the server acknowledges an insertion without adding a block', async () => {
    const { service, secrets, calls } = fixture({ noopInsert: true });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '新正文' })).rejects.toThrow(/部分.*更新|更新.*部分/);
    expect(calls.filter(call => call.name === 'smartcanvas.get_top_level_pages')).toHaveLength(2);
    expect(calls.filter(call => call.arguments.action === 'DELETE' || call.name === 'manage.rename_file_title')).toEqual([]);
  });

  test('reports partial updates without exposing upstream secrets when deleting old content fails', async () => {
    const { service, secrets, calls } = fixture({ failDeleteId: 'old2' });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    const publishing = service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '新正文' });
    await expect(publishing).rejects.toThrow(/部分.*更新|更新.*部分/);
    await expect(publishing).rejects.not.toThrow('personal-token');
    expect(calls.some(call => call.name === 'manage.rename_file_title')).toBe(false);
    expect(calls.filter(call => call.arguments.action === 'DELETE').map(call => call.arguments.id)).toEqual(['old1', 'old2']);
  });

  test.each(['smartcanvas.get_top_level_pages', 'smartcanvas.edit', 'manage.rename_file_title'])('rejects updating when %s is unavailable before uploading or writing', async missingTool => {
    const { service, secrets, calls } = fixture({ omitTools: [missingTool] });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '![图](https://example.com/image.png)' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls.filter(call => call.name === 'upload_image' || call.name === 'smartcanvas.edit' || call.name === 'manage.rename_file_title')).toEqual([]);
  });

  test('refuses to replace a multi-page document before uploading or writing', async () => {
    const { service, secrets, calls } = fixture({ pages: [
      { id: 'page1', type: 'page', children: ['old1'] }, { id: 'page2', type: 'page', children: ['other-page-content'] },
    ] });
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url: 'https://docs.qq.com/aio/existing', title: '笔记', markdown: '![图](https://example.com/image.png)' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls.filter(call => call.name === 'upload_image' || call.name === 'smartcanvas.edit' || call.name === 'manage.rename_file_title')).toEqual([]);
  });

  test('rejects titles exceeding the 36-character provider limit before any request', async () => {
    const { service, secrets } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ title: '图'.repeat(37), markdown: '正文' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test.each(['http://docs.qq.com/aio/existing', 'https://evil.example/aio/existing', 'https://user:password@docs.qq.com/aio/existing'])('rejects unsafe existing document URL %s before any request', async url => {
    const { service, secrets } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ documentId: 'existing_123', url, title: '笔记', markdown: '正文' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test('does not store rejected tokens or expose upstream secrets', async () => {
    const { service, values } = fixture();
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 401, headers: {}, text: 'echo personal-token' } as never);
    await expect(service.connect('personal-token')).rejects.toMatchObject({ code: 'auth' });
    expect(values.size).toBe(0);
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('failed with Authorization: personal-token'));
    await expect(service.connect('personal-token')).rejects.toThrow('无法连接腾讯文档，请检查网络后重试。');
  });

  test('does not restore a token after disconnect during connection', async () => {
    const { service, values } = fixture();
    let complete: (value: never) => void = () => {};
    const delayed = new Promise<never>(resolve => { complete = resolve; });
    vi.mocked(requestUrl).mockReturnValueOnce(delayed as never);
    const connecting = service.connect('personal-token');
    await service.disconnect();
    complete({ status: 200, headers: {}, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }) } as never);
    await expect(connecting).rejects.toMatchObject({ code: 'cancelled' });
    expect(values.get(TENCENT_DOCS_TOKEN_SECRET_ID)).toBe('');
  });

  test('rejects unavailable create tools and incomplete image input before creating a document', async () => {
    const { service, secrets, calls } = fixture();
    secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, 'personal-token');
    await expect(service.publish({ title: '笔记', markdown: '![图](wesight-asset:missing)' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toEqual([]);
  });
});
