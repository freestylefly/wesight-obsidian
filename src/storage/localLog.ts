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
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...detail,
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
