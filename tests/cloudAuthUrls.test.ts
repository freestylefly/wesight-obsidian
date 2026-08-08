vi.mock('obsidian', () => ({
  App: class {},
  Notice: class {},
  requestUrl: vi.fn(),
}));

import { afterEach, describe, expect, test, vi } from 'vitest';

import { CloudAuthService } from '../src/share/cloudAuth';

describe('CloudAuthService browser URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('opens account details with the Obsidian source', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const auth = new CloudAuthService({} as never);

    expect(auth.getAccountUrl()).toBe('https://pay.wesight.ai/account');
    auth.openAccount();

    expect(open).toHaveBeenCalledWith(
      'https://pay.wesight.ai/account?source=obsidian',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('keeps the existing billing checkout destination', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const auth = new CloudAuthService({} as never);

    auth.openBilling();

    expect(open).toHaveBeenCalledWith(
      'https://pay.wesight.ai/billing?source=obsidian',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('opens admin dashboard with the Obsidian source', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const auth = new CloudAuthService({} as never);

    expect(auth.getAdminUrl()).toBe('https://pay.wesight.ai/admin');
    auth.openAdmin();

    expect(open).toHaveBeenCalledWith(
      'https://pay.wesight.ai/admin?source=obsidian',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
