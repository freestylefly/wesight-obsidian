import { requestUrl } from 'obsidian';

const PLUGIN_ID = 'wesight';
const LATEST_RELEASE_MANIFEST_URL =
  'https://github.com/freestylefly/wesight-obsidian/releases/latest/download/manifest.json';

export const OFFICIAL_PLUGIN_URL = 'obsidian://show-plugin/?id=wesight';
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'incompatible'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  minAppVersion: string | null;
  checkedAt: number | null;
  error: string | null;
}

interface ReleaseManifest {
  id: string;
  version: string;
  minAppVersion: string;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  currentAppVersion: string;
  fetchLatestManifest?: () => Promise<unknown>;
  now?: () => number;
}

type UpdateListener = (state: Readonly<UpdateState>) => void;

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<UpdateListener>();
  private readonly fetchLatestManifest: () => Promise<unknown>;
  private readonly now: () => number;
  private inFlight: Promise<UpdateState> | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    assertSemVer(options.currentVersion, '当前插件版本');
    assertSemVer(options.currentAppVersion, '当前 Obsidian 版本');
    this.fetchLatestManifest = options.fetchLatestManifest ?? fetchLatestReleaseManifest;
    this.now = options.now ?? Date.now;
    this.state = {
      status: 'idle',
      currentVersion: options.currentVersion,
      latestVersion: null,
      minAppVersion: null,
      checkedAt: null,
      error: null,
    };
  }

  getState(): Readonly<UpdateState> {
    return this.state;
  }

  onChange(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  checkForUpdates(): Promise<UpdateState> {
    if (this.inFlight) return this.inFlight;

    const previous = this.state;
    this.setState({ ...previous, status: 'checking', error: null });
    const pending = this.performCheck(previous).finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  openOfficialUpdatePage(): void {
    window.open(OFFICIAL_PLUGIN_URL, '_blank', 'noopener,noreferrer');
  }

  private async performCheck(previous: UpdateState): Promise<UpdateState> {
    try {
      const manifest = parseReleaseManifest(await this.fetchLatestManifest());
      const isNewer = compareSemVer(manifest.version, this.options.currentVersion) > 0;
      const compatible = compareSemVer(this.options.currentAppVersion, manifest.minAppVersion) >= 0;
      const next: UpdateState = {
        status: isNewer ? (compatible ? 'available' : 'incompatible') : 'current',
        currentVersion: this.options.currentVersion,
        latestVersion: manifest.version,
        minAppVersion: manifest.minAppVersion,
        checkedAt: this.now(),
        error: null,
      };
      this.setState(next);
      return next;
    } catch (error) {
      const normalized = normalizeError(error);
      const keepsKnownUpdate = previous.status === 'available' || previous.status === 'incompatible';
      const next: UpdateState = keepsKnownUpdate
        ? { ...previous, checkedAt: this.now(), error: normalized.message }
        : {
            status: 'error',
            currentVersion: this.options.currentVersion,
            latestVersion: previous.latestVersion,
            minAppVersion: previous.minAppVersion,
            checkedAt: this.now(),
            error: normalized.message,
          };
      this.setState(next);
      throw normalized;
    }
  }

  private setState(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

export function compareSemVer(left: string, right: string): number {
  const leftParts = parseSemVer(left);
  const rightParts = parseSemVer(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function startUpdatePolling<T>(
  check: () => Promise<unknown>,
  schedule: (handler: () => void, timeout: number) => T,
): T {
  const run = () => {
    void check().catch(() => undefined);
  };
  run();
  return schedule(run, UPDATE_CHECK_INTERVAL_MS);
}

export function shouldNotifyUpdate(
  state: Readonly<UpdateState>,
  lastNotifiedVersion: string | null | undefined,
): boolean {
  return (
    (state.status === 'available' || state.status === 'incompatible')
    && Boolean(state.latestVersion)
    && state.latestVersion !== lastNotifiedVersion
  );
}

function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('最新版本信息无效。');
  }
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.id !== PLUGIN_ID) {
    throw new Error('更新源返回了其他插件的信息。');
  }
  if (typeof manifest.version !== 'string') {
    throw new Error('最新插件版本号缺失。');
  }
  if (typeof manifest.minAppVersion !== 'string') {
    throw new Error('最新版本缺少 Obsidian 兼容信息。');
  }
  assertSemVer(manifest.version, '最新插件版本');
  assertSemVer(manifest.minAppVersion, '最低 Obsidian 版本');
  return manifest as ReleaseManifest;
}

function parseSemVer(version: string): [number, number, number] {
  assertSemVer(version, '版本');
  return version.split('.').map(Number) as [number, number, number];
}

function assertSemVer(version: string, label: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label}“${version}”不符合 x.y.z 格式。`);
  }
}

async function fetchLatestReleaseManifest(): Promise<unknown> {
  const response = await requestUrl({
    url: LATEST_RELEASE_MANIFEST_URL,
    method: 'GET',
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`检查更新失败（HTTP ${response.status}）。`);
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new Error('最新版本信息无法解析。');
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`检查更新失败：${String(error)}`);
}
