/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriverInfo } from '@/shared/lib/types';
import type { Permission } from '@foxschema/shared';

const checkDriver = vi.fn();
const installDriver = vi.fn();

vi.mock('@/shared/api/schemaApi', () => ({
  checkDriver: (...args: unknown[]) => checkDriver(...args),
  installDriver: (...args: unknown[]) => installDriver(...args),
  invalidateCache: () => {},
}));

import { useAuthStore } from '@/platform/authStore';
import { clearDriverStatus } from '@/shared/lib/driverStatus';
import { MissingDriverBanner } from './MissingDriverBanner';

const REDIS_MISSING = 'Database driver "redis" is not installed for Redis. Run: npm install redis';

function signIn(role: 'admin' | 'editor' | 'viewer', permissions: Permission[] = []) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'u1@example.test', onboardingCompleted: true, role, permissions },
    status: 'ready',
  });
}

/** A server where the redis driver loads once `installed.redis` is true. */
function redisServer(installed: { redis: boolean }) {
  checkDriver.mockImplementation(
    async (dialect: string): Promise<DriverInfo> => ({
      provider: dialect,
      packageName: 'redis',
      installed: installed.redis,
      installCommand: 'npm install redis',
    })
  );
}

beforeEach(() => {
  clearDriverStatus();
  checkDriver.mockReset();
  installDriver.mockReset();
  signIn('admin');
});

describe('MissingDriverBanner', () => {
  it('offers Install when the selected dialect has no driver, then reloads after it loads', async () => {
    const installed = { redis: false };
    redisServer(installed);
    installDriver.mockImplementation(async () => {
      installed.redis = true;
      return { success: true };
    });
    const onInstalled = vi.fn();

    render(<MissingDriverBanner dialect="redis" onInstalled={onInstalled} />);

    const button = await screen.findByTestId('sql-install-driver');
    expect(button.textContent).toMatch(/Install driver/);
    expect(screen.getByText(/Driver “redis” is not installed/)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(installDriver).toHaveBeenCalledWith('redis'));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(screen.queryByTestId('sql-install-driver')).toBeNull();
  });

  it('stays hidden when the driver is already installed', async () => {
    checkDriver.mockResolvedValue({ provider: 'postgres', packageName: 'pg', installed: true });
    render(<MissingDriverBanner dialect="postgres" error="connection refused" />);
    await waitFor(() => expect(checkDriver).toHaveBeenCalled());
    expect(screen.queryByTestId('sql-install-driver')).toBeNull();
  });

  it('shows an install from one banner on every other, and starts it once', async () => {
    const installed = { redis: false };
    redisServer(installed);
    let finish!: () => void;
    installDriver.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            installed.redis = true;
            resolve({ success: true });
          };
        })
    );
    render(
      <>
        <MissingDriverBanner dialect="redis" />
        <MissingDriverBanner dialect="redis" testId="sql-install-driver-conn-2" />
      </>
    );
    fireEvent.click(await screen.findByTestId('sql-install-driver'));
    // The other banner shows the install running, and its click joins it.
    await waitFor(() => expect((screen.getByTestId('sql-install-driver-conn-2') as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId('sql-install-driver-conn-2'));
    finish();
    await waitFor(() => expect(screen.queryByTestId('sql-install-driver-conn-2-banner')).toBeNull());
    expect(screen.queryByTestId('sql-install-driver-banner')).toBeNull();
    expect(installDriver).toHaveBeenCalledTimes(1);
  });

  it('offers no Install without the Install drivers permission, and says who can', async () => {
    signIn('editor', ['editor.run', 'editor.dml']);
    redisServer({ redis: false });
    render(<MissingDriverBanner dialect="redis" />);
    expect(await screen.findByTestId('driver-install-needs-admin')).toBeTruthy();
    expect(screen.getByTestId('driver-install-needs-admin').textContent).toMatch(/npm install redis/);
    expect(screen.queryByTestId('sql-install-driver')).toBeNull();
  });

  it('names the package from the server’s error before the check answers', () => {
    checkDriver.mockReturnValue(new Promise(() => {}));
    render(<MissingDriverBanner dialect="redis" error={REDIS_MISSING} />);
    expect(screen.getByText(/Driver “redis” is not installed/)).toBeTruthy();
  });

  it('stays out of a database error that only says "is not installed"', async () => {
    checkDriver.mockRejectedValue(new Error('network down'));
    render(
      <MissingDriverBanner
        dialect="mssql"
        error="Full-Text Search is not installed, or a full-text component cannot be loaded."
      />
    );
    await waitFor(() => expect(checkDriver).toHaveBeenCalled());
    expect(screen.queryByTestId('sql-install-driver-banner')).toBeNull();
  });

  it('says why an install failed', async () => {
    redisServer({ redis: false });
    installDriver.mockRejectedValue(new Error('npm install redis failed (exit 1): EACCES'));
    render(<MissingDriverBanner dialect="redis" />);
    fireEvent.click(await screen.findByTestId('sql-install-driver'));
    expect((await screen.findByTestId('driver-install-error')).textContent).toMatch(/EACCES/);
  });
});
