import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';

import {
  larkCliAuthorizationRecordPath,
  larkCliInstallRecordPath,
  larkCliManagedBinaryPath,
  larkCliManagedDir,
} from '../paths';
import { resolveCommand, readCommandVersion } from '../utils/command';
import {
  ensureDir,
  executableFileExists,
  fileExists,
  readJsonFile,
  writeJsonFile,
} from '../utils/fs';
import type {
  FeishuAssetDraft,
  FeishuAuthProgress,
  FeishuAuthorizationMode,
  FeishuCapabilityId,
  FeishuCapabilityState,
  FeishuConnectionState,
  FeishuDocumentResult,
  FeishuFolderResult,
  FeishuManagedInstallStatus,
  LarkAuthorizationRecord,
} from './types';

const LARK_CLI_PACKAGE = '@larksuite/cli';
const LARK_AUTHORIZATION_MODE: FeishuAuthorizationMode = 'all';
const LARK_SCOPE_VERSION = 1;
const DEFAULT_FOLDER_NAME = 'WeSight 分享';
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 3 * 60_000;
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;
export const REQUIRED_LARK_SKILLS = [
  'lark-approval',
  'lark-apps',
  'lark-attendance',
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-markdown',
  'lark-minutes',
  'lark-note',
  'lark-okr',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-slides',
  'lark-task',
  'lark-vc',
  'lark-vc-agent',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
] as const;

const CAPABILITY_META: Record<FeishuCapabilityId, Omit<FeishuCapabilityState, 'granted' | 'verified'>> = {
  im: {
    id: 'im',
    label: '消息',
    description: '读取与发送消息',
  },
  docs: {
    id: 'docs',
    label: '文档',
    description: '创建、更新文档并上传图片',
  },
  base: {
    id: 'base',
    label: '多维表格',
    description: '读取与管理多维表格',
  },
  calendar: {
    id: 'calendar',
    label: '日历',
    description: '查看与管理日程',
  },
  drive: {
    id: 'drive',
    label: '云盘',
    description: '查找文件并管理保存位置',
  },
};

const REQUIRED_SCOPES: Record<FeishuCapabilityId, string[]> = {
  im: [
    'im:chat:read',
    'im:message:readonly',
    'im:message.send_as_user',
  ],
  docs: [
    'docx:document:create',
    'docx:document:readonly',
    'docx:document:write_only',
    'docs:document.media:upload',
  ],
  base: [
    'base:app:read',
    'base:record:read',
    'base:table:read',
  ],
  calendar: [
    'calendar:calendar:read',
    'calendar:calendar.event:read',
    'calendar:calendar.event:create',
    'calendar:calendar.event:update',
  ],
  drive: [
    'drive:drive.metadata:readonly',
    'space:folder:create',
  ],
};

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

interface LarkAuthStatus {
  appId?: string;
  brand?: string;
  identity?: string;
  identities?: {
    user?: {
      status?: string;
      available?: boolean;
      message?: string;
      openId?: string;
      userName?: string;
      tokenStatus?: string;
      scope?: string | string[];
    };
  };
}

export interface LarkInstallRecord {
  packageName: string;
  binaryPath: string;
  version: string | null;
  installedAt: string;
}

interface ManagedCliDiscovery {
  path: string | null;
  version: string | null;
  managedInstallStatus: FeishuManagedInstallStatus;
}

export interface LarkCliInstallPlan {
  packageName: string;
  managedDir: string;
  args: string[];
}

export class LarkCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly consoleUrl: string | null = null,
    readonly permissionViolations: string[] = [],
    readonly confirmationRequired = false,
  ) {
    super(message);
  }
}

function createCapability(
  id: FeishuCapabilityId,
  granted: boolean,
  verified = false,
  error?: string,
): FeishuCapabilityState {
  return {
    ...CAPABILITY_META[id],
    granted,
    verified,
    ...(error ? { error } : {}),
  };
}

function emptyCapabilities(): Record<FeishuCapabilityId, FeishuCapabilityState> {
  return {
    im: createCapability('im', false),
    docs: createCapability('docs', false),
    base: createCapability('base', false),
    calendar: createCapability('calendar', false),
    drive: createCapability('drive', false),
  };
}

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const objectEnd = trimmed.lastIndexOf('}');
  const arrayEnd = trimmed.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  if (end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function walkValues(value: unknown, key: string, output: unknown[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, key, output);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    walkValues(entryValue, key, output);
  }
}

