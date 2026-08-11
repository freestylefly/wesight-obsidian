/* eslint obsidianmd/no-global-this: off -- Vitest's Node environment has no Obsidian window. */
vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  compareSemVer,
  OFFICIAL_PLUGIN_URL,
  shouldNotifyUpdate,
  startUpdatePolling,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateService,
  type UpdateState,
} from '../src/update/updateService';

const releaseManifest = {
  id: 'wesight',
  version: '0.9.1',
  minAppVersion: '1.11.4',
};

function createService(
  fetchLatestManifest: () => Promise<unknown>,
  currentVersion = '0.9.1',
  currentAppVersion = '1.13.6',
): UpdateService {
  return new UpdateService({
    currentVersion,
    currentAppVersion,
    fetchLatestManifest,
    now: () => 123_456,
  });
}

describe('UpdateService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('compares pure numeric SemVer including multi-digit components', () => {
    expect(compareSemVer('0.10.0', '0.9.9')).toBe(1);
    expect(compareSemVer('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemVer('1.2.2', '1.2.3')).toBe(-1);
  });

  test('reports the installed release as current', async () => {
    const service = createService(async () => releaseManifest);

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'current',
      currentVersion: '0.9.1',
      latestVersion: '0.9.1',
      checkedAt: 123_456,
    });
  });

  test('discovers a newer formal release', async () => {
    const service = createService(
      async () => ({ ...releaseManifest, version: '0.10.0' }),
      '0.9.9',
    );

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'available',
      currentVersion: '0.9.9',
      latestVersion: '0.10.0',
    });
  });

  test('rejects malformed versions and a mismatched plugin id', async () => {
    const malformed = createService(async () => ({ ...releaseManifest, version: '0.10' }));
    await expect(malformed.checkForUpdates()).rejects.toThrow('x.y.z');
    expect(malformed.getState().status).toBe('error');

    const mismatched = createService(async () => ({ ...releaseManifest, id: 'another-plugin' }));
    await expect(mismatched.checkForUpdates()).rejects.toThrow('其他插件');
    expect(mismatched.getState().status).toBe('error');
  });

  test('marks a newer release as incompatible with an older Obsidian app', async () => {
    const service = createService(
      async () => ({ ...releaseManifest, version: '1.0.0', minAppVersion: '1.14.0' }),
      '0.9.1',
      '1.13.6',
    );

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'incompatible',
      latestVersion: '1.0.0',
      minAppVersion: '1.14.0',
    });
  });

  test('reuses one request for concurrent checks', async () => {
    let resolveManifest: (value: unknown) => void = () => undefined;
    const fetchLatestManifest = vi.fn(() => new Promise<unknown>(resolve => {
      resolveManifest = resolve;
    }));
    const service = createService(fetchLatestManifest);

    const first = service.checkForUpdates();
    const second = service.checkForUpdates();

    expect(first).toBe(second);
    expect(fetchLatestManifest).toHaveBeenCalledTimes(1);
    resolveManifest(releaseManifest);
    await expect(first).resolves.toMatchObject({ status: 'current' });
  });

  test('keeps a known available update after a transient network failure', async () => {
    const fetchLatestManifest = vi.fn()
      .mockResolvedValueOnce({ ...releaseManifest, version: '0.10.0' })
      .mockRejectedValueOnce(new Error('offline'));
    const service = createService(fetchLatestManifest);

    await service.checkForUpdates();
    await expect(service.checkForUpdates()).rejects.toThrow('offline');
    expect(service.getState()).toMatchObject({
      status: 'available',
      latestVersion: '0.10.0',
      error: 'offline',
    });
  });

  test('polls immediately and every six hours while swallowing background errors', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setInterval: global.setInterval.bind(global),
      clearInterval: global.clearInterval.bind(global),
    });
    const check = vi.fn().mockRejectedValue(new Error('offline'));
    const intervalId = startUpdatePolling(check, (handler, timeout) =>
      window.setInterval(handler, timeout));

    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    window.clearInterval(intervalId);
  });

  test('notifies once per discovered version', () => {
    const state: UpdateState = {
      status: 'available',
      currentVersion: '0.9.1',
      latestVersion: '0.10.0',
      minAppVersion: '1.11.4',
      checkedAt: 123_456,
      error: null,
    };

    expect(shouldNotifyUpdate(state, '')).toBe(true);
    expect(shouldNotifyUpdate(state, '0.10.0')).toBe(false);
    expect(shouldNotifyUpdate({ ...state, status: 'current' }, '')).toBe(false);
  });

  test('opens the official Obsidian plugin page', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const service = createService(async () => releaseManifest);

    service.openOfficialUpdatePage();

    expect(open).toHaveBeenCalledWith(
      OFFICIAL_PLUGIN_URL,
      '_blank',
      'noopener,noreferrer',
    );
  });
});
