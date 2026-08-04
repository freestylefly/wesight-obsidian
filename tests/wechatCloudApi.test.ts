vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import { WeChatCloudApi } from '../src/wechat/cloudApi';
import { CloudApiError } from '../src/share/cloudApi';
import type { WeChatAssetDraft } from '../src/wechat/types';

const auth = {
  getAccessToken: vi.fn(async () => 'cloud-access-token'),
  refreshAccessToken: vi.fn(),
  clearSession: vi.fn(),
};

const asset: WeChatAssetDraft = {
  token: 'asset-token',
  source: 'article.png',
  fileName: 'article.png',
  mimeType: 'image/png',
  contentHash: 'a'.repeat(64),
  body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
  previewUrl: 'blob:preview',
};

describe('WeChat direct asset uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('requests a ticket then sends the original binary directly to Aliyun', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          code: 0,
          data: {
            uploadUrl: 'https://121.40.71.44/v1/wechat/assets',
            uploadToken: 'direct-upload-token',
            expiresAt: '2026-08-01T12:00:00.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { ok: true, data: { url: 'http://mmbiz.qpic.cn/article.png' } },
      } as never);

    const api = new WeChatCloudApi(auth as never);
    await expect(api.uploadAsset('content', asset)).resolves.toEqual({
      kind: 'content',
      url: 'https://mmbiz.qpic.cn/article.png',
    });

    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestUrl).mock.calls[0]?.[0]).toMatchObject({
      url: 'https://api.wesight.ai/api/wechat/assets/ticket',
      method: 'POST',
      headers: { Authorization: 'Bearer cloud-access-token' },
    });
    expect(vi.mocked(requestUrl).mock.calls[1]?.[0]).toMatchObject({
      url: 'https://121.40.71.44/v1/wechat/assets',
      method: 'POST',
      body: asset.body,
      headers: { 'x-wesight-upload-token': 'direct-upload-token' },
    });
    expect(vi.mocked(requestUrl).mock.calls[1]?.[0]).not.toHaveProperty(
      'headers.Authorization',
    );
  });

  test('records a directly uploaded cover in WeSight Cloud', async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          code: 0,
          data: {
            uploadUrl: 'https://121.40.71.44/v1/wechat/assets',
            uploadToken: 'direct-upload-token',
            expiresAt: '2026-08-01T12:00:00.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { ok: true, data: { media_id: 'wechat-cover-id' } },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          code: 0,
          data: { kind: 'cover', mediaId: 'wechat-cover-id', connection: {} },
        },
      } as never);

    const api = new WeChatCloudApi(auth as never);
    await expect(api.uploadAsset('cover', asset)).resolves.toMatchObject({
      kind: 'cover',
      mediaId: 'wechat-cover-id',
    });
    expect(vi.mocked(requestUrl).mock.calls[2]?.[0]).toMatchObject({
      url: 'https://api.wesight.ai/api/wechat/assets/complete',
      method: 'POST',
      body: JSON.stringify({ mediaId: 'wechat-cover-id' }),
      headers: { Authorization: 'Bearer cloud-access-token' },
    });
  });
});

describe('WeChat billable draft requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends the stable idempotency key with a draft create', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: {
        code: 0,
        data: {
          id: 'draft-1',
          title: 'Article',
          contentHash: 'hash',
          status: 'active',
          syncedAt: '2026-08-04T00:00:00.000Z',
          updatedAt: '2026-08-04T00:00:00.000Z',
        },
      },
    } as never);
    const api = new WeChatCloudApi(auth as never);
    await api.createDraft({ title: 'Article' } as never, 'publish-request-123');
    expect(vi.mocked(requestUrl).mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer cloud-access-token',
        'Idempotency-Key': 'publish-request-123',
      },
    });
  });

  test('preserves the structured insufficient-credit response', async () => {
    const summary = { totalCreditsRemaining: 0, publishCost: 1 };
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 402,
      json: {
        code: 1,
        error: 'INSUFFICIENT_CREDITS',
        message: '积分不足',
        data: summary,
      },
    } as never);
    const api = new WeChatCloudApi(auth as never);
    let error: unknown;
    try {
      await api.createDraft({ title: 'Article' } as never, 'publish-request-123');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
      data: summary,
    });
  });
});
