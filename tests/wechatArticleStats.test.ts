vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import {
  DAJIALA_READ_ZAN_PRO_URL,
  fetchWeChatArticleStats,
  resolveErrorMessage,
  ArticleStatsError,
} from '../src/wechat/articleStats';

describe('fetchWeChatArticleStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('rejects when key is empty', async () => {
    await expect(fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', '')).rejects.toThrow(
      '尚未配置公众号数据监控 key',
    );
  });

  test('sends url-encoded form body with key and optional verifycode', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 0, msg: '成功', data: { read: 10 } },
    } as never);

    const result = await fetchWeChatArticleStats(
      'https://mp.weixin.qq.com/s/abc',
      'JZL84b953ba8f9d7bc3',
      'verify-123',
    );

    expect(result).toEqual({ code: 0, message: '成功', data: { read: 10 } });
    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(requestUrl).mock.calls[0]?.[0] as { body: string };
    expect(call).toMatchObject({
      url: DAJIALA_READ_ZAN_PRO_URL,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(call.body).toContain('url=https%3A%2F%2Fmp.weixin.qq.com%2Fs%2Fabc');
    expect(call.body).toContain('key=JZL84b953ba8f9d7bc3');
    expect(call.body).toContain('verifycode=verify-123');
  });

  test('does not include verifycode when omitted', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 0, msg: '成功', data: {} },
    } as never);

    await fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', 'JZL-key');

    const call = vi.mocked(requestUrl).mock.calls[0]?.[0] as { body: string };
    expect(call.body).not.toContain('verifycode');
  });

  test('maps known error codes to Chinese messages', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 20001, msg: '金额不足，请充值', data: '' },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', 'JZL-key'),
    ).rejects.toThrow('金额不足，请充值');
  });

  test('maps 20002 to invalid WeChat link message', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 20002, data: '' },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', 'JZL-key'),
    ).rejects.toThrow('请输入正确的微信链接');
  });

  test('treats Internal Server Error as network error', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 500,
      json: { message: 'Internal Server Error' },
    } as never);

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', 'JZL-key'),
    ).rejects.toThrow('网络错误，请重试1~3次');
  });

  test('handles requestUrl throw', async () => {
    vi.mocked(requestUrl).mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      fetchWeChatArticleStats('https://mp.weixin.qq.com/s/abc', 'JZL-key'),
    ).rejects.toThrow('Network failure');
  });
});

describe('resolveErrorMessage', () => {
  test('returns ArticleStatsError message', () => {
    expect(resolveErrorMessage(new ArticleStatsError('余额不足', 20001))).toBe('余额不足');
  });

  test('returns generic message for unknown errors', () => {
    expect(resolveErrorMessage(null)).toBe('加载文章数据失败');
  });
});
