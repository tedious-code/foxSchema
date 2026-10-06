import type { SqlDialect } from './sql-dialect.interface.js';
import type { SqlDialectKey } from './sql-dialect-keys.js';
import { db2SqlDialect } from '../../providers/db2/db2.sql-dialect.js';
import { postgresSqlDialect } from '../../providers/postgres/postgres.sql-dialect.js';
import { mysqlSqlDialect, mariadbSqlDialect } from '../../providers/mysql/mysql.sql-dialect.js';
import { sqlServerSqlDialect } from '../../providers/sqlServer/sqlserver.sql-dialect.js';
import { oracleSqlDialect } from '../../providers/oracle/oracle.sql-dialect.js';
import { sqliteSqlDialect } from '../../providers/sqlLite/sqlite.sql-dialect.js';
import { redshiftSqlDialect } from '../../providers/redshift/redshift.sql-dialect.js';
import { clickHouseSqlDialect } from '../../providers/clickHouse/clickhouse.sql-dialect.js';
import { azureSqlDialect } from '../../providers/azureSql/azuresql.sql-dialect.js';
import { cockroachDbSqlDialect } from '../../providers/cockroachDb/cockroachdb.sql-dialect.js';
import { yugabyteDbSqlDialect } from '../../providers/yugabyteDb/yugabytedb.sql-dialect.js';
import { tiDbSqlDialect } from '../../providers/tiDb/tidb.sql-dialect.js';
import { duckDbSqlDialect } from '../../providers/duckDb/duckdb.sql-dialect.js';

/**
 * Maps a dialect name (case-insensitive) to its SQL generation strategy. Its keys
 * are exactly `SQL_DIALECT_KEYS` (checked by `satisfies` below).
 */
export const DIALECT_MAP: Record<string, SqlDialect> = {
  DB2: db2SqlDialect,
  POSTGRES: postgresSqlDialect,
  MYSQL: mysqlSqlDialect,
  MARIADB: mariadbSqlDialect,
  SQLSERVER: sqlServerSqlDialect,
  ORACLE: oracleSqlDialect,
  SQLITE: sqliteSqlDialect,
  REDSHIFT: redshiftSqlDialect,
  CLICKHOUSE: clickHouseSqlDialect,
  AZURESQL: azureSqlDialect,
  COCKROACHDB: cockroachDbSqlDialect,
  YUGABYTEDB: yugabyteDbSqlDialect,
  TIDB: tiDbSqlDialect,
  DUCKDB: duckDbSqlDialect,
} satisfies Record<SqlDialectKey, SqlDialect>;

/** Resolve a dialect name to its strategy, defaulting to Db2 for unknown names. */
export function resolveDialect(dialect: string): SqlDialect {
  return DIALECT_MAP[dialect.toUpperCase()] ?? db2SqlDialect;
}

/**
 * The same lookup, without the fallback.
 *
 * `resolveDialect` answers Db2 for a name it does not know, which ~20 call
 * sites depend on and which is not worth unpicking here. But a caller that
 * wants to *ask* whether an engine is known had no way to, so "is there a SQL
 * dialect for this?" was being hand-maintained as a list somewhere else and
 * drifting from this map. Now it can be derived.
 */
export function tryResolveDialect(dialect: string): SqlDialect | undefined {
  return DIALECT_MAP[(dialect || '').toUpperCase()];
}
