/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Registry of per-dialect account DDL strategies (`*.user-sql.ts`).
 */
import type { UserSqlDialect } from './user-sql.types.js';
import { unsupportedUserSqlDialect } from './user-sql-helpers.js';
import { postgresUserSql } from '../../providers/postgres/postgres.user-sql.js';
import { redshiftUserSql } from '../../providers/redshift/redshift.user-sql.js';
import { mysqlUserSql } from '../../providers/mysql/mysql.user-sql.js';
import { sqlServerUserSql } from '../../providers/sqlServer/sqlserver.user-sql.js';
import { oracleUserSql } from '../../providers/oracle/oracle.user-sql.js';
import { db2UserSql } from '../../providers/db2/db2.user-sql.js';
import { clickHouseUserSql } from '../../providers/clickHouse/clickhouse.user-sql.js';
import { cockroachDbUserSql } from '../../providers/cockroachDb/cockroachdb.user-sql.js';
import { yugabyteDbUserSql } from '../../providers/yugabyteDb/yugabytedb.user-sql.js';
import { tiDbUserSql } from '../../providers/tiDb/tidb.user-sql.js';
import { azureSqlUserSql } from '../../providers/azureSql/azuresql.user-sql.js';

const unsupportedSqlite = unsupportedUserSqlDialect('sqlite');
const unsupportedDuckdb = unsupportedUserSqlDialect('duckdb');
const unsupportedMongodb = unsupportedUserSqlDialect('mongodb');
const unsupportedRedis = unsupportedUserSqlDialect('redis');

/** Maps a dialect name (case-insensitive) to its account-DDL strategy. */
export const USER_SQL_MAP: Record<string, UserSqlDialect> = {
  postgres: postgresUserSql,
  cockroachdb: cockroachDbUserSql,
  yugabytedb: yugabyteDbUserSql,
  redshift: redshiftUserSql,
  mysql: mysqlUserSql,
  mariadb: mysqlUserSql,
  tidb: tiDbUserSql,
  sqlserver: sqlServerUserSql,
  azuresql: azureSqlUserSql,
  oracle: oracleUserSql,
  db2: db2UserSql,
  clickhouse: clickHouseUserSql,
  sqlite: unsupportedSqlite,
  duckdb: unsupportedDuckdb,
  mongodb: unsupportedMongodb,
  redis: unsupportedRedis,
};

/**
 * Resolve account DDL for a dialect id.
 * Unknown dialects are unsupported (no silent Postgres fallback).
 */
export function resolveUserSql(dialect: string): UserSqlDialect {
  const key = (dialect || '').toLowerCase();
  return USER_SQL_MAP[key] ?? unsupportedUserSqlDialect(key || 'unknown');
}
