vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import {
  fetchWeChatArticleStats,
  resolveErrorMessage,
  ArticleStatsError,
} from '../src/wechat/articleStats';
import { CloudApiError } from '../src/share/cloudApi';
import type { CloudAuthService } from '../src/share/cloudAuth';

function createAuth(token = 'test-token'): CloudAuthService {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
  } as unknown as CloudAuthService;
}

describe('fetchWeChatArticleStats via backend proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends POST JSON to backend with authorization header', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 0, message: '成功', data: { read: 10 } },
    } as never);

    const auth = createAuth();
    const result = await fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', auth);

    expect(result).toEqual({ code: 0, message: '成功', data: { read: 10 } });
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(requestUrl).mock.calls[0]?.[0] as {
      url: string;
      method: string;
      contentType: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(call).toMatchObject({
      url: 'https://api.wesight.ai/api/wechat/article-stats',
      method: 'POST',
      contentType: 'application/json',
    });
    expect(call.body).toBe(JSON.stringify({ url: 'https://mp.weixin.qq.com/s/abc' }));
    expect(call.headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  test('maps backend error codes to Chinese messages', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 20001, message: '金额不足，请充值', data: '' },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', createAuth()),
    ).rejects.toThrow('金额不足，请充值');
  });

  test('maps 20002 to invalid WeChat link message', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 20002, data: '' },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', createAuth()),
    ).rejects.toThrow('请输入正确的微信链接');
  });

  test('treats 402 as CloudApiError with billing data', async () => {
    const billing = {
      totalCreditsRemaining: 0,
      balances: { free: 0, membership: 0, purchased: 0 },
      creditItems: [],
      membership: { active: false },
    };
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 402,
      json: {
        code: 1,
        error: 'INSUFFICIENT_CREDITS',
        message: '积分不足，请充值积分或开通创作者会员',
        data: billing,
      },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', createAuth()),
    ).rejects.toThrow(CloudApiError);
  });

  test('handles requestUrl throw', async () => {
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', createAuth()),
    ).rejects.toThrow('Network failure');
  });
});

describe('resolveErrorMessage', () => {
  test('returns ArticleStatsError message', () => {
    expect(resolveErrorMessage(new ArticleStatsError('余额不足', 20001))).toBe('余额不足');
  });

  test('returns CloudApiError message', () => {
    expect(resolveErrorMessage(new CloudApiError('积分不足', 402))).toBe('积分不足');
  });

  test('returns generic message for unknown errors', () => {
    expect(resolveErrorMessage(null)).toBe('加载文章数据失败');
  });
});
