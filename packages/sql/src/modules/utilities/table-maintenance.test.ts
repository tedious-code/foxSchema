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
});
