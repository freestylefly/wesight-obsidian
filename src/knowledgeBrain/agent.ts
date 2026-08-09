import type { AgentId, ChatTurnRequest, RuntimeTurnEvent } from '../types';
import type { RuntimeManager } from '../runtime/runtimeManager';
import { MAX_DRAFT_OUTPUT_BYTES } from './transactionBuilder';
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from 'timers';

export interface PlanningResult {
  text: string;
  sessionId: string | null;
}

const PLANNING_TIMEOUT_MS = 180_000;

export async function runPlanningTurn(
  runtimeManager: RuntimeManager,
  agentId: AgentId,
  systemPrompt: string,
  prompt: string,
  cwd: string,
  signal: AbortSignal | null,
): Promise<PlanningResult> {
  const chunks: string[] = [];
  let bytes = 0;
  let sessionId: string | null = null;
  let failure: Error | null = null;
  let timedOut = false;
  const turnAbort = new AbortController();
  const forwardAbort = (): void => turnAbort.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) turnAbort.abort();
  const timeout = scheduleTimeout(() => {
    timedOut = true;
    turnAbort.abort();
  }, PLANNING_TIMEOUT_MS);
  const request: ChatTurnRequest = {
    conversationId: `kb-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    prompt,
    cwd,
    configSource: 'localCli',
    systemPrompt,
    textOnly: true,
    accessMode: 'read-only',
    logPolicy: 'metadata-only',
    signal: turnAbort.signal,
  };
  try {
    await runtimeManager.runTurn(request, event => {
      if (event.type === 'text' && !failure) {
        bytes += Buffer.byteLength(event.content, 'utf8');
        if (bytes > MAX_DRAFT_OUTPUT_BYTES) {
          failure = new Error('Agent 草稿超过 2 MiB 输出限制。');
          turnAbort.abort();
        } else {
          chunks.push(event.content);
        }
      } else if (event.type === 'session') {
        sessionId = event.sessionId;
      } else if (event.type === 'error') {
        failure = new Error(event.message);
      }
    });
  } finally {
    cancelTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
  if (timedOut) throw new Error('Agent 规划超过 3 分钟，操作已取消。');
  assertNoPlanningFailure(failure);
  return { text: chunks.join(''), sessionId };
}

function assertNoPlanningFailure(failure: Error | null): void {
  if (failure) throw new Error(failure.message);
}

export async function runQueryTurn(
  runtimeManager: RuntimeManager,
  input: {
    agentId: AgentId;
    conversationId: string;
    systemPrompt: string;
    prompt: string;
    cwd: string;
    sessionId?: string;
    signal: AbortSignal | null;
  },
  onEvent: (event: RuntimeTurnEvent) => void,
): Promise<void> {
  const request: ChatTurnRequest = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    prompt: input.prompt,
    cwd: input.cwd,
    configSource: 'localCli',
    systemPrompt: input.systemPrompt,
    sessionId: input.sessionId,
    accessMode: 'read-only',
    logPolicy: 'metadata-only',
    signal: input.signal ?? undefined,
  };
  await runtimeManager.runTurn(request, onEvent);
}
