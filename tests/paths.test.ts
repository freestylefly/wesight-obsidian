import os from 'os';
import path from 'path';

import {
  larkCliAuthorizationRecordPath,
  providersPath,
  runtimeManagedDir,
  wechatThemeCacheDir,
  wesightHome,
} from '../src/paths';

describe('paths', () => {
  test('uses WESIGHT_HOME when configured', () => {
    const env = { WESIGHT_HOME: '/tmp/wesight-test' } as NodeJS.ProcessEnv;
    expect(wesightHome(env)).toBe('/tmp/wesight-test');
    expect(runtimeManagedDir('codex', env)).toBe('/tmp/wesight-test/runtimes/codex');
    expect(larkCliAuthorizationRecordPath(env))
      .toBe('/tmp/wesight-test/lark/authorization.json');
    expect(providersPath(env)).toBe('/tmp/wesight-test/providers.json');
    expect(wechatThemeCacheDir(env)).toBe('/tmp/wesight-test/cache/wechat-themes');
  });

  test('defaults to ~/.wesight', () => {
    expect(wesightHome({})).toBe(path.join(os.homedir(), '.wesight'));
  });
});
