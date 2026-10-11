import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.fn();
vi.mock('@/platform/toastStore', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => {
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    memory.delete(k);
  },
  clear: () => memory.clear(),
});

import { maybeToastUpdateAvailable, toastUpdateCheckResult } from './updateToast';

describe('updateToast', () => {
  beforeEach(() => {
    toastMock.mockReset();
    memory.clear();
  });

  it('toasts once for a given latest version on boot', () => {
    const info = {
      current: '0.2.0',
      latest: '0.3.0',
      updateAvailable: true,
      configured: true,
      url: 'https://example.com/r',
    };
    maybeToastUpdateAvailable(info);
    maybeToastUpdateAvailable(info);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0].title).toMatch(/0\.3\.0/);
  });

  it('force re-toasts from Settings Check even if already dismissed', () => {
    const info = {
      current: '0.2.0',
      latest: '0.3.0',
      updateAvailable: true,
      configured: true,
      url: 'https://example.com/r',
    };
    maybeToastUpdateAvailable(info);
    toastUpdateCheckResult(info);
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it('toasts success when up to date', () => {
    toastUpdateCheckResult({
      current: '0.2.4',
      latest: '0.2.4',
      updateAvailable: false,
      configured: true,
    });
    expect(toastMock.mock.calls[0][0].tone).toBe('success');
  });

  it('toasts info when check fails', () => {
    toastUpdateCheckResult(null);
    expect(toastMock.mock.calls[0][0].tone).toBe('info');
  });
});
