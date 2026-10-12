/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Index Management probe (Utilities → Index Management) against a real SQLite file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { probeTableFragmentation, mapPool, resolveFragmentationSchema } from './index-fragmentation.service';
import { ConnectionFactory } from '@foxschema/db';

const dbPath = join(tmpdir(), `fox-index-frag-test-${process.pid}.db`);
const option = { connectionString: dbPath };

describe('resolveFragmentationSchema', () => {
  it('falls back to option.database for MySQL-family when schema is blank', () => {
    expect(
      resolveFragmentationSchema('mysql', '', { database: 'shop' })
    ).toBe('shop');
    expect(
      resolveFragmentationSchema('mariadb', '', { database: 'shop' })
    ).toBe('shop');
    expect(resolveFragmentationSchema('tidb', 'explicit', { database: 'shop' })).toBe(
      'explicit'
    );
  });

  it('falls back to username for Oracle when schema is blank', () => {
    expect(
      resolveFragmentationSchema('oracle', '', { username: 'HR', database: 'ORCL' })
    ).toBe('HR');
  });

  it('keeps empty for dialects that default inside the probe SQL', () => {
    expect(resolveFragmentationSchema('postgres', '', { database: 'app' })).toBe('');
    expect(resolveFragmentationSchema('sqlserver', '', { database: 'app' })).toBe('');
  });

  it('lets MySQL probe build when only option.database is set', async () => {
    const { buildIndexFragmentationQuery } = await import('@foxschema/db');
    const schema = resolveFragmentationSchema('mysql', '', { database: 'orders_db' });
    const q = buildIndexFragmentationQuery({
      dialect: 'mysql',
      schema,
      table: 'orders',
    });
    expect('error' in q).toBe(false);
    if ('error' in q) return;
    expect(q.params).toEqual(['orders_db', 'orders']);
  });
});

