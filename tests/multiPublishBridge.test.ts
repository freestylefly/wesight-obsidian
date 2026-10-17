import { createHmac } from 'crypto';
import http from 'http';

import { MultiPublishBridge } from '../src/multiPublish/bridge';
import type { MultiPublishAccess } from '../src/multiPublish/access';
import type { MultiPublishPairing, MultiPublishSnapshot, PublishTaskV1 } from '../src/multiPublish/types';
import { buildQuickPublishBatchSnapshot } from '../src/quickTransform/publish';

const CLIENT_ID = 'a'.repeat(32);
const SECRET = 'b'.repeat(64);

function memberAccess(): MultiPublishAccess {
  return { state: 'multi-platform', maxTargets: null };
}

type BillingState = { active: boolean; credits: number; planName: string | null; expiresAt: string | null };

interface LoopbackResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

async function loopbackRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
    }, response => {
      const chunks: Uint8Array[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk as Uint8Array)));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get: name => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : value ?? null;
            },
          },
          text: async () => body.toString('utf8'),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function snapshot(): MultiPublishSnapshot {
  const body = new Uint8Array([1, 2, 3]).buffer;
  return {
    sourcePath: '文章/测试.md',
    contentHash: 'c'.repeat(64),
    title: '多平台测试',
    digest: '摘要',
    markdown: '正文',
    html: '<p>正文</p>',
    coverAssetId: null,
    tags: ['测试'],
    original: true,
    assets: [{ id: 'd'.repeat(64), fileName: '图.png', mimeType: 'image/png', size: 3, sha256: 'd'.repeat(64), body }],
    warnings: [],
  };
}

