/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which engines have user-defined types Fox can plan a drop for. The MySQL
 * family, SQLite, ClickHouse and Redshift have no standalone types, so they
 * are not here and the planner says so.
 */
import type { TypeDropDialect } from './type-drop.types.js';
import { postgresTypeDrop } from '../../providers/postgres/postgres.type-drop.js';
import { cockroachDbTypeDrop } from '../../providers/cockroachDb/cockroachdb.type-drop.js';
import { yugabyteDbTypeDrop } from '../../providers/yugabyteDb/yugabytedb.type-drop.js';
import { sqlServerTypeDrop } from '../../providers/sqlServer/sqlserver.type-drop.js';
import { azureSqlTypeDrop } from '../../providers/azureSql/azuresql.type-drop.js';
import { duckDbTypeDrop } from '../../providers/duckDb/duckdb.type-drop.js';
import { db2TypeDrop } from '../../providers/db2/db2.type-drop.js';
import { oracleTypeDrop } from '../../providers/oracle/oracle.type-drop.js';

export const TYPE_DROP_MAP: Record<string, TypeDropDialect> = {
  postgres: postgresTypeDrop,
  cockroachdb: cockroachDbTypeDrop,
  yugabytedb: yugabyteDbTypeDrop,
  sqlserver: sqlServerTypeDrop,
  azuresql: azureSqlTypeDrop,
  duckdb: duckDbTypeDrop,
  db2: db2TypeDrop,
  oracle: oracleTypeDrop,
};

export function resolveTypeDrop(dialect: string): TypeDropDialect | undefined {
  return TYPE_DROP_MAP[(dialect || '').toLowerCase()];
}

/** Whether this engine has user-defined types Fox can plan a drop for. */
export function dialectSupportsTypeDrop(dialect: string): boolean {
  return resolveTypeDrop(dialect) !== undefined;
}
