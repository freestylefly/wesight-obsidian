import fs from 'fs';
import path from 'path';

import { logsDir } from '../paths';
import { ensureDir } from '../utils/fs';

export function appendLocalLog(event: string, detail: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = logsDir(env);
    ensureDir(dir);
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `${date}.log`);
    const sanitizedDetail = sanitizeLogValue(detail) as Record<string, unknown>;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...sanitizedDetail,
    });
    fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod is best-effort on some filesystems.
    }
  } catch {
    // Local logging should never interrupt agent work.
  }
}

function sanitizeLogValue(value: unknown, key = ''): unknown {
  if (key === 'anthropicAuthMode') {
    return value;
  }
  if (/api.?key|auth(?:orization)?|secret|token/i.test(key)) {
    return value ? '<redacted>' : value;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>');
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeLogValue(entryValue, entryKey)]),
    );
  }
  return value;
}