describe('multi-platform loopback bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { setInterval, clearInterval });
  });

  afterEach(() => vi.unstubAllGlobals());

  test('connects independently without creating a task or exposing pairing credentials', async () => {
    let pairing: MultiPublishPairing | null = null;
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing,
      savePairing: async value => { pairing = value; },
    });
    await bridge.start();
    try {
      const connection = new URL(bridge.createConnectionUrl());
      expect(connection.pathname).toBe('/wesight-bridge');
      expect([...connection.searchParams]).toEqual([['connect', '1']]);
      const fragment = new URLSearchParams(connection.hash.slice(1));
      expect([...fragment.keys()]).toEqual(['pairToken']);
      expect(fragment.get('pairToken')).toMatch(/^[a-f0-9]{64}$/);
      expect(bridge.getLatestTask()).toBeNull();
      const page = await loopbackRequest(connection.toString());
      const pageBody = await page.text();
      expect(pageBody).toContain('正在连接浏览器插件');
      expect(pageBody).toContain('连接器重试');
      expect(pageBody).not.toContain(fragment.get('pairToken'));
      const response = await loopbackRequest(`${connection.origin}/v1/pair`, {
        method: 'POST',
        headers: {
          Origin: `chrome-extension://${CLIENT_ID}`,
          Authorization: `Bearer ${fragment.get('pairToken')}`,
          'Content-Type': 'application/json',
          'X-WeSight-Version': '1.1.0',
          'X-WeSight-Platforms': 'xiaohongshu,weibo-post',
          'X-WeSight-Capabilities': 'compose-v1,dynamic-compose-v1',
        },
        body: JSON.stringify({ clientId: CLIENT_ID, secret: SECRET }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"paired":true}');
      expect(bridge.getLatestTask()).toBeNull();
      expect(bridge.getConnectionState()).toMatchObject({
        paired: true, connected: true, extensionVersion: '1.1.0',
        supportedPlatforms: ['xiaohongshu', 'weibo-post'],
        capabilities: ['compose-v1', 'dynamic-compose-v1'],
      });
      const health = await loopbackRequest(`${connection.origin}/health`);
      expect(JSON.parse(await health.text())).toEqual({ protocolVersion: 1, paired: true });
      expect(JSON.stringify(bridge.getConnectionState())).not.toContain(SECRET);
      await bridge.clearPairing();
      expect(bridge.getConnectionState()).toMatchObject({
        paired: false, connected: false, extensionVersion: null, supportedPlatforms: null, capabilities: null,
      });
      const disconnectedHealth = await loopbackRequest(`${connection.origin}/health`);
      expect(await disconnectedHealth.text()).toBe('{"protocolVersion":1,"paired":false}');
    } finally {
      await bridge.stop();
    }
  });

  test('connection tokens rotate, expire, and cannot be reused or used after disconnecting', async () => {
    let now = 0;
    let pairing: MultiPublishPairing | null = null;
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing,
      savePairing: async value => { pairing = value; },
      now: () => now,
    });
    await bridge.start();
    try {
      const token = () => new URLSearchParams(new URL(bridge.createConnectionUrl()).hash.slice(1)).get('pairToken')!;
      const pair = (value: string) => loopbackRequest(`${bridge.getConnectionState().baseUrl}/v1/pair`, {
        method: 'POST',
        headers: {
          Origin: `chrome-extension://${CLIENT_ID}`,
          Authorization: `Bearer ${value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clientId: CLIENT_ID, secret: SECRET }),
      });
      const first = token();
      const second = token();
      expect(second).not.toBe(first);
      expect((await pair(first)).status).toBe(401);
      expect((await pair(second)).status).toBe(200);
      expect((await pair(second)).status).toBe(401);
      const expired = token();
      now += 10 * 60 * 1000;
      expect((await pair(expired)).status).toBe(401);
      const cleared = token();
      await bridge.clearPairing();
      expect((await pair(cleared)).status).toBe(401);
      expect(pairing).toBeNull();
    } finally {
      await bridge.stop();
    }
  });

  test('an explicit connection permits a different extension while retaining origin and token checks', async () => {
    let pairing: MultiPublishPairing | null = {
      clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date().toISOString(),
    };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing,
      savePairing: async value => { pairing = value; },
    });
    await bridge.start();
    try {
      const nextClient = 'c'.repeat(32);
      const origin = `chrome-extension://${nextClient}`;
      const connection = new URL(bridge.createConnectionUrl());
      const token = new URLSearchParams(connection.hash.slice(1)).get('pairToken')!;
      const preflight = await loopbackRequest(`${connection.origin}/v1/pair`, {
        method: 'OPTIONS', headers: { Origin: origin },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect((await loopbackRequest(`${connection.origin}/v1/access`, { headers: { Origin: origin } })).status).toBe(403);
      const pair = (clientId: string, bearer: string) => loopbackRequest(`${connection.origin}/v1/pair`, {
        method: 'POST',
        headers: { Origin: origin, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, secret: SECRET }),
      });
      expect((await pair(nextClient, 'invalid')).status).toBe(401);
      expect((await pair(CLIENT_ID, token)).status).toBe(400);
      expect((await pair(nextClient, token)).status).toBe(200);
      expect(pairing).toMatchObject({ clientId: nextClient });
      expect((await loopbackRequest(`${connection.origin}/v1/pair`, {
        method: 'OPTIONS', headers: { Origin: `chrome-extension://${CLIENT_ID}` },
      })).status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });

  test('health checks keep the connection alive and notify settings when it reconnects', async () => {
    let now = 0;
    const pairing: MultiPublishPairing = { clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date(now).toISOString() };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing, savePairing: async () => undefined, now: () => now,
    });
    await bridge.start();
    const listener = vi.fn();
    bridge.onChange(listener);
    try {
      expect(bridge.getConnectionState().connected).toBe(false);
      const ping = (clientId = CLIENT_ID) => loopbackRequest(`${bridge.getConnectionState().baseUrl}/health`, {
        headers: {
          Origin: `chrome-extension://${CLIENT_ID}`, 'X-WeSight-Client': clientId,
          'X-WeSight-Version': '1.1.0', 'X-WeSight-Platforms': 'xiaohongshu',
        },
      });
      await ping('d'.repeat(32));
      expect(bridge.getConnectionState().connected).toBe(false);
      await ping();
      expect(bridge.getConnectionState().connected).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      now += 60_000;
      await ping();
      expect(listener).toHaveBeenCalledTimes(1);
      now += 89_999;
      expect(bridge.getConnectionState().connected).toBe(true);
      now += 1;
      expect(bridge.getConnectionState().connected).toBe(false);
      await ping();
      expect(bridge.getConnectionState().connected).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      await bridge.stop();
      expect(bridge.getConnectionState().connected).toBe(false);
      await bridge.start();
      expect(bridge.getConnectionState().connected).toBe(false);
    } finally {
      await bridge.stop();
    }
  });

  test('consumes the pairing token before persistence so concurrent pairing cannot reuse it', async () => {
    let pairing: MultiPublishPairing | null = null;
    let finishSave: () => void = () => undefined;
    const saved = new Promise<void>(resolve => { finishSave = resolve; });
    const savePairing = vi.fn(async (value: MultiPublishPairing | null) => {
      await saved;
      pairing = value;
    });
    const bridge = new MultiPublishBridge({ getAccess: memberAccess, getPairing: () => pairing, savePairing });
    await bridge.start();
    try {
      const connection = new URL(bridge.createConnectionUrl());
      const pair = () => loopbackRequest(`${connection.origin}/v1/pair`, {
        method: 'POST',
        headers: {
          Origin: `chrome-extension://${CLIENT_ID}`,
          Authorization: `Bearer ${new URLSearchParams(connection.hash.slice(1)).get('pairToken')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clientId: CLIENT_ID, secret: SECRET }),
      });
      const first = pair();
      await vi.waitFor(() => expect(savePairing).toHaveBeenCalledTimes(1));
      expect((await pair()).status).toBe(401);
      finishSave();
      expect((await first).status).toBe(200);
      expect(savePairing).toHaveBeenCalledTimes(1);
    } finally {
      finishSave();
      await bridge.stop();
    }
  });

  test('pairs, signs a task manifest, serves assets, and verifies task events', async () => {
    let pairing: MultiPublishPairing | null = null;
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing,
      savePairing: async value => { pairing = value; },
    });
    await bridge.start();
    try {
      const created = bridge.createTask(snapshot(), [
        'zhihu', 'csdn', 'juejin', 'bilibili-article', 'toutiao', 'weibo-article',
      ]);
      const handoff = new URL(created.handoffUrl);
      const taskToken = new URLSearchParams(handoff.hash.slice(1)).get('taskToken')!;
      const pairToken = new URLSearchParams(handoff.hash.slice(1)).get('pairToken')!;
      const baseUrl = bridge.getConnectionState().baseUrl!;
      const extensionHeaders = { Origin: `chrome-extension://${CLIENT_ID}` };
      const pairResponse = await loopbackRequest(`${baseUrl}/v1/pair`, {
        method: 'POST',
        headers: { ...extensionHeaders, Authorization: `Bearer ${pairToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, secret: SECRET }),
      });
      expect(pairResponse.status).toBe(200);
      expect(pairing).toMatchObject({ clientId: CLIENT_ID, secret: SECRET });

      const taskResponse = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}`, {
        headers: {
          ...extensionHeaders,
          Authorization: `Bearer ${taskToken}`,
          'X-WeSight-Client': CLIENT_ID,
          'X-WeSight-Platforms': 'zhihu,xiaohongshu',
          'X-WeSight-Version': '0.1.0',
          'X-WeSight-Capabilities': 'target-payloads-v1',
        },
      });
      const taskBody = await taskResponse.text();
      expect(taskResponse.status).toBe(200);
      expect(taskResponse.headers.get('x-wesight-signature'))
        .toBe(createHmac('sha256', SECRET).update(taskBody).digest('hex'));
      const parsedTask = JSON.parse(taskBody) as { behavior: { finalAction: string; groupTabs: boolean }; targets: string[] };
      expect(parsedTask.behavior).toEqual({ finalAction: 'manual', groupTabs: true });
      expect(parsedTask.targets).toHaveLength(6);
      expect(bridge.getConnectionState()).toMatchObject({
        extensionVersion: '0.1.0',
        supportedPlatforms: ['zhihu', 'xiaohongshu'],
        capabilities: ['target-payloads-v1'],
      });

      const openUrl = new URL(bridge.createOpenUrl(created.task.taskId, 'zhihu'));
      expect(openUrl.searchParams.get('openPlatform')).toBe('zhihu');
      expect(new URLSearchParams(openUrl.hash.slice(1)).get('taskToken')).toBe(taskToken);
      const openTaskUrl = new URL(bridge.createOpenTaskUrl(created.task.taskId));
      expect(openTaskUrl.searchParams.get('openTask')).toBe('1');
      expect(new URLSearchParams(openTaskUrl.hash.slice(1)).get('taskToken')).toBe(taskToken);

      const assetResponse = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}/assets/${'d'.repeat(64)}`, {
        headers: { ...extensionHeaders, Authorization: `Bearer ${taskToken}`, 'X-WeSight-Client': CLIENT_ID },
      });
      expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const event = JSON.stringify({
        protocolVersion: 1,
        taskId: created.task.taskId,
        platformId: 'weibo-article',
        status: 'ready',
        message: '内容已准备，请检查后发布',
        occurredAt: new Date().toISOString(),
      });
      const eventResponse = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}/events`, {
        method: 'POST',
        headers: {
          ...extensionHeaders,
          Authorization: `Bearer ${taskToken}`,
          'Content-Type': 'application/json',
          'X-WeSight-Client': CLIENT_ID,
          'X-WeSight-Signature': createHmac('sha256', SECRET).update(event).digest('hex'),
        },
        body: event,
      });
      expect(eventResponse.status).toBe(200);
      expect(bridge.getTask(created.task.taskId)?.platforms['weibo-article'].status).toBe('ready');

      const xiaohongshu = bridge.createTask(snapshot(), ['xiaohongshu']);
      expect(xiaohongshu.task.targets).toEqual(['xiaohongshu']);
      expect(xiaohongshu.task.platforms.xiaohongshu.status).toBe('queued');
      expect(xiaohongshu.task.platforms.zhihu.status).toBe('cancelled');
    } finally {
      await bridge.stop();
    }
  });

  test('rejects expired task access', async () => {
    let now = Date.now();
    const pairing: MultiPublishPairing = { clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date(now).toISOString() };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess, getPairing: () => pairing, savePairing: async () => undefined, now: () => now });
    await bridge.start();
    try {
      const created = bridge.createTask(snapshot(), ['juejin']);
      const token = new URLSearchParams(new URL(created.handoffUrl).hash.slice(1)).get('taskToken')!;
      now += 10 * 60 * 1000 + 1;
      const response = await loopbackRequest(`${bridge.getConnectionState().baseUrl}/v1/tasks/${created.task.taskId}`, {
        headers: {
          Origin: `chrome-extension://${CLIENT_ID}`,
          Authorization: `Bearer ${token}`,
          'X-WeSight-Client': CLIENT_ID,
        },
      });
      expect(response.status).toBe(401);
    } finally {
      await bridge.stop();
    }
  });

  test('requires a capability-aware extension for platform-specific payloads', async () => {
    const pairing: MultiPublishPairing = {
      clientId: CLIENT_ID,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
    };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess, getPairing: () => pairing, savePairing: async () => undefined });
    await bridge.start();
    try {
      const batch = snapshot();
      batch.targetPayloads = {
        xiaohongshu: {
          article: {
            title: '小红书标题',
            digest: '小红书摘要',
            markdown: '小红书正文',
            html: '<p>小红书正文</p>',
            coverAssetId: null,
            tags: ['小红书'],
          },
          assetIds: [],
        },
        'weibo-post': {
          article: {
            title: '微博标题',
            digest: '微博摘要',
            markdown: '微博正文',
            html: '<p>微博正文</p>',
            coverAssetId: null,
            tags: ['微博'],
          },
          assetIds: [],
        },
      };
      const created = bridge.createTask(batch, ['xiaohongshu', 'weibo-post']);
      const token = new URLSearchParams(new URL(created.handoffUrl).hash.slice(1)).get('taskToken')!;
      const requestHeaders = {
        Origin: `chrome-extension://${CLIENT_ID}`,
        Authorization: `Bearer ${token}`,
        'X-WeSight-Client': CLIENT_ID,
        'X-WeSight-Platforms': 'xiaohongshu,weibo-post',
        'X-WeSight-Version': '0.1.0',
      };
      const outdated = await loopbackRequest(
        `${bridge.getConnectionState().baseUrl}/v1/tasks/${created.task.taskId}`,
        { headers: requestHeaders },
      );
      expect(outdated.status).toBe(426);

      const current = await loopbackRequest(
        `${bridge.getConnectionState().baseUrl}/v1/tasks/${created.task.taskId}`,
        { headers: { ...requestHeaders, 'X-WeSight-Capabilities': 'target-payloads-v1' } },
      );
      expect(current.status).toBe(200);
      const manifest = JSON.parse(await current.text()) as { targetPayloads: Record<string, { article: { markdown: string } }> };
      expect(manifest.targetPayloads.xiaohongshu.article.markdown).toBe('小红书正文');
      expect(manifest.targetPayloads['weibo-post'].article.markdown).toBe('微博正文');
    } finally {
      await bridge.stop();
    }
  });
  test('retains a legacy platform limit while verifying current membership', async () => {
    let now = Date.now();
    const pairing: MultiPublishPairing = { clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date(now).toISOString() };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess,
      getPairing: () => pairing,
      savePairing: async () => undefined,
      getUser: () => ({ userId: 'user-1', nickname: 'WeSight user', avatarUrl: null }),
      now: () => now,
    });
    await bridge.start();
    try {
      expect(() => bridge.createComposeTask(snapshot(), { state: 'login-required', maxTargets: 0 })).toThrow('请先登录');
      const created = bridge.createComposeTask(snapshot(), { state: 'single-platform', maxTargets: 1 });
      const handoff = new URL(created.handoffUrl);
      expect(handoff.searchParams.get('compose')).toBe('1');
      expect(created.task.compose).toBe(true);
      expect(bridge.getLatestComposeTask('文章/测试.md')?.taskId).toBe(created.task.taskId);
      expect(bridge.getLatestComposeTask('文章/其他.md')).toBeNull();

      const token = new URLSearchParams(handoff.hash.slice(1)).get('taskToken')!;
      const baseUrl = bridge.getConnectionState().baseUrl!;
      const headers = {
        Origin: `chrome-extension://${CLIENT_ID}`,
        Authorization: `Bearer ${token}`,
        'X-WeSight-Client': CLIENT_ID,
        'X-WeSight-Version': '1.0.0',
      };
      const outdated = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}`, {
        headers: { ...headers, 'X-WeSight-Capabilities': 'target-payloads-v1' },
      });
      expect(outdated.status).toBe(426);

      const current = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}`, {
        headers: { ...headers, 'X-WeSight-Capabilities': 'target-payloads-v1,compose-v1' },
      });
      expect(current.status).toBe(200);
      const manifest = JSON.parse(await current.text()) as { compose: { maxTargets: number | null }; targets: string[] };
      expect(manifest.compose).toEqual({ maxTargets: 1 });
      expect(manifest.targets).toEqual(['zhihu', 'csdn', 'juejin', 'bilibili-article', 'toutiao', 'weibo-article', 'x-article']);

      const access = await loopbackRequest(`${baseUrl}/v1/access`, {
        headers: { Origin: `chrome-extension://${CLIENT_ID}`, 'X-WeSight-Client': CLIENT_ID },
      });
      const accessBody = await access.text();
      expect(JSON.parse(accessBody)).toEqual({ protocolVersion: 1, state: 'multi-platform', maxTargets: null, user: { userId: 'user-1', nickname: 'WeSight user', avatarUrl: null } });
      expect(access.headers.get('x-wesight-signature')).toBe(createHmac('sha256', SECRET).update(accessBody).digest('hex'));
      const unpaired = await loopbackRequest(`${baseUrl}/v1/access`, {
        headers: { Origin: `chrome-extension://${CLIENT_ID}`, 'X-WeSight-Client': 'c'.repeat(32) },
      });
      expect(unpaired.status).toBe(401);

      // Picking platforms can take longer than the content handoff window.
      now += 30 * 60 * 1000;
      const expired = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}`, {
        headers: { ...headers, 'X-WeSight-Capabilities': 'target-payloads-v1,compose-v1' },
      });
      expect(expired.status).toBe(401);
      const event = JSON.stringify({
        protocolVersion: 1,
        taskId: created.task.taskId,
        platformId: 'juejin',
        status: 'filling',
        occurredAt: new Date(now).toISOString(),
      });
      const eventResponse = await loopbackRequest(`${baseUrl}/v1/tasks/${created.task.taskId}/events`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-WeSight-Signature': createHmac('sha256', SECRET).update(event).digest('hex'),
        },
        body: event,
      });
      expect(eventResponse.status).toBe(200);
      expect(bridge.getTask(created.task.taskId)?.platforms.juejin.status).toBe('filling');
    } finally {
      await bridge.stop();
    }
  });

  test('hands four independent dynamic drafts including X to the composer and accepts X status events', async () => {
    const pairing: MultiPublishPairing = { clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date().toISOString() };
    const bridge = new MultiPublishBridge({ getAccess: memberAccess, getPairing: () => pairing, savePairing: async () => undefined });
    await bridge.start();
    try {
      const access = { state: 'multi-platform' as const, maxTargets: null };
      const articleTask = bridge.createComposeTask(snapshot(), access);
      const targets = ['xiaohongshu', 'weibo-post', 'jike-post', 'x-post'] as const;
      const drafts = Object.fromEntries(targets.map((platformId, index) => {
        const draft = snapshot();
        const assetId = (index + 1).toString().repeat(64);
        draft.title = `${platformId} 标题`;
        draft.markdown = `${platformId} 独立文案`;
        draft.html = `<p>${draft.markdown}</p>`;
        draft.assets = [{ ...draft.assets[0], id: assetId, sha256: assetId }];
        draft.coverAssetId = assetId;
        if (platformId === 'jike-post') draft.targetOptions = { jikePost: { circle: 'AI 探索站' } };
        if (platformId === 'x-post') draft.targetOptions = { xPost: { includeTitle: false } };
        return [platformId, draft];
      }));
      const batch = buildQuickPublishBatchSnapshot([...targets], drafts);
      const created = bridge.createDynamicComposeTask(batch, [...targets], access);
      expect(created.task.targets).toEqual(targets);
      expect(created.task.compose).toBe(true);
      expect(new URL(created.handoffUrl).searchParams.get('compose')).toBe('1');
      expect(bridge.getLatestComposeTask(batch.sourcePath)?.taskId).toBe(articleTask.task.taskId);

      const taskToken = new URLSearchParams(new URL(created.handoffUrl).hash.slice(1)).get('taskToken')!;
      const headers = {
        Origin: `chrome-extension://${CLIENT_ID}`,
        Authorization: `Bearer ${taskToken}`,
        'X-WeSight-Client': CLIENT_ID,
        'X-WeSight-Capabilities': 'target-payloads-v1,compose-v1',
      };
      const url = `${bridge.getConnectionState().baseUrl}/v1/tasks/${created.task.taskId}`;
      const oldExtension = await loopbackRequest(url, { headers });
      expect(oldExtension.status).toBe(426);
      const upgradeMessage = JSON.parse(await oldExtension.text()) as { error: string };
      expect(upgradeMessage.error).toContain('动态发布中心');

      const current = await loopbackRequest(url, {
        headers: { ...headers, 'X-WeSight-Capabilities': 'target-payloads-v1,compose-v1,dynamic-compose-v1' },
      });
      expect(current.status).toBe(200);
      const body = await current.text();
      expect(current.headers.get('x-wesight-signature')).toBe(createHmac('sha256', SECRET).update(body).digest('hex'));
      const manifest = JSON.parse(body) as PublishTaskV1;
      expect(manifest.protocolVersion).toBe(1);
      expect(manifest.compose).toEqual({ kind: 'dynamic', maxTargets: null });
      expect(manifest.targets).toEqual(targets);
      expect(manifest.behavior).toEqual({ finalAction: 'manual', groupTabs: true });
      expect(manifest.assets).toHaveLength(4);
      for (const [index, platformId] of targets.entries()) {
        expect(manifest.targetPayloads?.[platformId]?.article.markdown).toBe(`${platformId} 独立文案`);
        expect(manifest.targetPayloads?.[platformId]?.assetIds).toEqual([(index + 1).toString().repeat(64)]);
      }
      expect(manifest.targetPayloads?.['jike-post']?.targetOptions?.jikePost?.circle).toBe('AI 探索站');
      expect(manifest.targetPayloads?.['x-post']?.targetOptions?.xPost?.includeTitle).toBe(false);
      const event = JSON.stringify({ protocolVersion: 1, taskId: created.task.taskId, platformId: 'x-post', status: 'ready', occurredAt: new Date().toISOString() });
      const eventResponse = await loopbackRequest(`${url}/events`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-WeSight-Signature': createHmac('sha256', SECRET).update(event).digest('hex') }, body: event,
      });
      expect(eventResponse.status).toBe(200);
      expect(bridge.getTask(created.task.taskId)?.platforms['x-post'].status).toBe('ready');
      expect(new URL(bridge.createOpenTaskUrl(created.task.taskId)).searchParams.get('openTask')).toBe('1');

      expect(() => bridge.createDynamicComposeTask(batch, [...targets], { state: 'login-required', maxTargets: 0 }))
        .toThrow('请先登录');
      expect(() => bridge.createDynamicComposeTask(snapshot(), ['zhihu'], access)).toThrow('动态发布仅支持');
      expect(() => bridge.createDynamicComposeTask(snapshot(), [], access)).toThrow('请选择至少一个');
    } finally {
      await bridge.stop();
    }
  });
});

