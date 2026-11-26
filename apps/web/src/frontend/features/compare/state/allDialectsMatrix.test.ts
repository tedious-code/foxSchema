/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Database Developer all-16-dialect feature & DDL matrix test:
 * Exercises connection string building, schema compare support, migration plan &
 * CREATE TABLE DDL generation, index maintenance SQL, table health/maintenance
 * support, and backup command generation across every registered dialect.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_SETTINGS,
  buildConnectionString,
  isFileDialect,
  backupSupport,
  buildBackupCommands,
  defaultBackupSettings,
  dialectSupportsDbaUtility,
  dialectSupportsIndexFragmentation,
  dialectSupportsTableMaintenance,
  buildIndexDefragSql,
  buildIndexDropSql,
  CROSS_DIALECT_READINESS,
  type Dialect,
} from '@foxschema/ui-shared';
import { SqlGeneratorModule } from '@/shared/lib/sql-generator';
import { schemaCompareBlocker } from '@/shared/lib/dialect-features';
import { invertTableDiff } from './syncHelpers';
import type { TableDiff, TableSchema } from '@/shared/lib/types';

const ALL_DIALECTS: Dialect[] = [
  'postgres',
  'cockroachdb',
  'yugabytedb',
  'redshift',
  'mysql',
  'mariadb',
  'tidb',
  'sqlite',
  'duckdb',
  'sqlserver',
  'azuresql',
  'oracle',
  'db2',
  'clickhouse',
  'redis',
  'mongodb',
];

const SQL_COMPARE_DIALECTS: Dialect[] = ALL_DIALECTS.filter(
  (d) => schemaCompareBlocker(d, d) === null,
);

const sampleOrdersTable: TableSchema = {
  name: 'orders',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'customer_email', type: 'VARCHAR(255)', nullable: false, primaryKey: false },
    { name: 'total_cents', type: 'BIGINT', nullable: false, primaryKey: false, defaultValue: '0' },
  ],
  indices: [
    { name: 'idx_orders_email', columns: ['customer_email'], unique: false },
  ],
  foreignKeys: [],
};

const sampleAddedTableDiff: TableDiff = {
  tableName: 'orders',
  objectType: 'TABLE',
  status: 'ADDED',
  sourceTable: sampleOrdersTable,
  columnDiffs: sampleOrdersTable.columns.map((c) => ({
    name: c.name,
    status: 'ADDED',
    source: c,
  })),
  indexDiffs: [
    {
      name: 'idx_orders_email',
      status: 'ADDED',
      source: sampleOrdersTable.indices![0],
    },
  ],
  foreignKeyDiffs: [],
};

describe('All-16-dialect Database Developer feature matrix', () => {
  it('registers all 16 dialects in PROVIDER_SETTINGS and builds valid connection strings', () => {
    expect(Object.keys(PROVIDER_SETTINGS).sort()).toEqual([...ALL_DIALECTS].sort());

    for (const dialect of ALL_DIALECTS) {
      const settings = PROVIDER_SETTINGS[dialect];
      expect(settings.dialect).toBe(dialect);
      expect(settings.label.length).toBeGreaterThan(0);

      const connStr = buildConnectionString(dialect, {
        host: 'db.internal',
        port: settings.defaultPort,
        database: isFileDialect(dialect) ? '/tmp/test.db' : 'app_db',
        username: 'dba',
        password: 'secret',
      });
      expect(typeof connStr).toBe('string');
      expect(connStr.length).toBeGreaterThan(0);
    }
  });

  it('generates CREATE TABLE object DDL and migration plans across all 14 SQL compare dialects', () => {
    const generator = new SqlGeneratorModule();
    // Redis and MongoDB are non-relational and report a schemaCompareBlocker; the 14 SQL engines do not.
    expect(SQL_COMPARE_DIALECTS.length).toBe(14);
    expect(schemaCompareBlocker('redis', 'redis')).toMatch(/Redis/i);
    expect(schemaCompareBlocker('mongodb', 'mongodb')).toMatch(/MongoDB/i);

    for (const dialect of SQL_COMPARE_DIALECTS) {
      const objectDdl = generator.generateObjectDdl(sampleOrdersTable, dialect);
      expect(objectDdl.toUpperCase()).toContain('CREATE TABLE');
      expect(objectDdl).toContain('orders');
      expect(objectDdl).toContain('customer_email');

      const plan = generator.generateMigrationPlan(
        [sampleAddedTableDiff],
        dialect,
        { sourceDialect: 'postgres', targetDialect: dialect },
        [sampleAddedTableDiff],
      );
      expect(plan.length).toBeGreaterThan(0);
      expect(plan[0]?.statements.join('\n').toUpperCase()).toContain('CREATE TABLE');

      // Rollback (Down) SQL for an ADDED table emits DROP TABLE across all 14 SQL dialects.
      const inverted = invertTableDiff(sampleAddedTableDiff);
      expect(inverted.status).toBe('REMOVED');
      const rollbackSql = generator.generateMigrationSql(
        [inverted],
        dialect,
        { sourceDialect: dialect },
        [inverted],
      );
      expect(rollbackSql.toUpperCase()).toContain('DROP TABLE');
    }
  });

  it('evaluates index maintenance, DBA utilities, and backup commands across all 16 dialects without throwing', () => {
    for (const dialect of ALL_DIALECTS) {
      const defragSql = buildIndexDefragSql({
        dialect,
        schema: 'public',
        table: 'orders',
        indexName: 'idx_orders_email',
        fragmentationPercent: 42,
      });
      expect(Array.isArray(defragSql)).toBe(true);

      const dropSql = buildIndexDropSql({
        dialect,
        schema: 'public',
        table: 'orders',
        indexName: 'idx_orders_email',
      });
      expect(Array.isArray(dropSql)).toBe(true);

      expect(typeof dialectSupportsIndexFragmentation(dialect).mode).toBe('string');
      expect(typeof dialectSupportsTableMaintenance(dialect).canInspectHealth).toBe('boolean');
      for (const kind of ['pool', 'sessions', 'system', 'sizes'] as const) {
        expect(typeof dialectSupportsDbaUtility(dialect, kind).mode).toBe('string');
      }

      const support = backupSupport(dialect);
      if (support) {
        const settings = defaultBackupSettings(dialect);
        const cmds = buildBackupCommands(
          {
            dialect,
            host: 'db.internal',
            port: PROVIDER_SETTINGS[dialect].defaultPort,
            database: 'app_db',
            schema: 'public',
            username: 'dba',
          },
          { ...settings, fileName: 'app_db_20261126', tables: [] },
        );
        expect(cmds).toBeTruthy();
      }
    }
    expect(CROSS_DIALECT_READINESS.length).toBeGreaterThan(0);
  });
});
