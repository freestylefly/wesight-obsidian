import type { RuntimeTurnEvent, ToolCallEvent } from '../types';
import { createId } from '../utils/id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentArrayText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (isRecord(item)) {
      const blockType = firstString(item.type);
      if (blockType && blockType !== 'text' && blockType !== 'output_text') continue;
      const text = firstText(item.text, item.content);
      if (text) parts.push(text);
    }
  }
  return parts.length ? parts.join('') : null;
}

export function parseClaudeStreamLine(line: string): RuntimeTurnEvent[] {
  const events: RuntimeTurnEvent[] = [];
  const parsed = parseJson(line);
  if (!parsed) return line.trim() ? [{ type: 'text', content: line }] : [];

  const eventType = firstString(parsed.type, parsed.event);
  if (eventType === 'error') {
    events.push({ type: 'error', message: firstString(parsed.message, parsed.error) ?? stringify(parsed) });
  }
  if (eventType === 'result' && (parsed.is_error === true || firstString(parsed.subtype)?.includes('error'))) {
    events.push({
      type: 'error',
      message: firstString(parsed.result, parsed.error, parsed.message) ?? stringify(parsed),
    });
  }

  const sessionId = firstString(parsed.session_id, parsed.sessionId);
  if (sessionId) {
    events.push({ type: 'session', sessionId });
  }

  const directText = firstText(parsed.text, parsed.delta, parsed.content);
  if (directText && eventType !== 'result') {
    events.push({ type: 'text', content: directText });
  }

  if (
    isRecord(parsed.message)
    && (eventType === 'assistant' || firstString(parsed.message.role) === 'assistant')
  ) {
    const messageText = contentArrayText(parsed.message.content) ?? firstText(parsed.message.text);
    if (messageText) {
      events.push({ type: 'text', content: messageText });
    }
  }

  if (isRecord(parsed.delta)) {
    const deltaText = firstText(parsed.delta.text);
    if (deltaText) events.push({ type: 'text', content: deltaText });
  }

  if (isRecord(parsed.event)) {
    const nestedType = firstString(parsed.event.type);
    const nestedDelta = isRecord(parsed.event.delta) ? parsed.event.delta : null;
    if (nestedType === 'content_block_delta' && nestedDelta) {
      const deltaText = firstText(nestedDelta.text, nestedDelta.content);
      if (deltaText) events.push({ type: 'text', content: deltaText });
    }
  }

  return events;
}

export function parseCodexStreamLine(line: string): RuntimeTurnEvent[] {
  const parsed = parseJson(line);
  if (!parsed) return line.trim() ? [{ type: 'text', content: line }] : [];
  const msg = isRecord(parsed.msg) ? parsed.msg : null;
  const type = firstString(parsed.type, parsed.event, msg?.type);
  if (type === 'thread.started') {
    const sessionId = firstString(parsed.thread_id, parsed.threadId, parsed.id);
    return sessionId ? [{ type: 'session', sessionId }] : [];
  }
  if (type === 'item.agent_message.delta') {
    const text = firstText(parsed.delta, parsed.text, parsed.message);
    return text ? [{ type: 'text', content: text }] : [];
  }
  if (type === 'turn.failed' || type === 'error') {
    return [{ type: 'error', message: firstString(parsed.message, parsed.error) ?? stringify(parsed) }];
  }
  if (type === 'response_item' && isRecord(parsed.item)) {
    const itemType = firstString(parsed.item.type);
    if (itemType === 'agent_message') {
      const text = firstText(parsed.item.text, parsed.item.content) ?? contentArrayText(parsed.item.content);
      return text ? [{ type: 'text', content: text }] : [];
    }
    if (itemType === 'command_execution' || itemType === 'tool_call') {
      return [{ type: 'tool', toolCall: toolFromRecord(parsed.item) }];
    }
  }
  if (type === 'event_msg') {
    const text = firstText(parsed.message, parsed.msg, parsed.text);
    return text ? [{ type: 'text', content: text }] : [];
  }
  return [];
}

export function parseOpenCodeStreamLine(line: string): RuntimeTurnEvent[] {
  const parsed = parseJson(line);
  if (!parsed) return line.trim() ? [{ type: 'text', content: line }] : [];
  const type = firstString(parsed.type, parsed.event);
  if (type === 'error') {
    return [{ type: 'error', message: firstString(parsed.message, parsed.error) ?? stringify(parsed) }];
  }
  if (type?.includes('tool')) {
    return [{ type: 'tool', toolCall: toolFromRecord(parsed) }];
  }
  const sessionId = firstString(parsed.sessionID, parsed.sessionId, parsed.session_id);
  const events: RuntimeTurnEvent[] = sessionId ? [{ type: 'session', sessionId }] : [];
  const part = isRecord(parsed.part) ? parsed.part : null;
  const text = firstText(
    parsed.text,
    parsed.content,
    parsed.message,
    parsed.delta,
    part?.text,
    part?.content,
  );
  if (text) events.push({ type: 'text', content: text });
  return events;
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolFromRecord(record: Record<string, unknown>): ToolCallEvent {
  return {
    id: firstString(record.id, record.call_id, record.toolCallId) ?? createId('tool'),
    name: firstString(record.name, record.command, record.tool_name, record.type) ?? 'tool',
    status: firstString(record.status) === 'error' ? 'error' : 'completed',
    input: record.input ?? record.arguments,
    output: record.output ?? record.result,
    error: firstString(record.error) ?? undefined,
  };
}
