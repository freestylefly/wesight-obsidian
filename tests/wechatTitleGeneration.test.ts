vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

import { chargeWeChatTitleGeneration } from '../src/wechat/titleGeneration';
import { CloudApiError } from '../src/share/cloudApi';
import type { CloudAuthService } from '../src/share/cloudAuth';

function createAuth(token = 'test-token'): CloudAuthService {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
  } as unknown as CloudAuthService;
}

describe('chargeWeChatTitleGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends POST to title-generation charge endpoint with auth and idempotency key', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 0, data: { charged: true } },
    } as never);

    const auth = createAuth();
    await chargeWeChatTitleGeneration(auth, { cangheStyle: true, idempotencyKey: 'test-key-123' });

    expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(requestUrl).mock.calls[0]?.[0] as {
      url: string;
      method: string;
      contentType: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(call).toMatchObject({
      url: 'https://api.wesight.ai/api/wechat/title-generation/charge',
      method: 'POST',
      contentType: 'application/json',
    });
    expect(call.body).toBe(JSON.stringify({ cangheStyle: true }));
    expect(call.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Idempotency-Key': 'test-key-123',
    });
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
      chargeWeChatTitleGeneration(createAuth(), { cangheStyle: true }),
    ).rejects.toThrow(CloudApiError);
  });

  test('throws generic error on backend failure', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({
      status: 200,
      json: { code: 1, message: '扣费失败' },
    } as never);

    await expect(
      chargeWeChatTitleGeneration(createAuth(), { cangheStyle: true }),
    ).rejects.toThrow('扣费失败');
  });
});
