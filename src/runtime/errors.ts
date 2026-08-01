import type { RuntimeTurnEvent } from '../types';

type RuntimeErrorEvent = Extract<RuntimeTurnEvent, { type: 'error' }>;

const CONNECTOR_WARNING = /^.*claude\.ai connectors are disabled.*(?:\r?\n|$)/gim;

export function extractClaudeConnectorWarning(value: string): string | undefined {
  return value.match(CONNECTOR_WARNING)?.map(line => line.trim()).filter(Boolean).join('\n') || undefined;
}

export function stripClaudeConnectorWarning(value: string): string {
  return value.replace(CONNECTOR_WARNING, '').trim();
}

export function classifyClaudeProviderError(
  value: string,
  context: { providerName?: string; providerProfileId?: string } = {},
): RuntimeErrorEvent | null {
  const cleaned = stripClaudeConnectorWarning(value);
  if (!cleaned) return null;

  const statusMatch = cleaned.match(/\((\d{3})\)|(?:status|状态码)[^\d]{0,12}(\d{3})/i);
  const statusCode = Number(statusMatch?.[1] ?? statusMatch?.[2]) || undefined;
  const invalidCredential = /无效(?:令牌|密钥)|invalid (?:api key|token|credential)|authentication (?:failed|error)|unauthori[sz]ed/i.test(cleaned);
  const retryMatch = cleaned.match(/(?:等待|wait(?: for)?|retry(?:-| )after)\s*(\d+)\s*(?:秒|seconds?|s\b)/i);
  const retryAfterSeconds = Number(retryMatch?.[1]) || undefined;
  const requestId = cleaned.match(/request\s*id\s*[:：]\s*([A-Za-z0-9_-]+)/i)?.[1];
  const terminal = invalidCredential || statusCode === 401 || statusCode === 403 || statusCode === 429;
  if (!terminal) return null;

  const providerName = context.providerName?.trim() || '模型服务商';
  let message: string;
  if (invalidCredential) {
    message = `${providerName} API 密钥无效，请在 WeSight 设置中重新输入。`;
    if (retryAfterSeconds) {
      message += ` ${retryAfterSeconds} 秒后可重试。`;
    }
  } else if (statusCode === 429) {
    message = retryAfterSeconds
      ? `${providerName} 请求受限，请等待 ${retryAfterSeconds} 秒后再试。`
      : `${providerName} 请求受限，请稍后再试。`;
  } else {
    message = `${providerName} 鉴权失败，请检查 API 密钥和鉴权方式。`;
  }
  if (requestId) {
    message += ` 请求 ID：${requestId}。`;
  }

  const connectorDiagnostic = extractClaudeConnectorWarning(value);

  return {
    type: 'error',
    message,
    statusCode,
    retryAfterSeconds,
    requestId,
    providerProfileId: context.providerProfileId,
    diagnostic: [connectorDiagnostic, cleaned].filter(Boolean).join('\n'),
  };
}
