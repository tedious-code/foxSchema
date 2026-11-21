/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildTableInsightQuery,
  dialectSupportsTableInsight,
  normalizeTableInsightRows,
  tableInsightDialectIds,
  type TableInsightQuery,
} from './table-insight';

describe('table insight probes', () => {
  it('offers a catalog probe for every registered dialect', () => {
    const ids = tableInsightDialectIds();
    expect(ids.length).toBeGreaterThan(8);
    for (const dialect of ids) {
      const support = dialectSupportsTableInsight(dialect);
      expect(support.query).toBe(true);
      const q = buildTableInsightQuery({ dialect, schema: 'public', table: 'orders' });
      expect(q).toHaveProperty('sql');
      if ('sql' in q) {
        expect(q.sql).not.toMatch(/count\s*\(\s*distinct/i);
        expect(q.sql.toLowerCase()).not.toContain('count(distinct');
      }
    }
  });

  it('fails closed without a table name', () => {
    expect(buildTableInsightQuery({ dialect: 'postgres', table: '  ' })).toEqual({
      error: 'table is required.',
    });
  });

  it('uses pg_stats on postgres and sqlite_stat1 on sqlite', () => {
    const pg = buildTableInsightQuery({ dialect: 'postgres', schema: 'app', table: 't' });
    expect(pg).toMatchObject({ params: ['app', 't'] });
    if ('sql' in pg) expect(pg.sql.toLowerCase()).toContain('pg_stats');
    const lite = buildTableInsightQuery({ dialect: 'sqlite', table: 't' });
    if ('sql' in lite) expect(lite.sql.toLowerCase()).toContain('sqlite_stat1');
  });
});

describe('table size', () => {
  it('asks Postgres for exact bytes, table plus indexes', () => {
    const q = buildTableInsightQuery({ dialect: 'postgres', schema: 'public', table: 'orders' });
    expect('error' in q).toBe(false);
    expect((q as TableInsightQuery).sql).toContain('pg_total_relation_size(c.oid) AS size_bytes');
  });

  it('does not ask Redshift for a function it does not have', () => {
    // The "redshift" service used by e2e is a real Postgres, so baking the
    // Postgres expression into the shared factory would pass every test in this
    // repo and fail on an actual warehouse. Size lives in SVV_TABLE_INFO there.
    const q = buildTableInsightQuery({ dialect: 'redshift', schema: 'public', table: 'orders' });
    expect((q as TableInsightQuery).sql).not.toContain('pg_total_relation_size');
    expect((q as TableInsightQuery).sql).toContain('NULL AS size_bytes');
  });

  it('does not ask CockroachDB either — its version of the function is a stub', () => {
    // Measured on v26.3.0: the call is accepted and returns NULL. Shipping it
    // would spend a round trip to learn nothing, and the support hint would
    // imply a size the engine never gives.
    const q = buildTableInsightQuery({ dialect: 'cockroachdb', schema: 'public', table: 'orders' });
    expect((q as TableInsightQuery).sql).toContain('NULL AS size_bytes');
  });

  it('keeps the Postgres expression for YugabyteDB', () => {
    // Unverified against a live node — its container would not start here — so
    // it stays on the Postgres path. If the function is absent or stubbed there
    // too, the column comes back null and the card reads "Not reported", which
    // is the same graceful answer as an opt-out.
    const q = buildTableInsightQuery({ dialect: 'yugabytedb', schema: 'public', table: 'orders' });
    expect((q as TableInsightQuery).sql).toContain('pg_total_relation_size');
  });

  it('reads size from the engine on the MySQL and SQL Server families', () => {
    for (const dialect of ['mysql', 'mariadb', 'tidb']) {
      const q = buildTableInsightQuery({ dialect, schema: 'app', table: 'orders' });
      expect((q as TableInsightQuery).sql, dialect).toContain('DATA_LENGTH + t.INDEX_LENGTH');
    }
    for (const dialect of ['sqlserver', 'azuresql']) {
      const q = buildTableInsightQuery({ dialect, schema: 'dbo', table: 'orders' });
      expect((q as TableInsightQuery).sql, dialect).toContain('used_page_count');
    }
  });

  it('normalizes the size column, and reports null when the engine sent none', () => {
    expect(
      normalizeTableInsightRows('postgres', [
        { column_name: 'id', estimated_rows: 10, size_bytes: 8192 },
      ]).sizeBytes
    ).toBe(8192);
    // A dialect that opted out sends NULL; that has to stay null rather than
    // becoming 0, which would render as a real "0 B" table.
    expect(
      normalizeTableInsightRows('redshift', [
        { column_name: 'id', estimated_rows: 10, size_bytes: null },
      ]).sizeBytes
    ).toBeNull();
  });
});
