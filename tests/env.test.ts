import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { executableSearchPath, mergeEnvironment } from '../src/utils/env';

describe('runtime environment', () => {
  it('keeps configured PATH entries first and adds common executable folders', () => {
    const configured = path.join(os.tmpdir(), 'wesight-custom-bin');
    const entries = executableSearchPath(configured).split(path.delimiter);

    expect(entries[0]).toBe(configured);
    if (process.platform === 'win32') {
      expect(entries).toContain(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'));
    } else {
      expect(entries).toContain('/usr/local/bin');
      expect(entries).toContain(path.join(os.homedir(), '.npm-global', 'bin'));
    }
  });

  it('enriches a PATH supplied through shared environment settings', () => {
    const configured = path.join(os.tmpdir(), 'wesight-shared-bin');
    const env = mergeEnvironment({ PATH: '/base/bin' }, `PATH=${configured}\nWESIGHT_TEST=value`);
    const entries = env.PATH?.split(path.delimiter) ?? [];

    expect(entries[0]).toBe(configured);
    expect(env.WESIGHT_TEST).toBe('value');
  });
});
