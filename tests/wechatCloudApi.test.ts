vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import { WeChatCloudApi } from '../src/wechat/cloudApi';
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
