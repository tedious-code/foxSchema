/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverInfo } from '@foxschema/sql';
import {
  clearDriverLatestCache,
  fetchNpmLatest,
  groupDriverInventory,
  isBundledDriverPackage,
  knownDriverPackage,
  listDriverInventory,
  removeDriverPackage,
} from './drivers.service';

afterEach(() => clearDriverLatestCache());

const info = (over: Partial<DriverInfo> & Pick<DriverInfo, 'provider' | 'packageName'>): DriverInfo => ({
  installed: true,
  ...over,
});

describe('knownDriverPackage', () => {
  it('accepts a package the adapter registry names, and nothing else', () => {
    expect(knownDriverPackage('mongodb')).toBe('mongodb');
    expect(knownDriverPackage(' pg ')).toBe('pg');
    expect(knownDriverPackage('')).toBeNull();
    expect(knownDriverPackage('evil')).toBeNull();
    expect(knownDriverPackage({ packageName: 'pg' })).toBeNull();
  });
});

describe('groupDriverInventory', () => {
  it('collapses dialects that share one npm package into one row', () => {
    const rows = groupDriverInventory([
      info({ provider: 'postgres', packageName: 'pg', version: '8.23.1' }),
      info({ provider: 'cockroachdb', packageName: 'pg', version: '8.23.1' }),
      info({ provider: 'yugabytedb', packageName: 'pg', version: '8.23.1' }),
      info({ provider: 'redshift', packageName: 'pg', version: '8.23.1' }),
      info({ provider: 'mongodb', packageName: 'mongodb', installed: false, installCommand: 'npm install mongodb' }),
    ]);
    const pg = rows.find((row) => row.packageName === 'pg');
    expect(pg?.dialects).toEqual(['postgres', 'cockroachdb', 'yugabytedb', 'redshift']);
    expect(pg?.installed).toBe(true);
    expect(pg?.version).toBe('8.23.1');
    expect(pg?.removable).toBe(true);
    expect(pg?.latest).toBeUndefined();
    const mongo = rows.find((row) => row.packageName === 'mongodb');
    expect(mongo?.installed).toBe(false);
    expect(mongo?.removable).toBe(false);
  });

  it('marks a newer registry version as an update, and bundled packages not removable', () => {
    const rows = groupDriverInventory(
      [
        info({ provider: 'postgres', packageName: 'pg', version: '8.0.0' }),
        info({ provider: 'sqlite', packageName: 'better-sqlite3', version: '13.0.3' }),
      ],
      {
        isBundled: (name) => name === 'better-sqlite3',
        latestByPackage: { pg: '8.23.1', 'better-sqlite3': '13.0.3' },
      }
    );
    const pg = rows.find((row) => row.packageName === 'pg')!;
    expect(pg.updateAvailable).toBe(true);
    expect(pg.latest).toBe('8.23.1');
    expect(pg.removable).toBe(true);
    const sqlite = rows.find((row) => row.packageName === 'better-sqlite3')!;
    expect(sqlite.updateAvailable).toBe(false);
    expect(sqlite.bundled).toBe(true);
    expect(sqlite.removable).toBe(false);
  });
});

describe('isBundledDriverPackage', () => {
  it('never lets better-sqlite3 be removed — it is the metadata store', () => {
    expect(isBundledDriverPackage('better-sqlite3')).toBe(true);
    expect(isBundledDriverPackage('mongodb')).toBe(false);
    expect(isBundledDriverPackage('pg')).toBe(false);
  });
});

describe('removeDriverPackage', () => {
  it('refuses to uninstall the metadata SQLite driver without touching npm', async () => {
    const result = await removeDriverPackage('better-sqlite3');
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    if (result.ok) return;
    expect(result.message).toMatch(/cannot be removed/);
  });
});

describe('listDriverInventory', () => {
  it('lists each adapter package once, with the real pg driver installed here', async () => {
    const report = await listDriverInventory();
    expect(report.latestChecked).toBe(false);
    const names = report.drivers.map((row) => row.packageName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('pg');
    expect(names).toContain('mongodb');
    const pg = report.drivers.find((row) => row.packageName === 'pg');
    expect(pg?.installed).toBe(true);
    expect(pg?.version).toMatch(/^\d+\.\d+/);
    expect(pg?.latest).toBeUndefined();
    expect(pg?.dialects).toEqual(expect.arrayContaining(['postgres', 'cockroachdb']));
  });

  it('coalesces overlapping registry fetches for the same package', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ version: '1.2.3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const [a, b] = await Promise.all([fetchNpmLatest('pg', fetchImpl), fetchNpmLatest('pg', fetchImpl)]);
    expect(a).toBe('1.2.3');
    expect(b).toBe('1.2.3');
    expect(calls).toBe(1);
  });

  it('fills latest only when asked, from the injected registry', async () => {
    const report = await listDriverInventory(
      { latest: true },
      {
        detectAll: () => [
          info({ provider: 'mongodb', packageName: 'mongodb', version: '6.0.0' }),
          info({ provider: 'redis', packageName: 'redis', installed: false }),
        ],
        isBundled: () => false,
        fetchLatest: async (pkg) => (pkg === 'mongodb' ? '6.9.0' : null),
      }
    );
    expect(report.latestChecked).toBe(true);
    const mongo = report.drivers.find((row) => row.packageName === 'mongodb')!;
    expect(mongo.latest).toBe('6.9.0');
    expect(mongo.updateAvailable).toBe(true);
    const redis = report.drivers.find((row) => row.packageName === 'redis')!;
    expect(redis.latest).toBeNull();
    expect(redis.updateAvailable).toBe(false);
  });
});
