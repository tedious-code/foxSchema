/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildDbaUtilityQuery,
  dialectSupportsDbaUtility,
  filterTableSizeGroups,
  formatBytes,
  formatPct,
  formatRowCount,
  groupObjectSizes,
  lookupIndexSizeRow,
  indexTableSizeGroups,
  lookupTableSizeGroup,
  normalizeConnectionPoolRows,
  normalizeObjectSizeRows,
  normalizeSystemInfoRows,
  normalizeUserSessionRows,
  type ObjectSizeRow,
} from './dba-utilities.js';

describe('dialect-dba-utilities', () => {
  /**
   * Postgres reports `pg_class.reltuples` as -1 until a relation has been
   * ANALYZEd. It is a sentinel for "never counted", and it used to reach the
   * screen verbatim: a freshly created table read "-1 rows" in the schema
   * explorer and in Index Management. `formatRowCount` already prints null as
   * an em dash, so the sentinel belongs on the null side of the boundary.
   */
  it('reads a negative row count as unknown, not as a count', () => {
    const [neverAnalyzed] = normalizeObjectSizeRows([
      { schema_name: 'public', object_name: 'fresh', object_type: 'table', row_count: -1 },
    ]);
    expect(neverAnalyzed!.rowCount).toBeNull();
    expect(formatRowCount(neverAnalyzed!.rowCount)).toBe('—');

    // A real count, including a legitimately empty table, still comes through.
    const [empty] = normalizeObjectSizeRows([
      { schema_name: 'public', object_name: 'empty', object_type: 'table', row_count: 0 },
    ]);
    expect(empty!.rowCount).toBe(0);
    expect(formatRowCount(empty!.rowCount)).toBe('0');
  });

  it('reports support for major dialects and kinds', () => {
    expect(dialectSupportsDbaUtility('postgres', 'pool').query).toBe(true);
    expect(dialectSupportsDbaUtility('mysql', 'sessions').query).toBe(true);
    expect(dialectSupportsDbaUtility('sqlserver', 'system').query).toBe(true);
    expect(dialectSupportsDbaUtility('sqlite', 'sizes').query).toBe(true);
    expect(dialectSupportsDbaUtility('sqlite', 'pool').query).toBe(false);
    expect(dialectSupportsDbaUtility('duckdb', 'sessions').query).toBe(false);
  });

  it('builds pool / sessions / system / sizes queries', () => {
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'sqlite'] as const) {
      for (const kind of ['pool', 'sessions', 'system', 'sizes'] as const) {
        const support = dialectSupportsDbaUtility(dialect, kind);
        const q = buildDbaUtilityQuery({ dialect, kind, schema: 'public' });
        if (!support.query) {
          expect('error' in q).toBe(true);
        } else {
          expect('sql' in q).toBe(true);
          if ('sql' in q) expect(q.sql.length).toBeGreaterThan(20);
        }
      }
    }
  });

  it('normalizes pool / sessions / system / sizes rows', () => {
    expect(
      normalizeConnectionPoolRows([
        { max_connections: 100, current_connections: 12, active_connections: 3 },
      ])
    ).toMatchObject({
      maxConnections: 100,
      currentConnections: 12,
      activeConnections: 3,
      availableConnections: 88,
    });

    expect(
      normalizeUserSessionRows([{ session_id: '1', user_name: 'alice', state: 'active' }])
    ).toEqual([
      expect.objectContaining({ sessionId: '1', userName: 'alice', state: 'active' }),
    ]);

    expect(
      normalizeSystemInfoRows([
        {
          cpu_count: 8,
          memory_total_bytes: 16_000_000_000,
          memory_available_bytes: 4_000_000_000,
          storage_used_bytes: 1_000,
          server_version: 'PostgreSQL 16',
        },
      ])
    ).toMatchObject({
      cpuCount: 8,
      memoryUsedBytes: 12_000_000_000,
      serverVersion: 'PostgreSQL 16',
    });

    expect(
      normalizeObjectSizeRows([
        {
          schema_name: 'public',
          object_name: 'users',
          object_type: 'table',
          total_bytes: 4096,
          row_count: 10,
        },
      ])
    ).toEqual([
      expect.objectContaining({
        schemaName: 'public',
        objectName: 'users',
        objectType: 'table',
        totalBytes: 4096,
        rowCount: 10,
      }),
    ]);
  });

  it('formats bytes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats row counts', () => {
    expect(formatRowCount(null)).toBe('—');
    expect(formatRowCount(12_345)).toBe('12,345');
  });

  it('groups size rows under tables and sums index bytes when the table row has none', () => {
    const rows: ObjectSizeRow[] = [
      {
        schemaName: 'public',
        objectName: 'PK_ORDERS',
        objectType: 'table',
        tableName: 'ORDERS',
        totalBytes: 8_192,
        dataBytes: 8_192,
        indexBytes: 0,
        rowCount: 100,
      },
      {
        schemaName: 'public',
        objectName: 'IX_ORDERS_EMAIL',
        objectType: 'index',
        tableName: 'ORDERS',
        totalBytes: 2_048,
        dataBytes: null,
        indexBytes: 2_048,
        rowCount: 100,
      },
      {
        schemaName: 'public',
        objectName: 'customers',
        objectType: 'table',
        tableName: 'customers',
        totalBytes: 16_384,
        dataBytes: 12_000,
        indexBytes: 4_384,
        rowCount: 50,
      },
    ];
    const groups = groupObjectSizes(rows);
    expect(groups.map((g) => g.tableName)).toEqual(['customers', 'ORDERS']);
    const orders = lookupTableSizeGroup(groups, 'ORDERS', 'public');
    expect(orders).toMatchObject({
      rowCount: 100,
      dataBytes: 8_192,
      indexBytes: 2_048,
    });
    expect(lookupIndexSizeRow(orders, 'IX_ORDERS_EMAIL')?.totalBytes).toBe(2_048);
    const customers = lookupTableSizeGroup(groups, 'CUSTOMERS');
    expect(customers?.indexBytes).toBe(4_384);

    const filtered = filterTableSizeGroups(groups, 'email');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tableName).toBe('ORDERS');
    expect(filtered[0]?.indexes).toHaveLength(1);
  });

  it('indexes size groups once with the same matching as a single lookup', () => {
    const group = (schemaName: string | null, tableName: string, rowCount: number) => ({
      schemaName,
      tableName,
      rowCount,
      dataBytes: 0,
      indexBytes: 0,
      totalBytes: 0,
      indexes: [],
    });
    const groups = [group('sales', 'Orders', 1), group('public', 'ORDERS', 2), group(null, 'items', 3)];
    const sizeOf = indexTableSizeGroups(groups);
    // An exact schema match wins over the first table of that name, in any case.
    expect(sizeOf('orders', 'PUBLIC')?.rowCount).toBe(2);
    // No schema, or a schema with no match: the first table of that name.
    expect(sizeOf('orders')?.rowCount).toBe(1);
    expect(sizeOf('orders', 'archive')?.rowCount).toBe(1);
    expect(sizeOf('ITEMS', 'public')?.rowCount).toBe(3);
    expect(sizeOf('missing')).toBeUndefined();
    for (const [t, s] of [['orders', 'PUBLIC'], ['orders', undefined], ['items', 'x'], ['nope', null]] as const) {
      expect(sizeOf(t, s)).toBe(lookupTableSizeGroup(groups, t, s));
    }
  });

  it('builds DB2 sizes with total >= data and index rows', () => {
    const q = buildDbaUtilityQuery({ dialect: 'db2', kind: 'sizes', schema: 'CARTER' });
    expect('sql' in q).toBe(true);
    if (!('sql' in q)) return;
    expect(q.sql).toMatch(/FPAGES/);
    expect(q.sql).toMatch(/NLEAF/);
    expect(q.sql).toMatch(/PAGESIZE/);
    expect(q.sql).toMatch(/'index'/);
    expect(q.params).toEqual(['CARTER', 'CARTER']);
  });
});

