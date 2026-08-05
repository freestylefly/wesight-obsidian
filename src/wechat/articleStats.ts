import { requestUrl } from 'obsidian';

import { CloudApiError } from '../share/cloudApi';
import { CloudAuthService } from '../share/cloudAuth';

export interface ArticleStatsResult {
  code: number;
  message: string;
  data: Record<string, unknown> | null;
}

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

export async function fetchWeChatArticleStats(
  url: string,
  auth: CloudAuthService,
): Promise<ArticleStatsResult> {
  const token = await auth.getAccessToken();
  let response: Awaited<ReturnType<typeof requestUrl>>;
  try {
    response = await requestUrl({
      url: 'https://api.wesight.ai/api/wechat/article-stats',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ url }),
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new ArticleStatsError(error instanceof Error ? error.message : '网络错误，请重试1~3次', -3);
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
    throw new ArticleStatsError('接口返回格式异常', -3);
  }

  if (response.status >= 400 || json.code !== 0) {
    const message = json.message ?? ERROR_MESSAGES[json.code ?? -3] ?? '接口返回异常';
    throw new ArticleStatsError(message, json.code ?? -3);
  }

  return {
    code: json.code ?? 0,
    message: json.message ?? '成功',
    data: normalizeArticleStatsData(json.data),
  };
}

function normalizeArticleStatsData(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object') return null;
  // 解包 dajiala 可能嵌套的 { code, message, data } 信封
  for (let depth = 0; depth < 3; depth += 1) {
    const envelope = data as Record<string, unknown>;
    if (typeof envelope.code === 'number' && 'data' in envelope) {
      data = envelope.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return null;
        }
      }
    } else {
      break;
    }
  }
  return data as Record<string, unknown> | null;
}

export function resolveErrorMessage(error: unknown): string {
  if (error instanceof ArticleStatsError) {
    return error.message;
  }
  if (error instanceof CloudApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : '加载文章数据失败';
}
