/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { coerceDriverBigint, duckDbAdapter } from './duckdb.adapter.js';

describe('coerceDriverBigint', () => {
  it('keeps safe integers as numbers', () => {
    expect(coerceDriverBigint(42n)).toBe(42);
    expect(coerceDriverBigint(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stringifies integers past MAX_SAFE_INTEGER so PK WHERE keys are not rounded', () => {
    const unsafe = 9007199254740993n; // Number(unsafe) === 9007199254740992
    expect(Number(unsafe)).toBe(9007199254740992);
    expect(Number.isSafeInteger(Number(unsafe))).toBe(false);
    expect(coerceDriverBigint(unsafe)).toBe('9007199254740993');
  });
});

describe('duckDbAdapter external-access lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-duckdb-lock-'));
  const secretFile = join(dir, 'secret.txt');
  const outFile = join(dir, 'out.csv');
  const dbFile = join(dir, 'user.duckdb');
  writeFileSync(secretFile, 'TOP_SECRET');

  afterAll(async () => {
    await duckDbAdapter.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks read_text, ATTACH, COPY TO, and re-enabling external access while allowing normal SQL and schema switching', async () => {
    const handle = await duckDbAdapter.acquire(dbFile, {}, false);
    await duckDbAdapter.query(handle, 'CREATE SCHEMA s1', []);
    await duckDbAdapter.setCurrentSchema(handle, 's1');
    await duckDbAdapter.query(handle, 'CREATE TABLE items (id INT, name VARCHAR)', []);
    await duckDbAdapter.query(handle, "INSERT INTO items VALUES (1, 'ok')", []);
    const rows = await duckDbAdapter.query<{ id: number; name: string }>(handle, 'SELECT id, name FROM items', []);
    expect(rows).toEqual([{ id: 1, name: 'ok' }]);

    await expect(
      duckDbAdapter.query(handle, `SELECT * FROM read_text('${secretFile.replace(/'/g, "''")}')`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, `ATTACH '${join(dir, 'other.db').replace(/'/g, "''")}' AS m`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, `COPY (SELECT 1) TO '${outFile.replace(/'/g, "''")}'`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, 'SET enable_external_access = true', []),
    ).rejects.toThrow(/configuration has been locked/i);
  });

  it('refuses to open FoxSchema internal metadata database paths', async () => {
    await expect(duckDbAdapter.acquire(join(dir, 'foxschema.db'), {}, false)).rejects.toThrow(
      /internal metadata database/i,
    );
  });
});
