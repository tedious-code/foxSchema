/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to its GRANT/REVOKE emitter. Unknown names use the
 * PostgreSQL shape — `warnForAccess` says so rather than pretending.
 */
import type { AccessSqlDialect } from './access-sql.types.js';
import { postgresAccessSql } from '../../providers/postgres/postgres.access-sql.js';
import { mysqlAccessSql } from '../../providers/mysql/mysql.access-sql.js';
import { sqlServerAccessSql } from '../../providers/sqlServer/sqlserver.access-sql.js';
import { azureSqlAccessSql } from '../../providers/azureSql/azuresql.access-sql.js';
import { oracleAccessSql } from '../../providers/oracle/oracle.access-sql.js';
import { db2AccessSql } from '../../providers/db2/db2.access-sql.js';
import { cockroachDbAccessSql } from '../../providers/cockroachDb/cockroachdb.access-sql.js';
import { yugabyteDbAccessSql } from '../../providers/yugabyteDb/yugabytedb.access-sql.js';
import { tiDbAccessSql } from '../../providers/tiDb/tidb.access-sql.js';

/** Maps a dialect name (case-insensitive) to its GRANT/REVOKE strategy. */
export const ACCESS_SQL_MAP: Record<string, AccessSqlDialect> = {
  postgres: postgresAccessSql,
  cockroachdb: cockroachDbAccessSql,
  yugabytedb: yugabyteDbAccessSql,
  // Redshift GRANT follows Postgres even though account DDL (GROUP) does not.
  redshift: postgresAccessSql,
  mysql: mysqlAccessSql,
  mariadb: mysqlAccessSql,
  tidb: tiDbAccessSql,
  sqlserver: sqlServerAccessSql,
  azuresql: azureSqlAccessSql,
  oracle: oracleAccessSql,
  db2: db2AccessSql,
};

/**
 * Resolve GRANT/REVOKE SQL for a dialect id.
 * Unregistered engines (ClickHouse, SQLite, …) use PostgreSQL syntax; the
 * facade warning tells the reader to check it.
 */
export function resolveAccessSql(dialect: string): AccessSqlDialect {
  const key = (dialect || '').toLowerCase();
  return ACCESS_SQL_MAP[key] ?? postgresAccessSql;
}
