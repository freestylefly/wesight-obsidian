import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendLocalLog } from '../src/storage/localLog';

describe('local logging', () => {
  test('keeps the authentication mode while redacting credentials', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-log-'));
    try {
      appendLocalLog('runtime_turn_start', {
        providerHost: 'api.moonshot.cn',
        model: 'kimi-k3',
        anthropicAuthMode: 'authToken',
        apiKey: 'sk-secret-value',
        authorization: 'Bearer secret-value',
      }, { WESIGHT_HOME: tempDir });

      const [file] = fs.readdirSync(path.join(tempDir, 'logs'));
      const record = JSON.parse(fs.readFileSync(path.join(tempDir, 'logs', file), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({
        providerHost: 'api.moonshot.cn',
        model: 'kimi-k3',
        anthropicAuthMode: 'authToken',
        apiKey: '<redacted>',
        authorization: '<redacted>',
      });
      expect(JSON.stringify(record)).not.toContain('secret-value');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
