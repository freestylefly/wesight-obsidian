import { requestUrl } from 'obsidian';

export const DAJIALA_READ_ZAN_PRO_URL = 'https://www.dajiala.com/fbmain/monitor/v3/read_zan_pro';

export interface ArticleStatsResult {
  code: number;
  message: string;
  data: Record<string, unknown> | null;
}

const ARTICLE_STATS_KEY_MISSING_MESSAGE = '尚未配置公众号数据监控 key，请在 WeSight 设置的微信公众号区域填写。';
export { ARTICLE_STATS_KEY_MISSING_MESSAGE };
export class ArticleStatsError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

const ERROR_MESSAGES: Record<number | string, string> = {
  '-1': 'QPS超过上限，不得高于5次/秒，请5秒后再试',
  '104': '短链接文章已被删除或文章被迁移',
  '106': '获取阅读点赞数频率过快，请暂停2秒后重试',
  '400': '短链接转化失败，建议先调用短链接转长链接转化为长链接后继续调用',
  '10002': 'key或附加码不正确',
  '20001': '金额不足，请充值',
  '20002': '请输入正确的微信链接',
  '20003': '文章链接有误，请检查文章链接url中的&是否已经编码为%26',
  '50000': '内部服务器错误',
};

function encodeFormBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export async function fetchWeChatArticleStats(
  url: string,
  key: string,
  verifyCode?: string,
): Promise<ArticleStatsResult> {
  if (!key.trim()) {
    throw new ArticleStatsError(ARTICLE_STATS_KEY_MISSING_MESSAGE, -2);
  }

  const bodyParams: Record<string, string> = {
    url,
    key: key.trim(),
  };
  if (verifyCode?.trim()) {
    bodyParams.verifycode = verifyCode.trim();
  }

  let response: Awaited<ReturnType<typeof requestUrl>>;
  try {
    response = await requestUrl({
      url: DAJIALA_READ_ZAN_PRO_URL,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: encodeFormBody(bodyParams),
    });
  } catch (error) {
    throw new ArticleStatsError(error instanceof Error ? error.message : '网络错误，请重试1~3次', -3);
  }

  const json = response.json as { code?: number; msg?: string; data?: unknown; message?: string } | null;
  if (!json || typeof json !== 'object') {
    throw new ArticleStatsError('接口返回格式异常', -3);
  }

  if (json.message === 'Internal Server Error') {
    throw new ArticleStatsError('网络错误，请重试1~3次', -3);
  }

  const code = typeof json.code === 'number' ? json.code : -3;
  const message = json.msg ?? ERROR_MESSAGES[code] ?? ERROR_MESSAGES[String(code)] ?? '接口返回异常';

  if (code !== 0) {
    throw new ArticleStatsError(message, code);
  }

  return {
    code,
    message,
    data: (json.data ?? null) as Record<string, unknown> | null,
  };
}

export function resolveErrorMessage(error: unknown): string {
  if (error instanceof ArticleStatsError) {
    return error.message;
  }
  return error instanceof Error ? error.message : '加载文章数据失败';
}