function findString(value: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    const match = values.find(item => typeof item === 'string' && item.trim());
    if (typeof match === 'string') return match.trim();
  }
  return null;
}

function findNumber(value: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    for (const item of values) {
      const parsed = typeof item === 'number' ? item : Number(item);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function findArray(value: unknown, keys: string[]): unknown[] {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    const match = values.find(Array.isArray);
    if (Array.isArray(match)) return match;
  }
  return [];
}

function parseCliError(result: CommandResult): LarkCliError {
  const payload = extractJson(result.stderr) ?? extractJson(result.stdout);
  const message = findString(payload, ['message', 'hint'])
    ?? (result.timedOut ? '飞书 CLI 操作超时，请重试。' : '飞书 CLI 操作失败，请重试。');
  const consoleUrl = findString(payload, ['console_url', 'consoleUrl']);
  const violations = findArray(payload, ['permission_violations', 'permissionViolations'])
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      const scope = findString(item, ['scope', 'name']);
      return scope ? [scope] : [];
    });
  const errorType = findString(payload, ['subtype', 'type']);
  return new LarkCliError(
    message,
    result.code,
    consoleUrl,
    violations,
    result.code === 10 && errorType === 'confirmation_required',
  );
}

export function parseLarkCliFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut = false,
): LarkCliError {
  return parseCliError({
    code: exitCode,
    stdout,
    stderr,
    cancelled: false,
    timedOut,
  });
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((scope): scope is string => typeof scope === 'string')
      .flatMap(scope => scope.split(/\s+/))
      .map(scope => scope.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);
}

function scopesForStatus(status: LarkAuthStatus): Set<string> {
  return new Set(normalizeScopes(status.identities?.user?.scope));
}

function scopesForApp(payload: unknown): Set<string> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Set();
  const record = payload as Record<string, unknown>;
  return new Set(normalizeScopes(record.userScopes ?? record.user_scopes));
}

function requestedScopesFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  return normalizeScopes(
    record.requestedScopes
    ?? record.requested_scopes
    ?? record.scopes
    ?? record.scope,
  );
}

export function missingLarkScopes(
  expectedScopes: Iterable<string>,
  grantedScopes: Iterable<string>,
): string[] {
  const granted = new Set(grantedScopes);
  return Array.from(new Set(expectedScopes)).filter(scope => !granted.has(scope));
}

export function isValidLarkInstallRecord(
  value: unknown,
  expectedBinaryPath: string,
): value is LarkInstallRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LarkInstallRecord>;
  const installedAt = typeof record.installedAt === 'string'
    ? Date.parse(record.installedAt)
    : Number.NaN;
  return record.packageName === LARK_CLI_PACKAGE
    && typeof record.binaryPath === 'string'
    && path.resolve(record.binaryPath) === path.resolve(expectedBinaryPath)
    && (typeof record.version === 'string' || record.version === null)
    && Number.isFinite(installedAt);
}

export function isValidLarkAuthorizationRecord(
  value: unknown,
): value is LarkAuthorizationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LarkAuthorizationRecord>;
  const authorizedAt = typeof record.authorizedAt === 'string'
    ? Date.parse(record.authorizedAt)
    : Number.NaN;
  return record.authorizationMode === LARK_AUTHORIZATION_MODE
    && record.scopeVersion === LARK_SCOPE_VERSION
    && (typeof record.cliVersion === 'string' || record.cliVersion === null)
    && Number.isFinite(authorizedAt);
}

function ensureSafeVaultPath(vaultPath: string): string {
  const normalized = path.normalize(vaultPath);
  if (
    path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`图片路径超出当前 Vault：${vaultPath}`);
  }
  return normalized;
}

export function buildLarkCliInstallPlan(
  env: NodeJS.ProcessEnv = process.env,
): LarkCliInstallPlan {
  const managedDir = larkCliManagedDir(env);
  return {
    packageName: LARK_CLI_PACKAGE,
    managedDir,
    args: ['install', '--prefix', managedDir, `${LARK_CLI_PACKAGE}@latest`],
  };
}

