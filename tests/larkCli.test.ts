import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildFeishuCreateDocumentArgs,
  buildFeishuUpdateDocumentArgs,
  buildLarkAuthStatusArgs,
  buildLarkAuthorizationArgs,
  buildLarkCliInstallPlan,
  isValidLarkAuthorizationRecord,
  isValidLarkInstallRecord,
  LarkCliService,
  missingLarkScopes,
  parseLarkCliFailure,
  REQUIRED_LARK_SKILLS,
} from '../src/feishu/larkCli';
import {
  larkCliAuthorizationRecordPath,
  larkCliInstallRecordPath,
  larkCliManagedBinaryPath,
} from '../src/paths';

describe('LarkCliService commands', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('installs lark-cli into the shared WeSight runtime', () => {
    const plan = buildLarkCliInstallPlan({
      WESIGHT_HOME: '/tmp/wesight',
    } as NodeJS.ProcessEnv);
    expect(plan.managedDir).toBe('/tmp/wesight/runtimes/lark-cli');
    expect(plan.args).toEqual([
      'install',
      '--prefix',
      '/tmp/wesight/runtimes/lark-cli',
      '@larksuite/cli@latest',
    ]);
  });

  test('requests every CLI business domain with split-flow authorization', () => {
    expect(buildLarkAuthorizationArgs()).toEqual([
      'auth',
      'login',
      '--domain',
      'all',
      '--no-wait',
      '--json',
    ]);
  });

  test('verifies the stored token when checking authorization state', () => {
    expect(buildLarkAuthStatusArgs()).toEqual([
      'auth',
      'status',
      '--json',
      '--verify',
    ]);
  });

  test('requires the complete official Skills set including Base and Drive', () => {
    expect(REQUIRED_LARK_SKILLS).toContain('lark-base');
    expect(REQUIRED_LARK_SKILLS).toContain('lark-drive');
    expect(REQUIRED_LARK_SKILLS).toContain('lark-im');
    expect(REQUIRED_LARK_SKILLS.length).toBeGreaterThan(20);
  });

  test('compares all app scopes with the user authorization', () => {
    expect(missingLarkScopes(
      ['im:chat:read', 'base:app:read', 'calendar:calendar:read'],
      ['im:chat:read', 'calendar:calendar:read'],
    )).toEqual(['base:app:read']);
  });

  test('accepts only current all-mode authorization records', () => {
    const record = {
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '1.2.3',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    };
    expect(isValidLarkAuthorizationRecord(record)).toBe(true);
    expect(isValidLarkAuthorizationRecord({
      ...record,
      authorizationMode: 'docs',
    })).toBe(false);
    expect(isValidLarkAuthorizationRecord({
      ...record,
      scopeVersion: 2,
    })).toBe(false);
  });

  test('ignores a system CLI until the managed binary and install record are valid', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-lark-test-'));
    tempDirs.push(tempDir);
    const env = {
      WESIGHT_HOME: tempDir,
      PATH: process.env.PATH,
    } as NodeJS.ProcessEnv;
    const binaryPath = larkCliManagedBinaryPath(env);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "lark-cli 9.9.9\\n"\n');
    fs.chmodSync(binaryPath, 0o755);

    const cli = new LarkCliService(env);
    expect(cli.discoverCli()).toMatchObject({
      path: null,
      managedInstallStatus: 'invalid',
    });

    const installRecord = {
      packageName: '@larksuite/cli',
      binaryPath,
      version: '9.9.9',
      installedAt: '2026-07-30T08:00:00.000Z',
    };
    fs.writeFileSync(
      larkCliInstallRecordPath(env),
      JSON.stringify(installRecord),
    );
    expect(isValidLarkInstallRecord(installRecord, binaryPath)).toBe(true);
    expect(cli.discoverCli()).toMatchObject({
      path: binaryPath,
      managedInstallStatus: 'ready',
    });
  });

  test('rejects an install record that points outside the managed runtime', () => {
    expect(isValidLarkInstallRecord({
      packageName: '@larksuite/cli',
      binaryPath: '/tmp/other/lark-cli',
      version: '1.0.0',
      installedAt: '2026-07-30T08:00:00.000Z',
    }, '/tmp/wesight/runtimes/lark-cli/node_modules/.bin/lark-cli')).toBe(false);
  });

  test('requires a local all-mode record before reusing an existing full authorization', async () => {
    const env = createManagedCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [
      'im:chat:read',
      'im:message:readonly',
      'im:message.send_as_user',
      'docx:document:create',
      'docx:document:readonly',
      'docx:document:write_only',
      'docs:document.media:upload',
      'base:app:read',
      'base:record:read',
      'base:table:read',
      'calendar:calendar:read',
      'calendar:calendar.event:read',
      'calendar:calendar.event:create',
      'calendar:calendar.event:update',
      'drive:drive.metadata:readonly',
      'space:folder:create',
    ];
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, grantedScopes));

    const beforeRecord = await cli.getConnectionState();
    expect(beforeRecord).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: true,
      authorizationMode: null,
    });

    fs.writeFileSync(larkCliAuthorizationRecordPath(env), JSON.stringify({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '9.9.9',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    }));
    const afterRecord = await cli.getConnectionState();
    expect(afterRecord).toMatchObject({
      status: 'connected',
      connected: true,
      permissionsComplete: true,
      authorizationMode: 'all',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    });
  });

  test('detects partial authorization when a Base scope is missing', async () => {
    const env = createManagedCliFixture(tempDirs);
    fs.writeFileSync(larkCliAuthorizationRecordPath(env), JSON.stringify({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '9.9.9',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    }));
    const cli = new LarkCliService(env);
    const appScopes = [
      'im:chat:read',
      'base:app:read',
      'base:record:read',
      'base:table:read',
    ];
    const grantedScopes = [
      'im:chat:read',
      'base:app:read',
      'base:table:read',
    ];
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, appScopes));

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
    expect(connection.capabilities.base.granted).toBe(false);
  });

  test('returns to scanning when the verified user token has expired', async () => {
    const env = createManagedCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'config') return commandResult({ appId: 'cli_test' });
      if (args[0] === 'auth' && args[1] === 'status') {
        expect(args).toContain('--verify');
        return commandResult({
          identities: {
            user: {
              status: 'missing',
              available: false,
              tokenStatus: 'expired',
              message: 'refresh token expired',
              scope: '',
            },
          },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
  });

  test('uses user identity, v2 and stdin for document writes', () => {
    expect(buildFeishuCreateDocumentArgs('fldcn123')).toEqual([
      'docs',
      '+create',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--doc-format',
      'markdown',
      '--parent-token',
      'fldcn123',
      '--content',
      '-',
      '--json',
    ]);
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('overwrite');
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('-');
  });

  test('maps permission configuration URLs without adding confirmation flags', () => {
    const error = parseLarkCliFailure(
      1,
      '',
      JSON.stringify({
        error: {
          message: 'missing scope',
          console_url: 'https://open.feishu.cn/app/permission',
          permission_violations: [{ scope: 'docx:document:create' }],
        },
      }),
    );
    expect(error.message).toBe('missing scope');
    expect(error.consoleUrl).toBe('https://open.feishu.cn/app/permission');
    expect(error.permissionViolations).toEqual(['docx:document:create']);
    expect(error.confirmationRequired).toBe(false);
  });

  test('recognizes the CLI high-risk confirmation gate', () => {
    const error = parseLarkCliFailure(
      10,
      '',
      JSON.stringify({
        error: {
          type: 'confirmation_required',
          message: 'action requires confirmation',
        },
      }),
    );
    expect(error.confirmationRequired).toBe(true);
  });
});

