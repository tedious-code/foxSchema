/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverInventoryItem, DriverInventoryReport, Permission } from '@foxschema/shared';

const api = vi.hoisted(() => ({
  list: (_latest?: boolean): Promise<DriverInventoryReport> => Promise.reject(new Error('not set')),
  install: vi.fn(async (_packageName: string) => ({ success: true })),
  update: vi.fn(async (_packageName: string) => ({ success: true })),
  remove: vi.fn(async (_packageName: string) => ({ success: true })),
}));

vi.mock('@/shared/api/servicesApi', () => ({
  fetchDriverInventory: (latest?: boolean) => api.list(latest),
  installDriverPackage: (packageName: string) => api.install(packageName),
  updateDriverPackage: (packageName: string) => api.update(packageName),
  removeDriverPackage: (packageName: string) => api.remove(packageName),
}));

vi.mock('@/shared/api/schemaApi', () => ({
  invalidateCache: () => {},
}));

import { useAuthStore } from '@/platform/authStore';
import { DriverInventoryCard, driverRowTestId } from './DriverInventoryCard';

const row = (over: Partial<DriverInventoryItem> & Pick<DriverInventoryItem, 'packageName'>): DriverInventoryItem => ({
  dialects: ['mongodb'],
  labels: ['MongoDB'],
  installed: false,
  updateAvailable: false,
  bundled: false,
  removable: false,
  ...over,
});

const report = (drivers: DriverInventoryItem[], latestChecked = false): DriverInventoryReport => ({
  drivers,
  checkedAt: 1,
  latestChecked,
});

function signIn(role: 'admin' | 'editor', permissions: Permission[] = []) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'u1@example.test', onboardingCompleted: true, role, permissions },
    status: 'ready',
  });
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe('DriverInventoryCard', () => {
  beforeEach(() => {
    api.install.mockClear();
    api.update.mockClear();
    api.remove.mockClear();
    signIn('admin');
    api.list = async () =>
      report([
        row({
          packageName: 'pg',
          dialects: ['postgres', 'cockroachdb'],
          labels: ['PostgreSQL', 'CockroachDB'],
          installed: true,
          version: '8.23.1',
          bundled: false,
          removable: true,
        }),
        row({ packageName: 'mongodb', installCommand: 'npm install mongodb' }),
      ]);
  });

  it('lists installed and missing drivers', async () => {
    render(<DriverInventoryCard />);
    await waitFor(() => expect(text(`${driverRowTestId('pg')}-state`)).toContain('Installed · 8.23.1'));
    expect(text(`${driverRowTestId('mongodb')}-state`)).toBe('Not installed');
    expect(screen.getByTestId(`${driverRowTestId('mongodb')}-install`)).toBeTruthy();
    expect(screen.getByTestId(`${driverRowTestId('pg')}-remove`)).toBeTruthy();
  });

  it('offers no Install without admin.drivers', async () => {
    signIn('editor');
    render(<DriverInventoryCard />);
    await waitFor(() => expect(screen.getByTestId(driverRowTestId('mongodb'))).toBeTruthy());
    expect(screen.queryByTestId(`${driverRowTestId('mongodb')}-install`)).toBeNull();
  });

  it('installs a missing driver and refreshes the list', async () => {
    let installed = false;
    api.list = async () =>
      report([
        row({
          packageName: 'mongodb',
          installed,
          version: installed ? '6.9.0' : undefined,
          removable: installed,
        }),
      ]);
    api.install.mockImplementation(async () => {
      installed = true;
      return { success: true };
    });
    render(<DriverInventoryCard />);
    await waitFor(() => expect(screen.getByTestId(`${driverRowTestId('mongodb')}-install`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`${driverRowTestId('mongodb')}-install`));
    await waitFor(() => expect(text(`${driverRowTestId('mongodb')}-state`)).toBe('Installed · 6.9.0'));
    expect(api.install).toHaveBeenCalledWith('mongodb');
  });

  it('checks versions on first paint and offers Update when the registry is newer', async () => {
    api.list = async (latest?: boolean) =>
      report(
        [
          row({
            packageName: 'mongodb',
            installed: true,
            version: '6.0.0',
            latest: latest ? '6.9.0' : undefined,
            updateAvailable: !!latest,
            removable: true,
          }),
        ],
        !!latest
      );
    render(<DriverInventoryCard />);
    await waitFor(() => expect(screen.getByTestId(`${driverRowTestId('mongodb')}-update`)).toBeTruthy());
    expect(text(`${driverRowTestId('mongodb')}-state`)).toContain('6.0.0 → 6.9.0');
    fireEvent.click(screen.getByTestId('home-drivers-check'));
    await waitFor(() => expect(screen.getByTestId(`${driverRowTestId('mongodb')}-update`)).toBeTruthy());
  });

  it('queues a second driver while the first npm is still running', async () => {
    let releaseInstall: (() => void) | undefined;
    let pgUpdated = false;
    api.list = async () =>
      report([
        row({ packageName: 'mongodb', installCommand: 'npm install mongodb' }),
        row({
          packageName: 'mssql',
          dialects: ['sqlserver'],
          labels: ['SQL Server'],
          installed: true,
          version: '12.7.13',
          latest: '12.7.14',
          updateAvailable: true,
          removable: true,
        }),
      ]);
    api.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInstall = () => resolve({ success: true });
        })
    );
    api.update.mockImplementation(async () => {
      pgUpdated = true;
      return { success: true };
    });
    render(<DriverInventoryCard />);
    await waitFor(() => expect(screen.getByTestId(`${driverRowTestId('mongodb')}-install`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`${driverRowTestId('mongodb')}-install`));
    fireEvent.click(screen.getByTestId(`${driverRowTestId('mssql')}-update`));
    await waitFor(() => expect(text(`${driverRowTestId('mssql')}-update`)).toContain('Waiting'));
    expect(screen.getByTestId('home-drivers-queue')).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
    expect(releaseInstall).toBeTypeOf('function');
    releaseInstall!();
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('mssql'));
    expect(pgUpdated).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('home-drivers-queue')).toBeNull());
  });

  it('asks once more before removing', async () => {
    let gone = false;
    api.list = async () =>
      report([
        row({
          packageName: 'mongodb',
          installed: !gone,
          version: gone ? undefined : '6.9.0',
          removable: !gone,
        }),
      ]);
    api.remove.mockImplementation(async () => {
      gone = true;
      return { success: true };
    });
    render(<DriverInventoryCard />);
    await waitFor(() => expect(screen.getByTestId(`${driverRowTestId('mongodb')}-remove`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`${driverRowTestId('mongodb')}-remove`));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`${driverRowTestId('mongodb')}-remove-confirm`));
    await waitFor(() => expect(text(`${driverRowTestId('mongodb')}-state`)).toBe('Not installed'));
    expect(api.remove).toHaveBeenCalledWith('mongodb');
  });
});
