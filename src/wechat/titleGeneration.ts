import { requestUrl } from 'obsidian';

import { CloudApiError } from '../share/cloudApi';
import { CloudAuthService } from '../share/cloudAuth';

export async function chargeWeChatTitleGeneration(
  auth: CloudAuthService,
  options: { cangheStyle: boolean; idempotencyKey?: string } = { cangheStyle: false },
): Promise<void> {
  const token = await auth.getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  let response: Awaited<ReturnType<typeof requestUrl>>;
  try {
    response = await requestUrl({
      url: 'https://api.wesight.ai/api/wechat/title-generation/charge',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ cangheStyle: options.cangheStyle }),
      headers,
      throw: false,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '网络错误，请重试');
  }

  const json = response.json as {
    code?: number;
    message?: string;
    error?: string;
    data?: unknown;
  } | null;

  if (response.status === 402 && json?.data) {
    throw new CloudApiError(
      json.message || '积分不足，请充值积分或开通创作者会员',
      response.status,
      json.error,
      json.data,
    );
  }

  if (!json || typeof json !== 'object') {
    throw new Error('接口返回格式异常');
  }

  if (response.status >= 400 || json.code !== 0) {
    throw new Error(json.message || '扣费失败');
  }
}