interface MockCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

function commandResult(stdout: unknown): MockCommandResult {
  return {
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: '',
    cancelled: false,
    timedOut: false,
  };
}

function buildConnectionRunner(
  grantedScopes: string[],
  appScopes: string[],
): (args: string[]) => Promise<MockCommandResult> {
  return async (args: string[]) => {
    if (args[0] === 'config') {
      return commandResult({ appId: 'cli_test' });
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      expect(args).toContain('--verify');
      return commandResult({
        identity: 'user',
        identities: {
          user: {
            status: 'ready',
            available: true,
            tokenStatus: 'valid',
            userName: 'Test User',
            openId: 'ou_test',
            scope: grantedScopes.join(' '),
          },
        },
      });
    }
    if (args[0] === 'auth' && args[1] === 'scopes') {
      return commandResult({ userScopes: appScopes });
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
}

function createManagedCliFixture(tempDirs: string[]): NodeJS.ProcessEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-lark-state-'));
  tempDirs.push(tempDir);
  const env = {
    WESIGHT_HOME: tempDir,
    PATH: process.env.PATH,
  } as NodeJS.ProcessEnv;
  const binaryPath = larkCliManagedBinaryPath(env);
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "lark-cli 9.9.9\\n"\n');
  fs.chmodSync(binaryPath, 0o755);
  fs.writeFileSync(larkCliInstallRecordPath(env), JSON.stringify({
    packageName: '@larksuite/cli',
    binaryPath,
    version: '9.9.9',
    installedAt: '2026-07-30T08:00:00.000Z',
  }));
  return env;
}