describe('probeTableFragmentation against a real SQLite file', () => {
  beforeAll(async () => {
    // A killed run leaves the file behind and PIDs get recycled — start clean.
    rmSync(dbPath, { force: true });
    // better-sqlite3 ships no type declarations (the sqlite adapter loads it
    // untyped via createRequire too) — suppress for this seeding-only usage.
    // @ts-expect-error no type declarations for better-sqlite3
    const mod = (await import('better-sqlite3')) as { default: new (path: string) => { exec(sql: string): void; close(): void } };
    const Database = mod.default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT);
      CREATE INDEX idx_orders_customer ON orders (customer_id);
      CREATE INDEX idx_orders_status ON orders (status);
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO orders (customer_id, status) VALUES (1, 'open'), (2, 'shipped');
    `);
    db.close();
  });

  afterAll(async () => {
    await ConnectionFactory.closeAll().catch(() => {});
    rmSync(dbPath, { force: true });
  });

  it('lists table indexes with defrag suggestions (SQLite has no native %)', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
    });
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;

    expect(probed.value.source).toBe('default');
    expect(probed.value.mode).toBe('estimated');
    expect(probed.value.rows.map((r) => r.indexName)).toEqual([
      'idx_orders_customer',
      'idx_orders_status',
    ]);
    for (const row of probed.value.rows) {
      expect(row.fragmentationPercent).toBeNull();
    }
    expect(probed.value.defrag['idx_orders_customer']?.[0]).toBe('REINDEX "idx_orders_customer";');
    expect(probed.value.customSqlTemplate).toMatch(/sqlite_master/);
  });

  it('suggested defrag SQL actually runs on the database', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
    });
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    const reindex = probed.value.defrag['idx_orders_status']![0]!;
    await expect(
      ConnectionFactory.executeQuery('sqlite', option, reindex, [])
    ).resolves.toBeDefined();
  });

  it('returns an empty listing for a table without indexes', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'customers',
    });
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.value.rows).toEqual([]);
    expect(probed.value.defrag).toEqual({});
  });

  it('runs custom SQL when preferred, clamping percents to 0–100', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
      customSql: `SELECT 'idx_orders_customer' AS index_name, 250 AS fragmentation_percent;`,
    });
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.value.source).toBe('custom');
    expect(probed.value.rows).toEqual([
      { indexName: 'idx_orders_customer', fragmentationPercent: 100, pageCount: null, lastUsed: null, scanCount: null },
    ]);
    expect(probed.value.defrag['idx_orders_customer']?.[0]).toMatch(/^REINDEX/);
  });

  it('rejects a write disguised as a custom probe', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
      customSql: `DELETE FROM orders`,
    });
    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.failure.status).toBe(400);
    expect(probed.failure.error).toMatch(/SELECT/);
  });

  it('refuses a SELECT … INTO hidden behind a comment marker in a string, before running it', async () => {
    // On Postgres or SQL Server this creates a table. SQLite has no
    // SELECT … INTO, so had it reached the database the failure would be its
    // syntax error as a 500; refused first, it is a 400 naming the write.
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
      customSql: `SELECT '/*', 1 INTO fox_probe FROM orders -- */`,
    });
    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.failure.status).toBe(400);
    expect(probed.failure.error).toMatch(/read-only/);
  });

  it('rejects multi-statement custom SQL', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
      customSql: `SELECT 1 AS index_name; SELECT 2 AS index_name;`,
    });
    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.failure.status).toBe(400);
    expect(probed.failure.error).toMatch(/single statement/);
  });

  it('requires customSql when preferCustom is set', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
    });
    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.failure.status).toBe(400);
    expect(probed.failure.error).toMatch(/customSql is required/);
  });

  it('surfaces a custom-probe SQL error as a 500 failure', async () => {
    const probed = await probeTableFragmentation({
      dialect: 'sqlite',
      option,
      schema: '',
      table: 'orders',
      preferCustom: true,
      customSql: `SELECT index_name FROM no_such_table`,
    });
    expect(probed.ok).toBe(false);
    if (probed.ok) return;
    expect(probed.failure.status).toBe(500);
    expect(probed.failure.error).toMatch(/no_such_table|no such table/i);
  });
});

describe('mapPool (batch endpoint concurrency helper)', () => {
  it('preserves input order and caps concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = await mapPool(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Vary completion order so ordering must come from mapPool, not timing.
      await new Promise((r) => setTimeout(r, (n % 3) * 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe('Postgres fallback gating when pgstattuple is absent', () => {
  /**
   * The fallback exists for one specific cause: `pgstatindex` is unavailable
   * because the pgstattuple extension is not installed. It must not swallow
   * every other failure — a statement timeout reported as "install
   * pgstattuple" sends the reader to fix something that is already correct,
   * and the real error is lost.
   *
   * These drive the predicate directly; the live end-to-end behaviour of both
   * probes is covered against a real Postgres in the dialect e2e suite.
   */
  const shouldFallBack = (message: string) => /pgstat(index|tuple)/i.test(message);

  it('falls back for the Postgres missing-function error', () => {
    expect(shouldFallBack('function pgstatindex(regclass) does not exist')).toBe(true);
  });

  it('falls back for CockroachDB, which words it differently', () => {
    expect(shouldFallBack('unknown function: pgstatindex()')).toBe(true);
  });

  it('falls back when the extension exists but the role cannot execute it', () => {
    expect(shouldFallBack('permission denied for function pgstatindex')).toBe(true);
  });

  it('does NOT fall back on a statement timeout', () => {
    // The extension is installed and fine; the index is just big.
    expect(shouldFallBack('canceling statement due to statement timeout')).toBe(false);
  });

  it('does NOT fall back when the connection dropped', () => {
    expect(shouldFallBack('terminating connection due to administrator command')).toBe(false);
  });

  it('does NOT fall back on an unrelated missing relation', () => {
    expect(shouldFallBack('relation "pg_stat_user_indexes" does not exist')).toBe(false);
  });
});
