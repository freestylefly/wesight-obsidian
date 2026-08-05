vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import { ShareCloudApi, CloudApiError } from '../src/share/cloudApi';

const auth = {
  getAccessToken: vi.fn(async () => 'cloud-access-token'),
  refreshAccessToken: vi.fn(),
  clearSession: vi.fn(),
};

const snapshot = {
  title: 'Hello',
  markdown: '# Hello',
  contentHash: 'hash-hello',
  assets: [],
  warnings: [],
};

describe('ShareCloudApi billable create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends the stable idempotency key with a share create', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: {
        code: 0,
        data: {
          id: 'share-1',
          slug: 's1',
          url: 'https://share.wesight.ai/s1',
          title: 'Hello',
          contentHash: 'hash-hello',
          commentsEnabled: false,
          commentCount: 0,
          enabled: true,
          publishedAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
          assets: [],
        },
      },
    } as never);

    const api = new ShareCloudApi(auth as never);
    await api.createShare(snapshot, 'publish-request-123');

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

    const api = new ShareCloudApi(auth as never);
    let error: unknown;
    try {
      await api.createShare(snapshot, 'publish-request-123');
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