describe('browser bridge membership enforcement', () => {
  beforeEach(() => vi.stubGlobal('window', { setInterval, clearInterval }));
  afterEach(() => vi.unstubAllGlobals());

  async function fixture(paired = true) {
    let access: MultiPublishAccess | Error = memberAccess();
    let billing: BillingState | null = null;
    let pairing: MultiPublishPairing | null = paired
      ? { clientId: CLIENT_ID, secret: SECRET, pairedAt: new Date().toISOString() }
      : null;
    const getAccess = vi.fn(async () => {
      if (access instanceof Error) throw access;
      return access;
    });
    const bridge = new MultiPublishBridge({
      getPairing: () => pairing,
      savePairing: async value => { pairing = value; },
      getAccess,
      getBilling: () => billing,
    });
    await bridge.start();
    const created = bridge.createTask(snapshot(), ['zhihu']);
    const handoff = new URL(created.handoffUrl);
    const headers = {
      Origin: `chrome-extension://${CLIENT_ID}`,
      Authorization: `Bearer ${new URLSearchParams(handoff.hash.slice(1)).get('taskToken')}`,
      'X-WeSight-Client': CLIENT_ID,
    };
    const taskUrl = `${handoff.origin}/v1/tasks/${created.task.taskId}`;
    return {
      bridge, created, headers, taskUrl, getAccess,
      setAccess(value: MultiPublishAccess | Error) { access = value; },
      setBilling(value: BillingState | null) { billing = value; },
      getPairing: () => pairing,
      pair(token: string) {
        return loopbackRequest(`${handoff.origin}/v1/pair`, {
          method: 'POST',
          headers: { Origin: headers.Origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: CLIENT_ID, secret: SECRET }),
        });
      },
    };
  }

  const denials: { label: string; access: MultiPublishAccess | Error; status: number; message: string }[] = [
    { label: 'free user', access: { state: 'single-platform', maxTargets: 1 }, status: 403, message: '开通或续费' },
    { label: 'signed-out user', access: { state: 'login-required', maxTargets: 0 }, status: 401, message: '请先登录' },
    { label: 'unavailable membership service', access: new Error('upstream unavailable'), status: 503, message: '稍后重试' },
  ];

  test.each(denials)('rejects an issued pairing token after access changes to $label', async ({ access, status, message }) => {
    const f = await fixture(false);
    try {
      const token = new URLSearchParams(new URL(f.bridge.createConnectionUrl()).hash.slice(1)).get('pairToken')!;
      f.setAccess(access);
      const rejected = await f.pair(token);
      expect(rejected.status).toBe(status);
      expect(await rejected.text()).toContain(message);
      expect(f.getPairing()).toBeNull();
      expect(f.bridge.getTask(f.created.task.taskId)).not.toBeNull();
      f.setAccess(memberAccess());
      expect((await f.pair(token)).status).toBe(200);
    } finally {
      await f.bridge.stop();
    }
  });

  test.each(denials)('blocks saved-pairing task and image reads for $label without clearing drafts', async ({ access, status, message }) => {
    const f = await fixture();
    try {
      f.setAccess(access);
      for (const url of [f.taskUrl, `${f.taskUrl}/assets/${'d'.repeat(64)}`]) {
        const rejected = await loopbackRequest(url, { headers: f.headers });
        expect(rejected.status).toBe(status);
        const body = await rejected.text();
        expect(body).toContain(message);
        expect(body).not.toContain('正文');
        expect(rejected.headers.get('x-wesight-signature')).toBeNull();
      }
      expect(f.bridge.getTask(f.created.task.taskId)).not.toBeNull();
      expect(f.getPairing()).not.toBeNull();
      f.setAccess(memberAccess());
      const allowed = await loopbackRequest(f.taskUrl, { headers: f.headers });
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain('正文');
      const image = await loopbackRequest(`${f.taskUrl}/assets/${'d'.repeat(64)}`, { headers: f.headers });
      expect(image.status).toBe(200);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await f.bridge.stop();
    }
  });

  test.each([
    { label: 'inactive', active: false, expiresAt: null, status: 403 },
    { label: 'expired', active: true, expiresAt: '2000-01-01T00:00:00.000Z', status: 403 },
    { label: 'invalid expiry', active: true, expiresAt: 'invalid', status: 503 },
  ])('denies pairing and content when cached billing is $label despite a member access result', async ({ active, expiresAt, status }) => {
    const f = await fixture();
    try {
      const token = new URLSearchParams(new URL(f.bridge.createConnectionUrl()).hash.slice(1)).get('pairToken')!;
      f.setBilling({ active, expiresAt, credits: 0, planName: '创作者会员' });
      expect((await f.pair(token)).status).toBe(status);
      expect((await loopbackRequest(f.taskUrl, { headers: f.headers })).status).toBe(status);
      expect((await loopbackRequest(`${f.taskUrl}/assets/${'d'.repeat(64)}`, { headers: f.headers })).status).toBe(status);
      f.setBilling({ active: true, expiresAt: '2999-01-01T00:00:00.000Z', credits: 0, planName: '创作者会员' });
      expect((await loopbackRequest(f.taskUrl, { headers: f.headers })).status).toBe(200);
    } finally {
      await f.bridge.stop();
    }
  });

  test('keeps health checks and signed progress updates available without membership lookups', async () => {
    const f = await fixture();
    try {
      f.setAccess(new Error('upstream unavailable'));
      const baseUrl = f.bridge.getConnectionState().baseUrl!;
      expect((await loopbackRequest(`${baseUrl}/health`, { headers: f.headers })).status).toBe(200);
      const event = JSON.stringify({ protocolVersion: 1, taskId: f.created.task.taskId, platformId: 'zhihu', status: 'filling', occurredAt: new Date().toISOString() });
      const progress = await loopbackRequest(`${f.taskUrl}/events`, {
        method: 'POST',
        headers: { ...f.headers, 'Content-Type': 'application/json', 'X-WeSight-Signature': createHmac('sha256', SECRET).update(event).digest('hex') },
        body: event,
      });
      expect(progress.status).toBe(200);
      expect(f.bridge.getTask(f.created.task.taskId)?.platforms.zhihu.status).toBe('filling');
      expect(f.getAccess).not.toHaveBeenCalled();
    } finally {
      await f.bridge.stop();
    }
  });

  test('rechecks task credentials after the asynchronous membership lookup', async () => {
    const f = await fixture();
    let finish: (access: MultiPublishAccess) => void = () => undefined;
    const pending = new Promise<MultiPublishAccess>(resolve => { finish = resolve; });
    f.getAccess.mockImplementationOnce(() => pending);
    try {
      const reading = loopbackRequest(f.taskUrl, { headers: f.headers });
      await vi.waitFor(() => expect(f.getAccess).toHaveBeenCalledOnce());
      await f.bridge.clearPairing();
      finish(memberAccess());
      const rejected = await reading;
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).not.toContain('正文');
    } finally {
      finish(memberAccess());
      await f.bridge.stop();
    }
  });
});