describe('DB2 session query columns', () => {
  it('does not select SESSION_DB_PARTITION_NUM', () => {
    // MON_GET_CONNECTION has no such column. DB2 answers SQL0206N, so the
    // Sessions utility failed for every DB2 user until this was corrected.
    const built = buildDbaUtilityQuery({ dialect: 'db2', kind: 'sessions' });
    expect('error' in built).toBe(false);
    const sql = (built as { sql: string }).sql;
    expect(sql).not.toContain('SESSION_DB_PARTITION_NUM');
    // Verified live on DB2 11.5: this returns the database, which is what the
    // column claims to be — a partition number was wrong for it regardless.
    expect(sql).toContain('CURRENT SERVER AS database_name');
  });
});

describe('MariaDB is not a MySQL alias for these probes', () => {
  /**
   * Both bugs verified against MariaDB 11.8:
   *
   *   SELECT @@innodb_buffer_pool_instances;
   *     ERROR 1193 (HY000): Unknown system variable
   *   SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE ...
   *     (empty — performance_schema is off by default)
   *   SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE ...
   *     245412
   *
   * The first killed System info outright. The second was worse: no error, a
   * blank connection count in the pool panel.
   */
  const sqlFor = (kind: 'pool' | 'sessions' | 'system' | 'sizes') => {
    const q = buildDbaUtilityQuery({ dialect: 'mariadb', kind, schema: 'foxdb' });
    if ('error' in q) throw new Error(`${kind}: ${q.error}`);
    return q.sql;
  };

  it('does not reference a system variable MariaDB removed in 10.5', () => {
    expect(sqlFor('system')).not.toMatch(/innodb_buffer_pool_instances/);
  });

  it('reads status from information_schema, which MariaDB populates by default', () => {
    for (const kind of ['pool', 'system'] as const) {
      expect(sqlFor(kind), kind).toMatch(/information_schema\.GLOBAL_STATUS/i);
      expect(sqlFor(kind), kind).not.toMatch(/performance_schema\.global_status/i);
    }
  });

  it('still answers every utility kind rather than erroring on an unknown family', () => {
    // Splitting mariadb out of the mysql family is what would break these.
    for (const kind of ['pool', 'sessions', 'system', 'sizes'] as const) {
      expect(sqlFor(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('keeps buffer pool size and uptime, which MariaDB does have', () => {
    const sql = sqlFor('system');
    expect(sql).toMatch(/innodb_buffer_pool_size/);
    expect(sql).toMatch(/'Uptime'/);
  });

  it('leaves MySQL itself on the performance_schema path', () => {
    const q = buildDbaUtilityQuery({ dialect: 'mysql', kind: 'pool' });
    if ('error' in q) throw new Error(q.error);
    expect(q.sql).toMatch(/performance_schema\.global_status/i);
  });
});

describe('Server Insights probes the engines actually accept', () => {
  /**
   * Every failure quoted below was reproduced against a live server. All four
   * probes now run clean on postgres, mysql, mariadb, sqlserver, oracle, db2,
   * cockroachdb, yugabytedb, clickhouse and tidb.
   *
   * Redshift is deliberately absent: the local stand-in is Postgres, which has
   * no stv_/svv_ views, so those queries cannot be validated here either way.
   */
  const sqlFor = (dialect: string, kind: 'pool' | 'sessions' | 'system' | 'sizes') => {
    const q = buildDbaUtilityQuery({ dialect, kind, schema: 'demo_a' });
    if ('error' in q) throw new Error(`${dialect}/${kind}: ${q.error}`);
    // Comments explain the fixes and name the wrong functions on purpose, so
    // assertions have to look at the statement, not the prose around it.
    return q.sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
  };

  it('CockroachDB does not call pg_postmaster_start_time', () => {
    // "unknown function: pg_postmaster_start_time()" killed the whole System
    // tab; Cockroach answers everything else in that query.
    const sql = sqlFor('cockroachdb', 'system');
    expect(sql).not.toMatch(/pg_postmaster_start_time/);
    expect(sql).toMatch(/NULL::bigint AS uptime_seconds/);
    // Real Postgres keeps it.
    expect(sqlFor('postgres', 'system')).toMatch(/pg_postmaster_start_time/);
  });

  it('TiDB reads status variables from information_schema', () => {
    // "SELECT command denied to user ... for table 'global_status'" — TiDB does
    // not expose performance_schema.global_status.
    for (const kind of ['pool', 'system'] as const) {
      const sql = sqlFor('tidb', kind);
      expect(sql).toMatch(/information_schema\.global_status/);
      expect(sql).not.toMatch(/performance_schema\.global_status/);
    }
    // MySQL 8 is the other way round and must keep performance_schema.
    expect(sqlFor('mysql', 'pool')).toMatch(/performance_schema\.global_status/);
  });

  it('ClickHouse casts numeric metrics instead of parsing them as strings', () => {
    // "Illegal type Float64 of first argument of function toInt64OrNull" —
    // asynchronous_metrics.value is Float64, and the *OrNull family takes a
    // String. The whole System tab failed on it.
    const sql = sqlFor('clickhouse', 'system');
    expect(sql).not.toMatch(/toInt64OrNull|toFloat64OrNull/);
    expect(sql).toMatch(/Nullable\(Int64\)/);
    expect(sql).toMatch(/Nullable\(Float64\)/);
  });

  it('ClickHouse keeps toInt64OrNull where the column really is a String', () => {
    // system.settings.value is a String, so the pool probe was always correct —
    // the fix must not be applied indiscriminately.
    expect(sqlFor('clickhouse', 'pool')).toMatch(/toInt64OrNull/);
  });
});

describe('formatPct', () => {
  it('keeps one decimal under 10 and rounds above', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(Number.NaN)).toBe('—');
    expect(formatPct(3.14159)).toBe('3.1%');
    expect(formatPct(42.6)).toBe('43%');
  });
});

describe('DuckDB probes', () => {
  it('answers System from its own threads, memory and block storage', () => {
    expect(dialectSupportsDbaUtility('duckdb', 'system').query).toBe(true);
    const built = buildDbaUtilityQuery({ dialect: 'duckdb', kind: 'system' });
    expect('sql' in built && built.sql).toMatch(/pragma_database_size\(\)/);
    expect('sql' in built && built.sql).toMatch(/AS server_version/);
  });

  it('reports estimated_size as rows, never as bytes', () => {
    // duckdb_tables().estimated_size is a row estimate; it was once shown as
    // total/data bytes too.
    const built = buildDbaUtilityQuery({ dialect: 'duckdb', kind: 'sizes' });
    const sql = 'sql' in built ? built.sql : '';
    expect(sql).toMatch(/estimated_size AS row_count/);
    expect(sql).not.toMatch(/estimated_size AS (total|data)_bytes/);
  });
});