export function buildLarkAuthorizationArgs(): string[] {
  return [
    'auth',
    'login',
    '--domain',
    LARK_AUTHORIZATION_MODE,
    '--no-wait',
    '--json',
  ];
}

export function buildLarkAuthStatusArgs(): string[] {
  return ['auth', 'status', '--json', '--verify'];
}

export function buildFeishuCreateDocumentArgs(parentToken: string): string[] {
  return [
    'docs',
    '+create',
    '--api-version',
    'v2',
    '--as',
    'user',
    '--doc-format',
    'markdown',
    '--parent-token',
    parentToken,
    '--content',
    '-',
    '--json',
  ];
}

export function buildFeishuUpdateDocumentArgs(documentId: string): string[] {
  return [
    'docs',
    '+update',
    '--api-version',
    'v2',
    '--as',
    'user',
    '--doc',
    documentId,
    '--command',
    'overwrite',
    '--doc-format',
    'markdown',
    '--content',
    '-',
    '--json',
  ];
}

export class LarkCliService extends EventEmitter {
  private static readonly installPromises = new Map<
    string,
    Promise<{ path: string; version: string | null }>
  >();

  private activeChild: ChildProcess | null = null;
  private cancelled = false;
  private pendingDeviceCode: string | null = null;
  private pendingVerificationUrl: string | null = null;
  private pendingRequestedScopes: string[] = [];
  private pendingExpiresAt: number | null = null;
  private resolvedCliPath: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    super();
  }

  onProgress(listener: (progress: FeishuAuthProgress) => void): () => void {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }

  isManagedInstallSupported(): boolean {
    return process.platform === 'darwin';
  }

  discoverCli(): ManagedCliDiscovery {
    const managed = larkCliManagedBinaryPath(this.env);
    const recordPath = larkCliInstallRecordPath(this.env);
    const record = readJsonFile<unknown>(recordPath, null);
    const hasBinary = fileExists(managed);
    const hasRecord = fileExists(recordPath);
    const valid = executableFileExists(managed)
      && isValidLarkInstallRecord(record, managed);
    const cliPath = valid ? managed : null;
    this.resolvedCliPath = cliPath;
    return {
      path: cliPath,
      version: cliPath ? readCommandVersion(cliPath, this.buildSearchEnv()) : null,
      managedInstallStatus: valid
        ? 'ready'
        : hasBinary || hasRecord
          ? 'invalid'
          : 'missing',
    };
  }

  async install(): Promise<{ path: string; version: string | null }> {
    const managedDir = larkCliManagedDir(this.env);
    const running = LarkCliService.installPromises.get(managedDir);
    if (running) return running;
    const installPromise = this.performInstall();
    LarkCliService.installPromises.set(managedDir, installPromise);
    try {
      return await installPromise;
    } finally {
      if (LarkCliService.installPromises.get(managedDir) === installPromise) {
        LarkCliService.installPromises.delete(managedDir);
      }
    }
  }

  private async performInstall(): Promise<{ path: string; version: string | null }> {
    if (!this.isManagedInstallSupported()) {
      throw new LarkCliError(
        '当前版本仅支持在 macOS 自动安装飞书 CLI，请先按安装指引完成安装。',
        null,
      );
    }
    this.cancelled = false;
    const plan = buildLarkCliInstallPlan(this.env);
    ensureDir(plan.managedDir);
    const npmPath = resolveCommand('npm', this.buildSearchEnv()) ?? 'npm';
    this.emitProgress({ phase: 'installing', message: '正在安装飞书 CLI…' });
    const installResult = await this.run(plan.args, {
      command: npmPath,
      cwd: plan.managedDir,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    this.assertSuccess(installResult);

    const binaryPath = larkCliManagedBinaryPath(this.env);
    if (!executableFileExists(binaryPath)) {
      throw new LarkCliError('飞书 CLI 安装完成，但未找到可执行文件。', null);
    }
    const version = readCommandVersion(binaryPath, this.buildSearchEnv());
    this.resolvedCliPath = binaryPath;
    writeJsonFile(larkCliInstallRecordPath(this.env), {
      packageName: LARK_CLI_PACKAGE,
      binaryPath,
      version,
      installedAt: new Date().toISOString(),
    } satisfies LarkInstallRecord, 0o644);

    await this.installAgentSkills();
    return { path: binaryPath, version };
  }

  async ensureConfigured(
    onVerificationUrl?: (url: string) => void,
  ): Promise<void> {
    const cliPath = this.requireCli();
    if (await this.hasConfiguration()) return;
    this.emitProgress({
      phase: 'configuring',
      message: '正在配置飞书应用…',
      detail: '请在浏览器中完成飞书应用配置。',
    });
    const seenUrls = new Set<string>();
    const result = await this.run(
      ['config', 'init', '--new', '--lang', 'zh'],
      {
        command: cliPath,
        timeoutMs: AUTH_TIMEOUT_MS,
        onOutput: (chunk) => {
          for (const match of chunk.matchAll(/https:\/\/[^\s"'<>]+/g)) {
            const url = match[0];
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            onVerificationUrl?.(url);
            this.emitProgress({
              phase: 'configuring',
              message: '请在浏览器中完成飞书应用配置',
              verificationUrl: url,
            });
          }
        },
      },
    );
    this.assertSuccess(result);
  }

  async startAuthorization(): Promise<FeishuAuthProgress> {
    const cliPath = this.requireCli();
    this.pendingDeviceCode = null;
    this.pendingVerificationUrl = null;
    this.pendingRequestedScopes = [];
    this.pendingExpiresAt = null;
    this.emitProgress({ phase: 'waiting-auth', message: '正在申请全部飞书权限…' });
    const result = await this.run(buildLarkAuthorizationArgs(), { command: cliPath });
    this.assertSuccess(result);
    const payload = extractJson(result.stdout);
    const deviceCode = findString(payload, ['device_code', 'deviceCode']);
    const verificationUrl = findString(payload, [
      'verification_url',
      'verification_uri_complete',
      'verificationUrl',
    ]);
    if (!deviceCode || !verificationUrl) {
      throw new LarkCliError('飞书 CLI 未返回有效授权地址，请重试。', result.code);
    }
    this.pendingDeviceCode = deviceCode;
    this.pendingVerificationUrl = verificationUrl;
    this.pendingRequestedScopes = requestedScopesFromPayload(payload);
    const expiresIn = findNumber(payload, ['expires_in', 'expiresIn']) ?? 600;
    this.pendingExpiresAt = Date.now() + expiresIn * 1000;
    const expiresAt = new Date(this.pendingExpiresAt).toISOString();
    const qrCodeDataUrl = await QRCode.toDataURL(verificationUrl, {
      width: 256,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    const progress: FeishuAuthProgress = {
      phase: 'waiting-auth',
      message: '等待你在手机飞书 App 内完成授权……',
      verificationUrl,
      qrCodeDataUrl,
      expiresAt,
    };
    this.emitProgress(progress);
    return progress;
  }

  async completeAuthorization(): Promise<FeishuConnectionState> {
    const cliPath = this.requireCli();
    const deviceCode = this.pendingDeviceCode;
    if (!deviceCode) throw new LarkCliError('当前授权请求已失效，请重新发起授权。', null);
    try {
      const result = await this.run(
        ['auth', 'login', '--device-code', deviceCode],
        { command: cliPath, timeoutMs: AUTH_TIMEOUT_MS },
      );
      if (
        result.code !== 0
        && this.pendingExpiresAt
        && Date.now() >= this.pendingExpiresAt
      ) {
        throw new LarkCliError('当前授权二维码已过期，请刷新二维码。', result.code);
      }
      this.assertSuccess(result);
      this.emitProgress({ phase: 'verifying', message: '正在验证全部飞书权限…' });
      const connection = await this.inspectConnectionState(true, false);
      if (!connection.connected) {
        throw new LarkCliError(connection.message || '飞书授权尚未完成。', null, connection.consoleUrl);
      }
      const grantedScopes = await this.readGrantedScopes(cliPath);
      const missingRequested = missingLarkScopes(this.pendingRequestedScopes, grantedScopes);
      if (missingRequested.length) {
        throw new LarkCliError('仍有飞书权限未授权，请重新扫码并勾选全部权限。', null);
      }
      const authorizationRecord: LarkAuthorizationRecord = {
        authorizationMode: LARK_AUTHORIZATION_MODE,
        scopeVersion: LARK_SCOPE_VERSION,
        cliVersion: connection.cliVersion,
        authorizedAt: new Date().toISOString(),
      };
      writeJsonFile(
        larkCliAuthorizationRecordPath(this.env),
        authorizationRecord,
        0o600,
      );
      this.emitProgress({ phase: 'success', message: '飞书已连接，全部权限已授权。' });
      return {
        ...connection,
        authorizationMode: authorizationRecord.authorizationMode,
        permissionsComplete: true,
        authorizedAt: authorizationRecord.authorizedAt,
      };
    } finally {
      this.pendingDeviceCode = null;
      this.pendingVerificationUrl = null;
      this.pendingRequestedScopes = [];
      this.pendingExpiresAt = null;
    }
  }

  async getConnectionState(verifyCapabilities = false): Promise<FeishuConnectionState> {
    return this.inspectConnectionState(verifyCapabilities, true);
  }

  private async inspectConnectionState(
    verifyCapabilities: boolean,
    requireAuthorizationRecord: boolean,
  ): Promise<FeishuConnectionState> {
    const discovered = this.discoverCli();
    if (!discovered.path) {
      return {
        status: this.isManagedInstallSupported() ? 'missing-cli' : 'unsupported-install',
        cliPath: null,
        cliVersion: null,
        managedInstallStatus: discovered.managedInstallStatus,
        configured: false,
        connected: false,
        authorizationMode: null,
        permissionsComplete: false,
        authorizedAt: null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: null,
        message: discovered.managedInstallStatus === 'invalid'
          ? 'WeSight 管理的飞书 CLI 缺失或损坏，需要重新安装。'
          : '尚未安装 WeSight 管理的飞书 CLI。',
      };
    }

    const authorizationRecord = this.readAuthorizationRecord();
    const configured = await this.hasConfiguration();
    if (!configured) {
      return {
        status: 'needs-config',
        cliPath: discovered.path,
        cliVersion: discovered.version,
        managedInstallStatus: discovered.managedInstallStatus,
        configured: false,
        connected: false,
        authorizationMode: authorizationRecord?.authorizationMode ?? null,
        permissionsComplete: false,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: null,
        message: '飞书 CLI 尚未完成应用配置',
      };
    }

    try {
      const statusResult = await this.run(
        buildLarkAuthStatusArgs(),
        { command: discovered.path },
      );
      this.assertSuccess(statusResult);
      const status = (extractJson(statusResult.stdout) ?? {}) as LarkAuthStatus;
      const user = status.identities?.user;
      const grantedScopes = scopesForStatus(status);
      const capabilities = this.capabilitiesForScopes(grantedScopes);
      const tokenStatus = user?.tokenStatus?.toLowerCase() ?? '';
      const tokenReady = user?.available === true
        && user.status === 'ready'
        && !['expired', 'invalid', 'missing', 'revoked'].includes(tokenStatus);

      if (!tokenReady) {
        return {
          status: 'needs-auth',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          managedInstallStatus: discovered.managedInstallStatus,
          configured: true,
          connected: false,
          authorizationMode: authorizationRecord?.authorizationMode ?? null,
          permissionsComplete: false,
          authorizedAt: authorizationRecord?.authorizedAt ?? null,
          accountName: user?.userName ?? null,
          accountOpenId: user?.openId ?? null,
          tenantName: null,
          capabilities,
          consoleUrl: null,
          message: user?.message || '请使用手机飞书 App 扫码授权全部能力。',
        };
      }

      const appScopes = await this.readAppUserScopes(discovered.path);
      if (!appScopes.size) {
        throw new LarkCliError('飞书 CLI 未返回应用权限清单，请重新检测。', null);
      }
      const permissionsComplete = missingLarkScopes(appScopes, grantedScopes).length === 0;
      const hasAuthorizationRecord = Boolean(authorizationRecord);
      if (!permissionsComplete || (requireAuthorizationRecord && !hasAuthorizationRecord)) {
        return {
          status: 'needs-auth',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          managedInstallStatus: discovered.managedInstallStatus,
          configured: true,
          connected: false,
          authorizationMode: authorizationRecord?.authorizationMode ?? null,
          permissionsComplete,
          authorizedAt: authorizationRecord?.authorizedAt ?? null,
          accountName: user?.userName ?? '飞书用户',
          accountOpenId: user?.openId ?? null,
          tenantName: null,
          capabilities,
          consoleUrl: null,
          message: permissionsComplete
            ? '此电脑需要通过 WeSight 完成一次全部权限授权。'
            : '授权范围不完整，请重新扫码并勾选全部权限。',
        };
      }

      let verifiedCapabilities = capabilities;
      if (verifyCapabilities) {
        verifiedCapabilities = await this.verifyReadCapabilities(capabilities);
      }
      const allGranted = Object.values(verifiedCapabilities).every(capability => (
        capability.granted && (!verifyCapabilities || capability.verified)
      ));
      return {
        status: allGranted ? 'connected' : 'needs-auth',
        cliPath: discovered.path,
        cliVersion: discovered.version,
        managedInstallStatus: discovered.managedInstallStatus,
        configured: true,
        connected: allGranted,
        authorizationMode: authorizationRecord?.authorizationMode
          ?? (requireAuthorizationRecord ? null : LARK_AUTHORIZATION_MODE),
        permissionsComplete,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: user?.userName ?? '飞书用户',
        accountOpenId: user?.openId ?? null,
        tenantName: null,
        capabilities: verifiedCapabilities,
        consoleUrl: null,
        message: allGranted
          ? null
          : '权限验证未全部通过，请检查网络或重新授权全部能力。',
      };
    } catch (error) {
      const larkError = error instanceof LarkCliError ? error : null;
      return {
        status: larkError?.consoleUrl ? 'admin-action-required' : 'error',
        cliPath: discovered.path,
        cliVersion: discovered.version,
        managedInstallStatus: discovered.managedInstallStatus,
        configured: true,
        connected: false,
        authorizationMode: authorizationRecord?.authorizationMode ?? null,
        permissionsComplete: false,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: larkError?.consoleUrl ?? null,
        message: error instanceof Error ? error.message : '检测飞书连接失败',
      };
    }
  }

  async disconnect(): Promise<void> {
    const result = await this.run(
      ['auth', 'logout', '--json'],
      { command: this.requireCli() },
    );
    this.assertSuccess(result);
    this.removeAuthorizationRecord();
  }

  async findOrCreateDefaultFolder(): Promise<FeishuFolderResult> {
    const cliPath = this.requireCli();
    const search = await this.run([
      'drive',
      '+search',
      '--as',
      'user',
      '--query',
      DEFAULT_FOLDER_NAME,
      '--doc-types',
      'folder',
      '--only-title',
      '--page-size',
      '20',
      '--json',
    ], { command: cliPath });
    if (search.code === 0) {
      const payload = extractJson(search.stdout);
      const results = findArray(payload, ['results']);
      for (const result of results) {
        const title = findString(result, ['title', 'name']);
        const docType = findString(result, ['doc_type', 'type']);
        if (title !== DEFAULT_FOLDER_NAME || docType?.toLowerCase() !== 'folder') continue;
        const folderToken = findString(result, ['folder_token', 'token', 'obj_token']);
        if (folderToken) {
          return {
            folderToken,
            url: findString(result, ['url']),
          };
        }
      }
    } else {
      this.assertSuccess(search);
    }

    const created = await this.run([
      'drive',
      '+create-folder',
      '--as',
      'user',
      '--name',
      DEFAULT_FOLDER_NAME,
      '--json',
    ], { command: cliPath });
    this.assertSuccess(created);
    const payload = extractJson(created.stdout);
    const folderToken = findString(payload, ['folder_token', 'token']);
    if (!folderToken) throw new LarkCliError('飞书已创建文件夹，但未返回文件夹标识。', created.code);
    return {
      folderToken,
      url: findString(payload, ['url']),
    };
  }

  async createDocument(markdown: string, parentToken: string): Promise<FeishuDocumentResult> {
    const result = await this.run(buildFeishuCreateDocumentArgs(parentToken), {
      command: this.requireCli(),
      input: markdown,
      timeoutMs: AUTH_TIMEOUT_MS,
    });
    this.assertSuccess(result);
    const payload = extractJson(result.stdout);
    const documentId = findString(payload, ['document_id', 'documentId', 'doc_id']);
    const url = findString(payload, ['url', 'doc_url']);
    if (!documentId || !url) {
      throw new LarkCliError('飞书已创建文档，但未返回文档地址。', result.code);
    }
    return { documentId, url };
  }

  async updateDocument(documentId: string, markdown: string): Promise<void> {
    const result = await this.run(buildFeishuUpdateDocumentArgs(documentId), {
      command: this.requireCli(),
      input: markdown,
      timeoutMs: AUTH_TIMEOUT_MS,
    });
    this.assertSuccess(result);
  }

  async insertAssets(
    documentId: string,
    vaultBasePath: string,
    assets: FeishuAssetDraft[],
  ): Promise<void> {
    const cliPath = this.requireCli();
    for (const asset of assets) {
      const relativePath = ensureSafeVaultPath(asset.vaultPath);
      const inserted = await this.run([
        'docs',
        '+media-insert',
        '--as',
        'user',
        '--doc',
        documentId,
        '--file',
        relativePath,
        '--selection-with-ellipsis',
        asset.placeholder,
        '--align',
        'center',
        '--caption',
        asset.alt,
        '--json',
      ], {
        command: cliPath,
        cwd: vaultBasePath,
        timeoutMs: AUTH_TIMEOUT_MS,
      });
      this.assertSuccess(inserted);

      const removedPlaceholder = await this.run([
        'docs',
        '+update',
        '--api-version',
        'v2',
        '--as',
        'user',
        '--doc',
        documentId,
        '--command',
        'str_replace',
        '--doc-format',
        'markdown',
        '--pattern',
        asset.placeholder,
        '--content',
        '',
        '--json',
      ], { command: cliPath, timeoutMs: AUTH_TIMEOUT_MS });
      this.assertSuccess(removedPlaceholder);
    }
  }

  cancelActiveOperation(): void {
    this.cancelled = true;
    this.pendingDeviceCode = null;
    this.pendingVerificationUrl = null;
    this.pendingRequestedScopes = [];
    this.pendingExpiresAt = null;
    this.activeChild?.kill('SIGTERM');
    this.emitProgress({ phase: 'cancelled', message: '已取消飞书连接操作。' });
  }

  private async installAgentSkills(): Promise<void> {
    if (this.requiredSkillsInstalled()) return;
    this.emitProgress({
      phase: 'installing-skills',
      message: '正在安装完整飞书 Agent Skills…',
    });
    const npxPath = resolveCommand('npx', this.buildSearchEnv()) ?? 'npx';
    const primary = await this.run(
      ['-y', 'skills', 'add', 'https://open.feishu.cn', '-y', '-g'],
      {
        command: npxPath,
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    if (primary.code !== 0 || !this.requiredSkillsInstalled()) {
      const fallback = await this.run(
        ['-y', 'skills', 'add', 'larksuite/cli', '-y', '-g'],
        {
          command: npxPath,
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );
      this.assertSuccess(fallback);
    }
    const missingSkills = this.missingRequiredSkills();
    if (missingSkills.length) {
      throw new LarkCliError(
        `飞书 Skills 安装不完整，缺少：${missingSkills.join('、')}`,
        null,
      );
    }
  }

  private requiredSkillsInstalled(): boolean {
    return this.missingRequiredSkills().length === 0;
  }

  private missingRequiredSkills(): string[] {
    const root = path.join(os.homedir(), '.agents', 'skills');
    return REQUIRED_LARK_SKILLS
      .filter(skill => !fs.existsSync(path.join(root, skill, 'SKILL.md')));
  }

  private async hasConfiguration(): Promise<boolean> {
    const cliPath = this.requireCli();
    const result = await this.run(['config', 'show'], { command: cliPath });
    if (result.code !== 0) return false;
    const payload = extractJson(result.stdout);
    return Boolean(findString(payload, ['appId', 'app_id']));
  }

  private async verifyReadCapabilities(
    capabilities: Record<FeishuCapabilityId, FeishuCapabilityState>,
  ): Promise<Record<FeishuCapabilityId, FeishuCapabilityState>> {
    const cliPath = this.requireCli();
    const checks: Record<FeishuCapabilityId, string[]> = {
      im: ['im', '+chat-list', '--as', 'user', '--page-size', '1', '--json'],
      docs: [
        'docs',
        '+search',
        '--as',
        'user',
        '--query',
        '',
        '--page-size',
        '1',
        '--json',
      ],
      base: [
        'auth',
        'check',
        '--scope',
        REQUIRED_SCOPES.base.join(' '),
        '--json',
      ],
      calendar: ['calendar', '+agenda', '--as', 'user', '--json'],
      drive: [
        'drive',
        '+search',
        '--as',
        'user',
        '--query',
        '',
        '--page-size',
        '1',
        '--json',
      ],
    };
    const verified = { ...capabilities };
    for (const id of Object.keys(checks) as FeishuCapabilityId[]) {
      if (!verified[id].granted) continue;
      const result = await this.run(checks[id], { command: cliPath });
      if (result.code === 0) {
        verified[id] = { ...verified[id], verified: true };
        continue;
      }
      const error = parseCliError(result);
      if (error.consoleUrl) throw error;
      verified[id] = {
        ...verified[id],
        verified: false,
        error: error.message,
      };
    }
    return verified;
  }

  private capabilitiesForScopes(
    grantedScopes: Set<string>,
  ): Record<FeishuCapabilityId, FeishuCapabilityState> {
    return {
      im: createCapability('im', REQUIRED_SCOPES.im.every(scope => grantedScopes.has(scope))),
      docs: createCapability('docs', REQUIRED_SCOPES.docs.every(scope => grantedScopes.has(scope))),
      base: createCapability('base', REQUIRED_SCOPES.base.every(scope => grantedScopes.has(scope))),
      calendar: createCapability(
        'calendar',
        REQUIRED_SCOPES.calendar.every(scope => grantedScopes.has(scope)),
      ),
      drive: createCapability(
        'drive',
        REQUIRED_SCOPES.drive.every(scope => grantedScopes.has(scope)),
      ),
    };
  }

  private async readGrantedScopes(cliPath: string): Promise<Set<string>> {
    const statusResult = await this.run(buildLarkAuthStatusArgs(), { command: cliPath });
    this.assertSuccess(statusResult);
    const status = (extractJson(statusResult.stdout) ?? {}) as LarkAuthStatus;
    return scopesForStatus(status);
  }

  private async readAppUserScopes(cliPath: string): Promise<Set<string>> {
    const scopesResult = await this.run(
      ['auth', 'scopes', '--json'],
      { command: cliPath },
    );
    this.assertSuccess(scopesResult);
    return scopesForApp(extractJson(scopesResult.stdout));
  }

  private readAuthorizationRecord(): LarkAuthorizationRecord | null {
    const record = readJsonFile<unknown>(
      larkCliAuthorizationRecordPath(this.env),
      null,
    );
    return isValidLarkAuthorizationRecord(record) ? record : null;
  }

  private removeAuthorizationRecord(): void {
    try {
      fs.unlinkSync(larkCliAuthorizationRecordPath(this.env));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  private requireCli(): string {
    return this.resolvedCliPath ?? this.discoverCli().path
      ?? (() => { throw new LarkCliError('未安装飞书 CLI。', null); })();
  }

  private buildSearchEnv(): NodeJS.ProcessEnv {
    return {
      ...this.env,
      PATH: [
        path.dirname(larkCliManagedBinaryPath(this.env)),
        path.join(os.homedir(), '.npm-global', 'bin'),
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.volta', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        this.env.PATH ?? '',
      ].join(path.delimiter),
    };
  }

  private emitProgress(progress: FeishuAuthProgress): void {
    this.emit('progress', progress);
  }

  private assertSuccess(result: CommandResult): void {
    if (result.code === 0) return;
    if (result.cancelled || this.cancelled) {
      throw new LarkCliError('飞书操作已取消。', result.code);
    }
    throw parseCliError(result);
  }

  private run(args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const command = options.command ?? this.requireCli();
    const env = options.env ?? this.buildSearchEnv();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cancelled = false;
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeChild = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const append = (current: string, chunk: Buffer | string): string => {
        if (current.length >= MAX_CAPTURE_CHARS) return current;
        return (current + String(chunk)).slice(0, MAX_CAPTURE_CHARS);
      };
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        resolve({
          code,
          stdout,
          stderr,
          cancelled: this.cancelled,
          timedOut,
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout = append(stdout, chunk);
        options.onOutput?.(String(chunk));
      });
      child.stderr?.on('data', (chunk) => {
        stderr = append(stderr, chunk);
        options.onOutput?.(String(chunk));
      });
      child.on('error', (error) => {
        stderr = append(stderr, JSON.stringify({ message: error.message }));
        finish(null);
      });
      child.on('close', code => finish(code));
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }
    });
  }
}
