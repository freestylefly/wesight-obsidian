import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  executableSearchPath,
  mergeEnvironment,
  privateUrlProxyBypassHost,
  withNoProxyHost,
} from '../src/utils/env';

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

  it('adds a private provider host to both no-proxy environment variants', async () => {
    const host = await privateUrlProxyBypassHost(
      'http://api.internal.example/v1',
      async () => ['10.23.4.5'],
    );
    const env = withNoProxyHost({ NO_PROXY: 'localhost' }, host);

    expect(host).toBe('api.internal.example');
    expect(env.NO_PROXY).toBe('localhost,api.internal.example');
    expect(env.no_proxy).toBe('api.internal.example');
  });

  it('does not bypass the proxy for a non-private provider address', async () => {
    expect(await privateUrlProxyBypassHost('https://203.0.113.10/v1')).toBeNull();
  });
});
