/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The engines Fox Schema generates SQL for, without loading their dialects.
 *
 * `DIALECT_MAP` in registry.ts holds the dialects themselves, and importing it
 * loads every engine's DDL code. A caller that only asks "does this engine have
 * a SQL dialect" (the compare button, on every first page) reads this list
 * instead. The registry declares its map with `satisfies Record<SqlDialectKey, …>`,
 * so a key missing from either side, or present in only one, fails the typecheck:
 * the two cannot drift.
 */
export const SQL_DIALECT_KEYS = [
  'DB2',
  'POSTGRES',
  'MYSQL',
  'MARIADB',
  'SQLSERVER',
  'ORACLE',
  'SQLITE',
  'REDSHIFT',
  'CLICKHOUSE',
  'AZURESQL',
  'COCKROACHDB',
  'YUGABYTEDB',
  'TIDB',
  'DUCKDB',
] as const;

export type SqlDialectKey = (typeof SQL_DIALECT_KEYS)[number];

/** Whether Fox Schema has a SQL dialect for this engine name (any case). */
export function hasSqlDialect(dialect: string): boolean {
  return (SQL_DIALECT_KEYS as readonly string[]).includes((dialect || '').toUpperCase());
}
