import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({ App: class {}, TFile: class {}, Notice: vi.fn(), setIcon: vi.fn() }));
vi.mock('../src/tencentDocs/service', () => ({ TENCENT_DOCS_AUTH_URL: 'https://docs.qq.com/scenario/open-claw.html?nlc=1' }));
vi.mock('../src/share/snapshot', () => ({ buildShareSnapshot: vi.fn() }));
vi.mock('../src/ui/shareConfirm', () => ({ confirmShareAction: vi.fn() }));

import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import { buildShareSnapshot } from '../src/share/snapshot';
import type { ShareSnapshot } from '../src/share/types';
import type { TencentDocsService } from '../src/tencentDocs/service';
import { TencentDocsConnectorSettings } from '../src/ui/tencentDocsConnectorSettings';
import { TencentDocsSharePanel } from '../src/ui/tencentDocsSharePanel';
import { confirmShareAction } from '../src/ui/shareConfirm';

type ElementOptions = { text?: string; cls?: string; attr?: Record<string, string> };

class Element {
  children: Element[] = [];
  text = '';
  tag = '';
  attrs: Record<string, string> = {};
  disabled = false;
  value = '';
  id = '';
  htmlFor = '';
  open = false;
  checked = false;
  onchange: (() => void) | null = null;
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  focus = vi.fn();
  scrollIntoView = vi.fn();
  createEl(tag: string, options: ElementOptions = {}): Element {
    return this.append(tag, options);
  }
  private append(tag: string, options: ElementOptions): Element {
    const child = new Element();
    child.tag = tag;
    child.text = options.text ?? '';
    child.attrs = { ...options.attr, ...(options.cls ? { class: options.cls } : {}) };
    child.value = child.attrs.value ?? '';
    child.id = child.attrs.id ?? '';
    this.children.push(child);
    return child;
  }
  createDiv(options: ElementOptions = {}): Element { return this.append('div', options); }
  createSpan(options: ElementOptions = {}): Element { return this.append('span', options); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  addClass(cls: string): void { this.attrs.class = `${this.attrs.class ?? ''} ${cls}`; }
  prepend(child: Element): void {
    this.children = [child, ...this.children.filter(item => item !== child)];
  }
  empty(): void { this.children = []; }
  setText(text: string): void { this.text = text; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  get textContent(): string { return this.all().map(node => node.text).join(' '); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function button(parent: Element, label: string): Element {
  const match = parent.all().find(node => node.tag === 'button' && node.text === label);
  expect(match, `Missing button ${label}`).toBeDefined();
  return match!;
}

function input(parent: Element, type: string): Element {
  const match = parent.all().find(node => node.tag === 'input' && node.attrs.type === type);
  expect(match, `Missing input ${type}`).toBeDefined();
  return match!;
}

const connected = { status: 'connected' as const, connected: true, accountName: '测试用户', message: null };
const disconnected = { status: 'needs-auth' as const, connected: false, accountName: null, message: null };
const published = { documentId: 'document-id', url: 'https://docs.qq.com/doc/test' };
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

function snapshot(overrides: Partial<ShareSnapshot> = {}): ShareSnapshot {
  return { title: '笔记标题', markdown: '# 正文', contentHash: 'hash', assets: [], warnings: [], ...overrides };
}

function serviceMock() {
  return {
    getConnectionState: vi.fn().mockResolvedValue(connected),
    connect: vi.fn().mockResolvedValue(connected),
    login: vi.fn().mockResolvedValue(connected),
    cancelActiveOperation: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(published),
  };
}

function shareFixture(initial: Record<string, unknown> = {}) {
  const parent = new Element();
  const service = serviceMock();
  const frontmatter: Record<string, unknown> = { ...initial };
  const file = Object.assign(new TFile(), { path: 'note.md' });
  const otherFiles = new Map<TFile, Record<string, unknown>>();
  const getMarkdownFiles = vi.fn(() => [file, ...otherFiles.keys()]);
  const processFrontMatter = vi.fn().mockImplementation(async (_file, callback: (frontmatter: Record<string, unknown>) => void) => { callback(frontmatter); });
  const app = {
    metadataCache: { getFileCache: (candidate: TFile) => ({ frontmatter: candidate === file ? frontmatter : otherFiles.get(candidate) }) },
    vault: { getMarkdownFiles },
    fileManager: { processFrontMatter },
  };
  const openSettings = vi.fn();
  const requestPosition = vi.fn();
  const requestRender = vi.fn(() => {
    parent.empty();
    panel.render(parent as unknown as HTMLElement);
  });
  const panel = new TencentDocsSharePanel({
    app: app as unknown as App,
    service: service as unknown as TencentDocsService,
    file,
    requestRender, requestPosition, openSettings,
  });
  return { parent, panel, service, frontmatter, processFrontMatter, requestRender, requestPosition, openSettings, file, otherFiles, getMarkdownFiles };
}

beforeEach(() => {
  vi.mocked(buildShareSnapshot).mockResolvedValue(snapshot());
  vi.mocked(confirmShareAction).mockResolvedValue(true);
  vi.stubGlobal('window', { open: vi.fn(), requestAnimationFrame: (callback: () => void) => callback() });
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWriteText } });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Tencent Docs connector UI', () => {
  test('opens browser authorization once and keeps the pending login across settings renders', async () => {
    const service = serviceMock();
    service.getConnectionState.mockResolvedValue(disconnected);
    const pending = deferred<typeof connected>();
    const info = { verificationUrl: 'https://docs.qq.com/scenario/open-claw.html?authType=3&user_code=ABCD', userCode: 'ABCD' };
    service.login.mockImplementation((onVerification: (value: typeof info) => void) => {
      onVerification(info);
      onVerification(info);
      return pending.promise;
    });
    const parent = new Element();
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(parent as unknown as HTMLElement);
    ui.activate();
    await flush();
    expect(service.login).not.toHaveBeenCalled();
    expect(parent.all().find(node => node.tag === 'details')?.open).toBe(false);
    button(parent, '登录授权').onclick?.();
    await flush();
    expect(service.login).toHaveBeenCalledOnce();
    expect(window.open).toHaveBeenCalledExactlyOnceWith(info.verificationUrl, '_blank', 'noopener,noreferrer');
    expect(parent.textContent).toContain('ABCD');
    expect(parent.textContent).toContain('等待授权');
    const rerendered = new Element();
    ui.render(rerendered as unknown as HTMLElement);
    ui.activate();
    expect(service.getConnectionState).toHaveBeenCalledOnce();
    expect(rerendered.textContent).toContain('等待授权');
    button(rerendered, '重新打开授权页').onclick?.();
    expect(window.open).toHaveBeenCalledTimes(2);
    pending.resolve(connected);
    await flush();
    expect(rerendered.textContent).toContain('已连接');
    expect(service.connect).not.toHaveBeenCalled();
    ui.dispose();
  });

  test('cancels browser authorization and ignores a late successful result', async () => {
    const service = serviceMock();
    service.getConnectionState.mockResolvedValue(disconnected);
    const pending = deferred<typeof connected>();
    service.login.mockReturnValue(pending.promise);
    const parent = new Element();
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(parent as unknown as HTMLElement);
    ui.activate();
    await flush();
    button(parent, '登录授权').onclick?.();
    button(parent, '取消').onclick?.();
    expect(service.cancelActiveOperation).toHaveBeenCalledOnce();
    pending.resolve(connected);
    await flush();
    expect(parent.textContent).toContain('未连接');
    expect(parent.textContent).not.toContain('测试用户');
    expect(Notice).not.toHaveBeenCalled();
    ui.dispose();
    expect(service.cancelActiveOperation).toHaveBeenCalledOnce();
  });

  test('stops a pending browser login when leaving settings', async () => {
    const service = serviceMock();
    service.getConnectionState.mockResolvedValue(disconnected);
    const pending = deferred<typeof connected>();
    service.login.mockReturnValue(pending.promise);
    const parent = new Element();
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(parent as unknown as HTMLElement);
    ui.activate();
    await flush();
    button(parent, '登录授权').onclick?.();
    ui.dispose();
    expect(service.cancelActiveOperation).toHaveBeenCalledOnce();
    pending.resolve(connected);
    await flush();
    expect(Notice).not.toHaveBeenCalled();
  });

  test('rejects a verification URL outside the official Tencent Docs site', async () => {
    const service = serviceMock();
    service.getConnectionState.mockResolvedValue(disconnected);
    service.login.mockImplementation(async (onVerification: (value: { verificationUrl: string }) => void) => {
      onVerification({ verificationUrl: 'https://example.com/authorize' });
      return connected;
    });
    const parent = new Element();
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(parent as unknown as HTMLElement);
    ui.activate();
    await flush();
    button(parent, '登录授权').onclick?.();
    await flush();
    expect(window.open).not.toHaveBeenCalled();
    expect(parent.textContent).toContain('未返回有效授权地址');
    expect(parent.textContent).toContain('未连接');
    ui.dispose();
  });

  test('uses the official authorization page and clears the entered token after connect and disconnect', async () => {
    const service = serviceMock();
    service.getConnectionState.mockResolvedValue(disconnected);
    const parent = new Element();
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(parent as unknown as HTMLElement);
    ui.activate();
    await flush();
    button(parent, '获取授权 Token').onclick?.();
    expect(window.open).toHaveBeenCalledWith('https://docs.qq.com/scenario/open-claw.html?nlc=1', '_blank', 'noopener,noreferrer');
    expect(button(parent, '连接').disabled).toBe(true);
    const tokenInput = input(parent, 'password');
    tokenInput.value = '  private-token  ';
    tokenInput.oninput?.();
    expect(button(parent, '连接').disabled).toBe(false);
    button(parent, '连接').onclick?.();
    await flush();
    expect(service.connect).toHaveBeenCalledExactlyOnceWith('private-token');
    expect(parent.textContent).toContain('已连接');
    expect(parent.textContent).not.toContain('private-token');
    button(parent, '断开').onclick?.();
    await flush();
    expect(service.disconnect).toHaveBeenCalledOnce();
    expect(input(parent, 'password').value).toBe('');
    ui.dispose();
  });

  test('ignores a connection check from a disposed settings view', async () => {
    const service = serviceMock();
    const pending = deferred<typeof connected>();
    service.getConnectionState.mockReturnValueOnce(pending.promise).mockResolvedValue(disconnected);
    const ui = new TencentDocsConnectorSettings({ app: {} as App, service: service as unknown as TencentDocsService });
    ui.render(new Element() as unknown as HTMLElement);
    ui.activate();
    ui.dispose();
    const newParent = new Element();
    ui.render(newParent as unknown as HTMLElement);
    ui.activate();
    await flush();
    pending.resolve(connected);
    await flush();
    expect(newParent.textContent).toContain('未连接');
    expect(newParent.textContent).not.toContain('测试用户');
    ui.dispose();
  });
});

describe('Tencent Docs sharing UI', () => {
  test('routes a disconnected user to the connector settings without publishing', async () => {
    const f = shareFixture();
    f.service.getConnectionState.mockResolvedValue(disconnected);
    f.panel.activate();
    await flush();
    button(f.parent, '前往连接腾讯文档').onclick?.();
    expect(f.openSettings).toHaveBeenCalledOnce();
    expect(f.service.publish).not.toHaveBeenCalled();
    expect(f.processFrontMatter).not.toHaveBeenCalled();
  });

  test('preserves an edited document title when returning to the tab', async () => {
    const f = shareFixture();
    f.panel.activate();
    await flush();
    const title = input(f.parent, 'text');
    title.value = '自定义标题';
    title.oninput?.();
    f.panel.activate();
    await flush();
    expect(input(f.parent, 'text').value).toBe('自定义标题');
  });

  test('publishes the latest note and image assets only once while a request is pending', async () => {
    const f = shareFixture();
    f.panel.activate();
    await flush();
    const latest = snapshot({ markdown: '更新后的正文', assets: [{ token: 'wesight-asset://image', vaultPath: 'image.png', fileName: 'image.png', mimeType: 'image/png', contentHash: 'image', body: new ArrayBuffer(2) }] });
    vi.mocked(buildShareSnapshot).mockResolvedValueOnce(latest);
    const pending = deferred<typeof published>();
    f.service.publish.mockReturnValueOnce(pending.promise);
    const publishButton = button(f.parent, '发布到腾讯文档');
    publishButton.onclick?.();
    publishButton.onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledExactlyOnceWith({ title: '笔记标题', markdown: latest.markdown, assets: latest.assets });
    expect(f.processFrontMatter).not.toHaveBeenCalled();
    pending.resolve(published);
    await flush();
    expect(f.frontmatter['wesight-tencent-doc-id']).toBe(published.documentId);
    expect(f.frontmatter['wesight-tencent-doc-url']).toBe(published.url);
    expect(f.parent.all().find(node => node.tag === 'a')?.attrs.href).toBe(published.url);
  });

  test('keeps the created document accessible when saving note metadata fails', async () => {
    const f = shareFixture();
    f.processFrontMatter.mockRejectedValueOnce(new Error('read-only note'));
    f.panel.activate();
    await flush();
    button(f.parent, '发布到腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledOnce();
    expect(f.parent.textContent).toContain('文档链接未能保存到笔记');
    expect(button(f.parent, '创建新的腾讯文档')).toBeDefined();
    button(f.parent, '复制文档链接').onclick?.();
    await flush();
    expect(clipboardWriteText).toHaveBeenCalledWith(published.url);
    expect(f.service.publish).toHaveBeenCalledOnce();
  });

  test('updates a document saved by the previous connector and records its publication state', async () => {
    const f = shareFixture({ 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url });
    f.panel.activate();
    await flush();
    expect(f.parent.textContent).toContain('此笔记已关联腾讯文档，可以更新原文档');
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(false);
    button(f.parent, '更新腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledExactlyOnceWith({ title: '笔记标题', markdown: '# 正文', assets: [], documentId: published.documentId, url: published.url });
    const confirmation = vi.mocked(confirmShareAction).mock.calls[0][1];
    expect(confirmation).toMatchObject({ title: '更新腾讯文档', confirmText: '确认更新' });
    expect(confirmation.message).toContain('云端直接编辑的内容会被覆盖');
    expect(f.frontmatter).toMatchObject({
      'wesight-tencent-doc-id': published.documentId,
      'wesight-tencent-doc-url': published.url,
      'wesight-tencent-title': '笔记标题',
    });
    expect(f.frontmatter['wesight-tencent-content-hash']).toMatch(/^[a-f0-9]{64}$/);
    expect(f.frontmatter['wesight-tencent-published-at']).toEqual(expect.any(String));
    expect(f.parent.textContent).toContain('最后发布于');
    expect(f.parent.textContent).toContain('腾讯文档已经是当前笔记的最新内容');
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(true);
    expect(Notice).toHaveBeenCalledWith('腾讯文档已更新。');
  });

  test('detects changed title and body while keeping the same document target', async () => {
    const f = shareFixture();
    f.panel.activate();
    await flush();
    button(f.parent, '发布到腾讯文档').onclick?.();
    await flush();
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(true);
    const title = input(f.parent, 'text');
    title.value = '新标题';
    title.oninput?.();
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(false);
    expect(f.parent.textContent).toContain('笔记有更新');
    vi.mocked(buildShareSnapshot).mockResolvedValue(snapshot({ markdown: '# 新正文' }));
    f.panel.activate();
    await flush();
    expect(input(f.parent, 'text').value).toBe('新标题');
    button(f.parent, '更新腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenLastCalledWith({ title: '新标题', markdown: '# 新正文', assets: [], documentId: published.documentId, url: published.url });
    expect(f.frontmatter['wesight-tencent-title']).toBe('新标题');
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(true);
  });

  test('creates another document when requested without updating the existing target', async () => {
    const f = shareFixture({ 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url });
    f.panel.activate();
    await flush();
    button(f.parent, '创建新的腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledExactlyOnceWith({ title: '笔记标题', markdown: '# 正文', assets: [] });
    expect(confirmShareAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ confirmText: '确认发布' }));
  });

  test('uses the Feishu-style update checkbox to choose a new document', async () => {
    const f = shareFixture({ 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url });
    f.panel.activate();
    await flush();
    const update = input(f.parent, 'checkbox');
    expect(update.checked).toBe(true);
    update.checked = false;
    update.onchange?.();
    button(f.parent, '发布到腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledExactlyOnceWith({ title: '笔记标题', markdown: '# 正文', assets: [] });
  });

  test('prevents a copied note from overwriting another note document', async () => {
    const f = shareFixture({ 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url });
    f.otherFiles.set(Object.assign(new TFile(), { path: 'original.md' }), { 'wesight-tencent-doc-id': published.documentId });
    f.panel.activate();
    await flush();
    expect(f.parent.textContent).toContain('original.md');
    expect(f.parent.all().some(node => node.tag === 'button' && node.text === '更新腾讯文档')).toBe(false);
    button(f.parent, '作为新的腾讯文档发布').onclick?.();
    await flush();
    expect(f.service.publish).toHaveBeenCalledExactlyOnceWith({ title: '笔记标题', markdown: '# 正文', assets: [] });
  });

  test('keeps previous publication state and its link when an update fails', async () => {
    const original = { 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url, 'wesight-tencent-content-hash': 'old-hash' };
    const f = shareFixture(original);
    f.service.publish.mockRejectedValueOnce(new Error('更新未完成，请重试。'));
    f.panel.activate();
    await flush();
    button(f.parent, '更新腾讯文档').onclick?.();
    await flush();
    expect(f.frontmatter).toEqual(original);
    expect(f.processFrontMatter).not.toHaveBeenCalled();
    expect(f.parent.textContent).toContain('更新未完成');
    expect(f.parent.all().find(node => node.tag === 'a')?.attrs.href).toBe(published.url);
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(false);
    expect(Notice).not.toHaveBeenCalled();
  });

  test('does not update remotely after cancelling the confirmation', async () => {
    const f = shareFixture({ 'wesight-tencent-doc-id': published.documentId, 'wesight-tencent-doc-url': published.url });
    vi.mocked(confirmShareAction).mockResolvedValueOnce(false);
    f.panel.activate();
    await flush();
    button(f.parent, '更新腾讯文档').onclick?.();
    await flush();
    expect(f.service.publish).not.toHaveBeenCalled();
    expect(f.processFrontMatter).not.toHaveBeenCalled();
    expect(button(f.parent, '更新腾讯文档').disabled).toBe(false);
  });

  test('does not start remote publication if the panel closes during note preparation', async () => {
    const f = shareFixture();
    f.panel.activate();
    await flush();
    const pending = deferred<ShareSnapshot>();
    vi.mocked(buildShareSnapshot).mockReturnValueOnce(pending.promise);
    button(f.parent, '发布到腾讯文档').onclick?.();
    f.panel.dispose();
    const renderCalls = f.requestRender.mock.calls.length;
    pending.resolve(snapshot());
    await flush();
    expect(f.service.publish).not.toHaveBeenCalled();
    expect(f.processFrontMatter).not.toHaveBeenCalled();
    expect(f.requestRender).toHaveBeenCalledTimes(renderCalls);
    expect(Notice).not.toHaveBeenCalled();
  });
});
