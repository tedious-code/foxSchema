/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildTableHealthProbeQuery,
  buildTableMaintenanceSql,
  dialectSupportsTableMaintenance,
  normalizeTableHealthRows,
} from './table-maintenance.js';

describe('table-maintenance utility', () => {
  it('reports capabilities accurately across dialects', () => {
    expect(dialectSupportsTableMaintenance('postgres')).toMatchObject({
      supported: true,
      canAnalyze: true,
      canVacuum: true,
      canInspectHealth: true,
    });
    expect(dialectSupportsTableMaintenance('mysql')).toMatchObject({
      supported: true,
      canAnalyze: true,
      canVacuum: false,
      canOptimize: true,
    });
    expect(dialectSupportsTableMaintenance('unknown').supported).toBe(false);
  });

  it('builds dialect-specific table health probes', () => {
    const pg = buildTableHealthProbeQuery('postgres', 'public');
    expect('sql' in pg && pg.sql).toContain('pg_stat_user_tables');
    expect('sql' in pg && pg.params).toEqual(['public']);

    const my = buildTableHealthProbeQuery('mysql', 'shop');
    expect('sql' in my && my.sql).toContain('DATA_FREE');
    expect('sql' in my && my.params).toEqual(['shop']);

    const mssql = buildTableHealthProbeQuery('sqlserver', 'dbo');
    expect('sql' in mssql && mssql.sql).toContain('dm_db_stats_properties');

    const sqlite = buildTableHealthProbeQuery('sqlite');
    expect('sql' in sqlite && sqlite.sql).toContain('sqlite_master');
  });

  it('normalizes health rows and computes deadRatioPct', () => {
    const rows = normalizeTableHealthRows([
      {
        schema_name: 'public',
        table_name: 'orders',
        live_rows: 800,
        dead_rows: 200,
        bloat_bytes: null,
        stale_stats: false,
        last_analyzed: '2026-11-15T10:00:00Z',
        last_vacuumed: null,
      },
    ]);
    expect(rows).toEqual([
      {
        schemaName: 'public',
        tableName: 'orders',
        liveRows: 800,
        deadRows: 200,
        deadRatioPct: 20,
        bloatBytes: null,
        staleStats: false,
        lastAnalyzed: '2026-11-15T10:00:00Z',
        lastVacuumed: null,
      },
    ]);
  });

  it('generates safe dialect-specific maintenance SQL', () => {
    expect(buildTableMaintenanceSql('postgres', 'vacuum', { schema: 'public', table: 'orders' })).toMatchObject({
      sql: 'VACUUM (ANALYZE) "public"."orders";',
    });
    expect(buildTableMaintenanceSql('postgres', 'analyze', { schema: 'public', table: 'orders' })).toMatchObject({
      sql: 'ANALYZE "public"."orders";',
    });
    expect(buildTableMaintenanceSql('mysql', 'optimize', { schema: 'shop', table: 'orders' })).toMatchObject({
      sql: 'OPTIMIZE TABLE `shop`.`orders`;',
    });
    expect(buildTableMaintenanceSql('sqlserver', 'analyze', { schema: 'dbo', table: 'orders' })).toMatchObject({
      sql: 'UPDATE STATISTICS [dbo].[orders];',
    });
    expect(buildTableMaintenanceSql('sqlite', 'vacuum', { schema: 'main', table: 'orders' })).toMatchObject({
      sql: 'VACUUM;',
    });
    expect(buildTableMaintenanceSql('clickhouse', 'optimize', { schema: 'analytics', table: 'events' })).toMatchObject({
      sql: 'OPTIMIZE TABLE `analytics`.`events` FINAL;',
    });
    expect('error' in buildTableMaintenanceSql('postgres', 'analyze', { table: 'bad\nname' })).toBe(true);
  });

  it('sends Oracle one PL/SQL block per action, keeping identifier case', () => {
    // node-oracledb runs one statement per call and rejects `;` after plain SQL.
    const shrink = buildTableMaintenanceSql('oracle', 'vacuum', { schema: 'HR', table: 'Orders' });
    expect(shrink).toMatchObject({
      sql:
        `BEGIN EXECUTE IMMEDIATE 'ALTER TABLE "HR"."Orders" ENABLE ROW MOVEMENT'; ` +
        `EXECUTE IMMEDIATE 'ALTER TABLE "HR"."Orders" SHRINK SPACE COMPACT'; END;`,
    });
    expect(buildTableMaintenanceSql('oracle', 'analyze', { schema: 'HR', table: 'Orders' })).toMatchObject({
      sql: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => '"HR"', tabname => '"Orders"'); END;`,
    });
    // No schema: the session user, not a schema named 'USER'.
    expect(buildTableMaintenanceSql('oracle', 'analyze', { table: 'ORDERS' })).toMatchObject({
      sql: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => USER, tabname => '"ORDERS"'); END;`,
    });
    const quoted = buildTableMaintenanceSql('oracle', 'analyze', { schema: 'HR', table: "o'rders" });
    expect('sql' in quoted && quoted.sql).toContain(`tabname => '"o''rders"'`);
  });

  it('runs DB2 REORG and RUNSTATS through ADMIN_CMD with a quoted, escaped name', () => {
    expect(buildTableMaintenanceSql('db2', 'optimize', { schema: 'SHOP', table: 'ORDERS' })).toMatchObject({
      sql: `CALL SYSPROC.ADMIN_CMD('REORG TABLE "SHOP"."ORDERS"')`,
    });
    expect(buildTableMaintenanceSql('db2', 'analyze', { schema: 'SHOP', table: 'ORDERS' })).toMatchObject({
      sql: `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "SHOP"."ORDERS" WITH DISTRIBUTION AND DETAILED INDEXES ALL')`,
    });
    const hostile = buildTableMaintenanceSql('db2', 'analyze', { schema: 'SHOP', table: "X'); DROP TABLE T; --" });
    expect('sql' in hostile && hostile.sql).toContain(`"X''); DROP TABLE T; --"`);
    expect('error' in buildTableMaintenanceSql('db2', 'analyze', { table: 'ORDERS' })).toBe(true);
  });

  it('uses the $1 placeholder the ClickHouse adapter substitutes', () => {
    const ch = buildTableHealthProbeQuery('clickhouse', 'analytics');
    expect('sql' in ch && ch.sql).toContain('database = $1');
    expect('sql' in ch && ch.sql).not.toContain('?');
  });

  it('counts SQL Server rows without repeating them per statistics object', () => {
    const mssql = buildTableHealthProbeQuery('sqlserver', 'dbo');
    // The live-row sum must not share a FROM with sys.stats (#613 review: a
    // 3-row table with two extra statistics reported 9 rows).
    expect('sql' in mssql && mssql.sql).toMatch(/SELECT SUM\(p\.rows\) AS live_rows\s+FROM sys\.partitions p\s+WHERE/);
    expect('sql' in mssql && mssql.sql).not.toMatch(/GROUP BY s\.name, t\.name/);
  });

  it('does not present MySQL UPDATE_TIME as the last analyze', () => {
    const mysql = buildTableHealthProbeQuery('mysql', 'shop');
    expect('sql' in mysql && mysql.sql).toContain('NULL AS last_analyzed');
    expect('sql' in mysql && mysql.sql).not.toMatch(/UPDATE_TIME[^\n]*\bAS\b/);
  });
});
