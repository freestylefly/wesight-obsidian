import { requestUrl, type SecretStorage } from 'obsidian';

import { recordFromUnknown } from '../utils/records';
import { TencentDocsBrowserAuth } from './browserAuth';
import { prepareTencentDocsImage } from './imageUpload';
import { markdownToTencentMdx } from './markdownToMdx';
import type { TencentDocsConnectionState, TencentDocsDocumentResult, TencentDocsPublishInput } from './types';

export type { TencentDocsConnectionState, TencentDocsDocumentResult, TencentDocsPublishInput } from './types';

export const TENCENT_DOCS_AUTH_URL = 'https://docs.qq.com/scenario/open-claw.html?nlc=1';
export const TENCENT_DOCS_MCP_URL = 'https://docs.qq.com/openapi/mcp';
export const TENCENT_DOCS_TOKEN_SECRET_ID = 'wesight-tencent-docs-token';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface Session {
  token: string;
  sessionId?: string;
  protocolVersion: string;
  createTool: 'create_smartcanvas_by_mdx' | 'create_smartcanvas_by_markdown';
  tools: Set<string>;
}

export class TencentDocsError extends Error {
  constructor(message: string, readonly code: 'auth' | 'permission' | 'network' | 'protocol' | 'cancelled' | 'unsupported') {
    super(message);
    this.name = 'TencentDocsError';
  }
}

function failure(value: unknown): TencentDocsError {
  // Never display upstream messages: responses may echo the authorization header.
  const serialized = JSON.stringify(value) ?? '';
  if (/payload.{0,30}(?:large|limit)|request.{0,30}too.large|entity.too.large|content.{0,30}too.large|413/i.test(serialized)) {
    return new TencentDocsError('图片超出腾讯文档单次传输限制，请缩小图片后重试。', 'unsupported');
  }
  if (/400006|invalid_token|expired.token|unauthorized/i.test(serialized)) {
    return new TencentDocsError('腾讯文档授权已失效，请在连接器中重新登录授权。', 'auth');
  }
  if (/400007|vip|permission|forbidden/i.test(serialized)) {
    return new TencentDocsError('腾讯文档账号权限不足，请在腾讯文档中检查会员权益和文档权限。', 'permission');
  }
  return new TencentDocsError('腾讯文档服务未能完成请求，请重新检测连接后重试。', 'protocol');
}

function parseResponse(text: string, expectedId: number): Record<string, unknown> | null {
  const parse = (source: string): Record<string, unknown> | null => {
    try { return recordFromUnknown(JSON.parse(source)); } catch { return null; }
  };
  const direct = parse(text);
  if (direct) return direct;
  // Streamable HTTP may return one or more SSE events instead of JSON.
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    const parsed = parse(data);
    if (parsed?.id === expectedId) return parsed;
  }
  return null;
}

function toolData(result: Record<string, unknown>): Record<string, unknown> {
  if (result.isError) throw failure(result);
  const structured = recordFromUnknown(result.structuredContent);
  let data = structured;
  if (!data && Array.isArray(result.content)) {
    for (const content of result.content) {
      const block = recordFromUnknown(content);
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try { data = recordFromUnknown(JSON.parse(block.text)); } catch { /* Other text blocks are not tool data. */ }
      if (data) break;
    }
  }
  if (!data) throw failure(result);
  if (data.error || typeof data.code === 'number' && data.code !== 0 || typeof data.ret === 'number' && data.ret !== 0) throw failure(data);
  return recordFromUnknown(data.data) ?? data;
}

function disconnected(): TencentDocsConnectionState {
  return { status: 'needs-auth', connected: false, accountName: null, message: null };
}

/**
 * Official protocol reference: https://developer.cloud.tencent.com.cn/mcp/server/11803
 * Current tool contracts: https://cdn.addon.tencentsuite.com/static/tencent-docs.zip
 * (smartcanvas/entry.md and references/workflows.md). Tokens stay in SecretStorage.
 */
export class TencentDocsService {
  private sequence = 0;
  private revision = 0;

  constructor(
    private readonly secrets: Pick<SecretStorage, 'getSecret' | 'setSecret'>,
    private readonly browserAuth: Pick<TencentDocsBrowserAuth, 'authorize' | 'cancel'> = new TencentDocsBrowserAuth(),
  ) {}

  cancelActiveOperation(): void {
    this.revision += 1;
    this.browserAuth.cancel();
  }

