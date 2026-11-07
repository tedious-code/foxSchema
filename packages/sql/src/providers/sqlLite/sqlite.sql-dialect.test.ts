/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { sqliteSqlDialect } from './sqlite.sql-dialect.js';

describe('sqlite CREATE INDEX', () => {
  it('puts the schema on the index, never on the table', () => {
    // `CREATE INDEX idx ON main.customers(email)` is `near ".": syntax error`
    // in SQLite — the qualifier belongs on the index name. Found by driving a
    // revert end to end; the plan looked right and the driver rejected it.
    const sql = sqliteSqlDialect.createIndexStatement!(
      { name: 'idx_customers_email', columns: ['email'], unique: false },
      'main.customers'
    );
    expect(sql).toBe(
      'CREATE INDEX IF NOT EXISTS main.idx_customers_email ON customers (email);'
    );
    expect(sql).not.toMatch(/ON\s+main\./);
  });

  it('handles an unqualified table and a unique index', () => {
    expect(
      sqliteSqlDialect.createIndexStatement!(
        { name: 'idx_u', columns: ['a', 'b'], unique: true },
        'customers'
      )
    ).toBe('CREATE UNIQUE INDEX IF NOT EXISTS idx_u ON customers (a, b);');
  });

  it('carries a partial-index filter through', () => {
    expect(
      sqliteSqlDialect.createIndexStatement!(
        { name: 'idx_active', columns: ['id'], unique: false, filter: 'active = 1' },
        'main.t'
      )
    ).toBe('CREATE INDEX IF NOT EXISTS main.idx_active ON t (id) WHERE active = 1;');
  });
});

describe('sqlite views', () => {
  const BODY = 'SELECT id FROM customers';

  it('creates a view without CREATE OR REPLACE, which SQLite rejects', () => {
    const sql = sqliteSqlDialect.createViewStatement!('v_customers', BODY);
    expect(sql).toBe(`CREATE VIEW IF NOT EXISTS v_customers AS\n${BODY}`);
    expect(sql).not.toMatch(/OR\s+REPLACE/i);
  });

  it('replaces a changed view by dropping it first — SQLite has no ALTER VIEW', () => {
    const sql = sqliteSqlDialect.alterViewStatement!('v_customers', BODY);
    expect(sql).toBe(`DROP VIEW IF EXISTS v_customers;\nCREATE VIEW v_customers AS\n${BODY}`);
    expect(sql).not.toMatch(/ALTER\s+VIEW/i);
    expect(sql).not.toMatch(/OR\s+REPLACE/i);
  });
});
