import os from 'os';
import path from 'path';

import {
  larkCliAuthorizationRecordPath,
  larkCliManagedBinaryPath,
  larkCliManagedDir,
  providersPath,
  runtimeManagedDir,
  wesightHome,
} from '../src/paths';

describe('paths', () => {
  test('uses WESIGHT_HOME when configured', () => {
    const env = { WESIGHT_HOME: '/tmp/wesight-test' } as NodeJS.ProcessEnv;
    expect(wesightHome(env)).toBe('/tmp/wesight-test');
    expect(runtimeManagedDir('codex', env)).toBe('/tmp/wesight-test/runtimes/codex');
    expect(larkCliManagedDir(env)).toBe('/tmp/wesight-test/runtimes/lark-cli');
    expect(larkCliManagedBinaryPath(env)).toContain('/tmp/wesight-test/runtimes/lark-cli/');
    expect(larkCliAuthorizationRecordPath(env))
      .toBe('/tmp/wesight-test/runtimes/lark-cli/authorization.json');
    expect(providersPath(env)).toBe('/tmp/wesight-test/providers.json');
  });

  test('defaults to ~/.wesight', () => {
    expect(wesightHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.wesight'));
  });
});