  async login(
    onVerification: (info: { verificationUrl: string; userCode?: string }) => void,
  ): Promise<TencentDocsConnectionState> {
    this.cancelActiveOperation();
    const revision = this.revision;
    const token = await this.browserAuth.authorize(onVerification);
    this.assertActive(revision);
    await this.openSession(token);
    this.assertActive(revision);
    this.secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, token);
    return { status: 'connected', connected: true, accountName: null, message: null };
  }

  async connect(token: string): Promise<TencentDocsConnectionState> {
    const value = token.trim();
    if (!value || /[\r\n]/.test(value)) throw new TencentDocsError('请填写有效的腾讯文档授权 Token。', 'auth');
    this.cancelActiveOperation();
    const revision = this.revision;
    await this.openSession(value);
    this.assertActive(revision);
    this.secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, value);
    return { status: 'connected', connected: true, accountName: null, message: null };
  }

  async disconnect(): Promise<void> {
    this.cancelActiveOperation();
    this.secrets.setSecret(TENCENT_DOCS_TOKEN_SECRET_ID, '');
  }

  async getConnectionState(): Promise<TencentDocsConnectionState> {
    const token = this.secrets.getSecret(TENCENT_DOCS_TOKEN_SECRET_ID)?.trim();
    if (!token) return disconnected();
    const revision = this.revision;
    try {
      await this.openSession(token);
      if (revision !== this.revision) return disconnected();
      return { status: 'connected', connected: true, accountName: null, message: null };
    } catch (error) {
      if (revision !== this.revision) return disconnected();
      return { status: 'error', connected: false, accountName: null, message: error instanceof TencentDocsError ? error.message : '检测腾讯文档连接失败，请检查网络后重试。' };
    }
  }

  async publish(input: TencentDocsPublishInput): Promise<TencentDocsDocumentResult> {
    const title = input.title.trim();
    if (!title) throw new TencentDocsError('请填写腾讯文档标题。', 'unsupported');
    if (Array.from(title).length > 36) throw new TencentDocsError('腾讯文档标题最多支持 36 个字符，请缩短标题后重试。', 'unsupported');
    const targetId = input.documentId?.trim();
    if (input.documentId !== undefined && !targetId) throw new TencentDocsError('已有腾讯文档 ID 无效，请创建新的文档。', 'unsupported');
    if (input.url && !targetId) throw new TencentDocsError('未找到已有腾讯文档 ID，请创建新的文档。', 'unsupported');
    const targetUrl = targetId ? this.documentUrl(input.url ?? `https://docs.qq.com/aio/D${Buffer.from(targetId).toString('base64').replace(/=+$/, '')}`) : null;
    const token = this.secrets.getSecret(TENCENT_DOCS_TOKEN_SECRET_ID)?.trim();
    if (!token) throw new TencentDocsError('请先在设置中连接腾讯文档。', 'auth');
    const revision = this.revision;
    const session = await this.openSession(token);
    this.assertActive(revision);
    const targetPage = targetId ? await this.getUpdatePage(session, targetId) : null;
    this.assertActive(revision);
    let markdown = input.markdown;
    // Process source URLs before inserting uploaded IDs, which can themselves be URLs.
    const imagePattern = /!\[([^\]]*)\]\(\s*(?:<(https?:\/\/[^<>]+)>|(https?:\/\/(?:\\.|[^\\()\s]|\((?:\\.|[^\\()\s])*\))+))(?:\s+["'][^"']*["'])?\s*\)/g;
    const externalImages = new Map<string, string>();
    for (const match of markdown.matchAll(imagePattern)) {
      const url = (match[2] ?? match[3]).replace(/\\([\\()])/g, '$1');
      if (externalImages.has(url)) continue;
      this.assertActive(revision);
      let response: Awaited<ReturnType<typeof requestUrl>>;
      try { response = await requestUrl({ url, method: 'GET', throw: false }); } catch {
        throw new TencentDocsError('无法读取笔记中的网络图片，请检查图片链接后重试。', 'network');
      }
      if (response.status < 200 || response.status >= 300) throw new TencentDocsError('无法读取笔记中的网络图片，请检查图片链接后重试。', 'network');
      const mediaType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.split(';')[0].trim().toLowerCase();
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' } as Record<string, string>)[mediaType ?? ''];
      if (!extension) throw new TencentDocsError('网络图片格式不受腾讯文档支持，请使用 PNG、JPG、GIF、WEBP、BMP 或 SVG 图片。', 'unsupported');
      this.assertActive(revision);
      externalImages.set(url, await this.uploadImage(session, response.arrayBuffer, `image.${extension}`));
    }
    markdown = markdown.replace(imagePattern, (_match, alt: string, bracketUrl: string | undefined, plainUrl: string | undefined) => `![${alt}](${externalImages.get((bracketUrl ?? plainUrl ?? '').replace(/\\([\\()])/g, '$1'))})`);
    for (const asset of input.assets ?? []) {
      this.assertActive(revision);
      const imageId = await this.uploadImage(session, asset.body, asset.fileName);
      markdown = markdown.split(asset.token).join(imageId);
    }
    if (/!\[[^\]]*\]\((?:wesight-asset:|data:)/i.test(markdown)) {
      throw new TencentDocsError('笔记中的图片未能完整读取，请检查图片后重试。', 'unsupported');
    }
    this.assertActive(revision);
    if (targetId && targetUrl && targetPage) {
      await this.replaceDocument(session, targetId, targetPage, title, markdownToTencentMdx(markdown), revision);
      return { documentId: targetId, url: targetUrl };
    }
    const result = toolData(await this.rpc(session, 'tools/call', {
      name: session.createTool,
      // Select Markdown explicitly so ![alt](image_id) is parsed as an image.
      arguments: session.createTool === 'create_smartcanvas_by_mdx' ? { title, mdx: markdown, content_format: 'markdown' } : { title, markdown },
    }));
    const documentId = result.file_id;
    const url = result.url;
    if (typeof documentId !== 'string' || !documentId || typeof url !== 'string') throw failure(result);
    // Return completed writes even if the panel closed in flight, preserving the result URL.
    return { documentId, url: this.documentUrl(url) };
  }

  private documentUrl(url: string): string {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new TencentDocsError('腾讯文档链接无效，请检查笔记中的文档链接。', 'unsupported'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.qq.com' || parsed.username || parsed.password || parsed.port || !parsed.pathname.startsWith('/aio/')) {
      throw new TencentDocsError('腾讯文档链接无效，请检查笔记中的文档链接。', 'unsupported');
    }
    return parsed.href;
  }

  private async getUpdatePage(session: Session, documentId: string): Promise<{ children: string[] }> {
    const required = ['smartcanvas.get_top_level_pages', 'smartcanvas.edit', 'manage.rename_file_title'];
    if (required.some(tool => !session.tools.has(tool))) {
      throw new TencentDocsError('当前腾讯文档服务未提供完整的更新能力，请重新检测连接或创建新的文档。', 'unsupported');
    }
    const result = toolData(await this.rpc(session, 'tools/call', { name: 'smartcanvas.get_top_level_pages', arguments: { file_id: documentId } }));
    const pages = result.top_level_pages;
    if (!Array.isArray(pages) || pages.length !== 1) {
      throw new TencentDocsError('当前仅支持更新单页腾讯文档，请为此笔记创建新的文档。', 'unsupported');
    }
    const page = recordFromUnknown(pages[0]);
    if (page?.type !== 'page' || typeof page.id !== 'string' || !page.id.trim()) throw failure(result);
    if (!Array.isArray(page.children) || page.children.some(id => typeof id !== 'string' || !id.trim())) throw failure(result);
    return { children: Array.from(new Set(page.children as string[])) };
  }

  private async replaceDocument(session: Session, documentId: string, page: { children: string[] }, title: string, mdx: string, revision: number): Promise<void> {
    this.assertActive(revision);
    if (!mdx.trim()) throw new TencentDocsError('当前笔记没有可更新的正文，请添加内容后重试。', 'unsupported');
    try {
      // Insert first: a failed upload or conversion must leave the existing body intact.
      toolData(await this.rpc(session, 'tools/call', {
        name: 'smartcanvas.edit', arguments: {
          file_id: documentId,
          action: page.children.length ? 'INSERT_BEFORE' : 'INSERT_AFTER',
          ...(page.children.length ? { id: page.children[0] } : {}),
          content: mdx,
        },
      }));
      this.assertActive(revision);
      const inserted = await this.getUpdatePage(session, documentId);
      if (!inserted.children.some(id => !page.children.includes(id))) throw failure({ error: 'empty_insert_result' });
      for (const id of page.children) {
        this.assertActive(revision);
        toolData(await this.rpc(session, 'tools/call', { name: 'smartcanvas.edit', arguments: { file_id: documentId, action: 'DELETE', id } }));
      }
      this.assertActive(revision);
      toolData(await this.rpc(session, 'tools/call', { name: 'manage.rename_file_title', arguments: { file_id: documentId, title } }));
    } catch (error) {
      const code = error instanceof TencentDocsError ? error.code : 'protocol';
      throw new TencentDocsError('腾讯文档更新未完成，远端可能已部分更新。原链接已保留，请检查文档后重新更新。', code);
    }
  }

  private assertActive(revision: number): void {
    if (revision !== this.revision) throw new TencentDocsError('腾讯文档操作已取消。', 'cancelled');
  }

  private async uploadImage(session: Session, body: ArrayBuffer, fileName: string): Promise<string> {
    if (!session.tools.has('upload_image')) throw new TencentDocsError('当前腾讯文档服务未提供图片上传能力，请重新检测连接后重试。', 'unsupported');
    if (!body.byteLength || body.byteLength > MAX_IMAGE_BYTES) throw new TencentDocsError('腾讯文档图片大小须在 10 MB 以内，请压缩图片后重试。', 'unsupported');
    try {
      const prepared = await prepareTencentDocsImage(body, fileName);
      const result = toolData(await this.rpc(session, 'tools/call', { name: 'upload_image', arguments: { image_base64: Buffer.from(prepared.body).toString('base64'), file_name: prepared.fileName } }));
      if (typeof result.image_id !== 'string' || !result.image_id) throw failure(result);
      return result.image_id;
    } catch (error) {
      if (error instanceof TencentDocsError) {
        throw new TencentDocsError(`图片“${fileName}”上传失败：${error.message}`, error.code);
      }
      throw new TencentDocsError(`图片“${fileName}”处理失败，请将图片另存为 PNG 或 JPG 后重试。`, 'unsupported');
    }
  }

  private async openSession(token: string): Promise<Session> {
    const session: Session = { token, protocolVersion: PROTOCOL_VERSION, createTool: 'create_smartcanvas_by_mdx', tools: new Set() };
    const initialized = await this.rpc(session, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'wesight-obsidian', version: '1.0.0' } });
    if (typeof initialized.protocolVersion !== 'string') throw failure(initialized);
    session.protocolVersion = initialized.protocolVersion;
    await this.rpc(session, 'notifications/initialized');
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.rpc(session, 'tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw failure(result);
      for (const tool of result.tools) {
        const name = recordFromUnknown(tool)?.name;
        if (typeof name === 'string') session.tools.add(name);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    if (session.tools.has('create_smartcanvas_by_mdx')) return session;
    if (session.tools.has('create_smartcanvas_by_markdown')) { session.createTool = 'create_smartcanvas_by_markdown'; return session; }
    throw new TencentDocsError('腾讯文档服务未提供文档创建能力，请检查账号权限后重试。', 'unsupported');
  }

  private async rpc(session: Session, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const notification = method.startsWith('notifications/');
    const id = ++this.sequence;
    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await requestUrl({
        url: TENCENT_DOCS_MCP_URL, method: 'POST', throw: false,
        headers: {
          Authorization: session.token,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(method !== 'initialize' ? { 'MCP-Protocol-Version': session.protocolVersion } : {}),
          ...(session.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, ...(params ? { params } : {}) }),
      });
    } catch { throw new TencentDocsError('无法连接腾讯文档，请检查网络后重试。', 'network'); }
    if (response.status === 413) throw new TencentDocsError('图片超出腾讯文档单次传输限制，请缩小图片后重试。', 'unsupported');
    if (response.status === 401) throw failure({ error: 'invalid_token' });
    if (response.status === 403) throw failure({ error: 'forbidden' });
    if (response.status < 200 || response.status >= 300) throw new TencentDocsError('腾讯文档服务暂时不可用，请稍后重试。', 'network');
    const sessionId = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'mcp-session-id')?.[1];
    if (sessionId) session.sessionId = sessionId;
    if (notification) return {};
    const envelope = parseResponse(response.text, id);
    if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error) throw failure(envelope);
    const result = recordFromUnknown(envelope.result);
    if (!result) throw failure(envelope);
    return result;
  }
}
