/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server and Azure SQL share one adapter class. What must still differ is
 * the dialect each registers under and Azure's encryption-on default.
 */
import { describe, expect, it } from 'vitest';
import { MssqlAdapter, sqlServerAdapter } from './sqlserver.adapter.js';
import { azureSqlAdapter } from '../azureSql/azuresql.adapter.js';

const config = (adapter: unknown) =>
  (adapter as { buildConfig(o: object): { options: { encrypt: boolean } } }).buildConfig({ host: 'h' });

describe('MssqlAdapter instances', () => {
  it('register as two dialects with separate pools', () => {
    expect(sqlServerAdapter.dialect).toBe('sqlserver');
    expect(azureSqlAdapter.dialect).toBe('azuresql');
    expect(sqlServerAdapter).not.toBe(azureSqlAdapter);
  });

  it('encrypts by default only for Azure SQL', () => {
    expect(config(sqlServerAdapter).options.encrypt).toBe(false);
    expect(config(azureSqlAdapter).options.encrypt).toBe(true);
  });
});

describe('MssqlAdapter.query', () => {
  // mssql's result for INSERT/UPDATE/DELETE/DDL has `recordsets: []` and no
  // `recordset` at all. Returning that as-is broke ConnectionFactory.executeQuery,
  // which reads `rows.length` ("Cannot read properties of undefined").
  const withResult = (result: object) => {
    const adapter = new MssqlAdapter('sqlserver', false);
    class Request {
      input() {}
      async query() {
        return result;
      }
    }
    (adapter as unknown as { driver: unknown }).driver = { Request };
    return adapter;
  };
  const handle = { _type: 'pool', pool: {} } as const;

  it('returns an empty array for a statement with no result set', async () => {
    const rows = await withResult({ recordsets: [], rowsAffected: [1] }).query(handle, 'INSERT INTO t (id) VALUES (1)', []);
    expect(rows).toEqual([]);
  });

  it('returns the rows of a SELECT', async () => {
    const rows = await withResult({ recordset: [{ n: 1 }], recordsets: [[{ n: 1 }]] }).query(handle, 'SELECT 1 AS n', []);
    expect(rows).toEqual([{ n: 1 }]);
  });
});
