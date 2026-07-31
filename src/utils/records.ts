export function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function recordValue(value: unknown, key: string): unknown {
  return recordFromUnknown(value)?.[key];
}
