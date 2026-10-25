/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One driver status for every Install button: a second click joins the
 * running install, and a finished one refreshes every dialect on the package.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverInfo } from '@/shared/lib/types';

const checkDriver = vi.fn();
const installDriver = vi.fn();
const invalidateCache = vi.fn();

vi.mock('@/shared/api/schemaApi', () => ({
  checkDriver: (...args: unknown[]) => checkDriver(...args),
  installDriver: (...args: unknown[]) => installDriver(...args),
  invalidateCache: (...args: unknown[]) => invalidateCache(...args),
}));

import {
  checkDriverStatus,
  clearDriverStatus,
  driverStatusOf,
  installDriverFor,
  missingDriverPackage,
} from './driverStatus';

/** A server where `installed` lists the packages that load. */
function server(packages: Record<string, string>, installed: Set<string>) {
  checkDriver.mockImplementation(async (dialect: string): Promise<DriverInfo> => {
    const packageName = packages[dialect]!;
    return { provider: dialect, packageName, installed: installed.has(packageName), installCommand: `npm install ${packageName}` };
  });
}

beforeEach(() => {
  clearDriverStatus();
  checkDriver.mockReset();
  installDriver.mockReset();
  invalidateCache.mockReset();
});

describe('installDriverFor', () => {
  it('runs one install for two clicks, and both learn it loaded', async () => {
    const installed = new Set<string>();
    server({ redis: 'redis' }, installed);
    let finish!: () => void;
    installDriver.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            installed.add('redis');
            resolve();
          };
        })
    );
    await checkDriverStatus('redis');
    const first = installDriverFor('redis');
    const second = installDriverFor('redis');
    expect(second).toBe(first);
    expect(driverStatusOf('redis').installing).toBe(true);
    finish();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(installDriver).toHaveBeenCalledTimes(1);
    expect(driverStatusOf('redis')).toMatchObject({ installing: false, installError: '' });
    expect(driverStatusOf('redis').info?.installed).toBe(true);
  });

  it('refreshes every dialect on the package, not only the one installed', async () => {
    const installed = new Set<string>();
    server({ mysql: 'mysql2', mariadb: 'mysql2', postgres: 'pg' }, installed);
    installDriver.mockImplementation(async () => installed.add('mysql2'));
    await Promise.all(['mysql', 'mariadb', 'postgres'].map((d) => checkDriverStatus(d)));
    expect(await installDriverFor('mysql')).toBe(true);
    expect(invalidateCache).toHaveBeenCalledWith('driver:');
    expect(driverStatusOf('mariadb').info?.installed).toBe(true);
    expect(driverStatusOf('postgres').info?.installed).toBe(false);
  });

  it('says why when npm fails, and when the driver still does not load', async () => {
    server({ oracle: 'oracledb' }, new Set());
    await checkDriverStatus('oracle');
    installDriver.mockRejectedValueOnce(new Error('npm install oracledb failed (exit 1)'));
    expect(await installDriverFor('oracle')).toBe(false);
    expect(driverStatusOf('oracle').installError).toBe('npm install oracledb failed (exit 1)');

    installDriver.mockResolvedValueOnce({ success: true });
    expect(await installDriverFor('oracle')).toBe(false);
    expect(driverStatusOf('oracle').installError).toBe(
      'Install finished but "oracledb" still failed to load. Try: npm install oracledb'
    );
  });
});

describe('checkDriverStatus', () => {
  it('records a failed check as no answer, not as installed', async () => {
    checkDriver.mockRejectedValueOnce(new Error('Invalid dialect'));
    await checkDriverStatus('nope');
    expect(driverStatusOf('nope')).toMatchObject({ info: null, checkFailed: true });
  });
});

describe('missingDriverPackage', () => {
  it('reads the package from the server’s missing-driver message', () => {
    expect(missingDriverPackage('Database driver "redis" is not installed for Redis. Run: npm install redis')).toBe('redis');
  });

  it('ignores other errors that happen to say "is not installed"', () => {
    expect(
      missingDriverPackage('Full-Text Search is not installed, or a full-text component cannot be loaded.')
    ).toBeNull();
    expect(missingDriverPackage('pgstattuple is not installed')).toBeNull();
    expect(missingDriverPackage(undefined)).toBeNull();
  });
});
