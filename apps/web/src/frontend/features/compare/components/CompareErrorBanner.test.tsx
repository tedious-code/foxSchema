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
import { useSyncStore } from '../state/useSyncStore';
import { CompareErrorBanner } from './CompareErrorBanner';

const originalConnect = {
  testSourceConnection: useSyncStore.getState().testSourceConnection,
  testTargetConnection: useSyncStore.getState().testTargetConnection,
};

const MONGO_MISSING =
  'Database driver "mongodb" is not installed for mongodb. Install it with: npm install mongodb — Cannot find module \'mongodb\'';

function signIn(role: 'admin' | 'editor', permissions: Permission[] = []) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'u1@example.test', onboardingCompleted: true, role, permissions },
    status: 'ready',
  });
}

function mongoServer(installed: { mongodb: boolean }) {
  checkDriver.mockImplementation(
    async (dialect: string): Promise<DriverInfo> => ({
      provider: dialect,
      packageName: 'mongodb',
      installed: installed.mongodb,
      installCommand: 'npm install mongodb',
    })
  );
}

beforeEach(() => {
  clearDriverStatus();
  checkDriver.mockReset();
  installDriver.mockReset();
  signIn('admin');
  useSyncStore.setState({
    errorMsg: null,
    sourceConfig: { dialect: 'mongodb', schema: '', option: { connectionString: '' } },
    targetConfig: { dialect: 'postgres', schema: 'public', option: { connectionString: '' } },
    ...originalConnect,
  });
});

describe('CompareErrorBanner', () => {
  it('offers Install driver when Compare failed because mongodb is missing', async () => {
    mongoServer({ mongodb: false });
    useSyncStore.setState({ errorMsg: MONGO_MISSING });
    render(<CompareErrorBanner />);
    expect(await screen.findByTestId('compare-install-driver')).toBeTruthy();
    expect(screen.getByText(/Driver “mongodb” is not installed/)).toBeTruthy();
    expect(screen.queryByText(/Cannot find module/)).toBeNull();
  });

  it('offers no Install without the Install drivers permission, and gives the command instead', async () => {
    signIn('editor');
    mongoServer({ mongodb: false });
    useSyncStore.setState({ errorMsg: MONGO_MISSING });
    render(<CompareErrorBanner />);
    expect(await screen.findByTestId('driver-install-needs-admin')).toBeTruthy();
    expect(screen.getByTestId('driver-install-needs-admin').textContent).toMatch(/npm install mongodb/);
    expect(screen.queryByTestId('compare-install-driver')).toBeNull();
  });

  it('retries the mongodb side after a successful install', async () => {
    const installed = { mongodb: false };
    mongoServer(installed);
    installDriver.mockImplementation(async () => {
      installed.mongodb = true;
    });
    const testSourceConnection = vi.fn().mockResolvedValue(undefined);
    const testTargetConnection = vi.fn().mockResolvedValue(undefined);
    useSyncStore.setState({
      errorMsg: MONGO_MISSING,
      testSourceConnection,
      testTargetConnection,
    });
    render(<CompareErrorBanner />);
    fireEvent.click(await screen.findByTestId('compare-install-driver'));
    await waitFor(() => expect(installDriver).toHaveBeenCalledWith('mongodb'));
    await waitFor(() => expect(testSourceConnection).toHaveBeenCalled());
    expect(testTargetConnection).not.toHaveBeenCalled();
  });

  it('keeps an ordinary compare error as text, with no Install', () => {
    useSyncStore.setState({ errorMsg: 'connection refused' });
    render(<CompareErrorBanner />);
    expect(screen.getByTestId('error-banner').textContent).toMatch(/connection refused/);
    expect(screen.queryByTestId('compare-install-driver')).toBeNull();
  });
});
