import type { AgentId, ToolCallEvent } from '../types';

/**
 * Codex exposes its internal tool lifecycle through App Server events. The
 * generated artifact and final response already communicate successful work,
 * so rendering every started/completed event adds noise to the chat. Keep
 * failed tool calls visible so actionable failures are still surfaced.
 */
export function shouldRenderToolEvent(agentId: AgentId, toolCall: ToolCallEvent): boolean {
  return agentId !== 'codex' || toolCall.status === 'error';
}
