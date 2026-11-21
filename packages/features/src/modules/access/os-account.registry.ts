/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which engines have OS-account steps, and which say plainly that they do not.
 *
 * "Not applicable" is answered here rather than left blank: someone asking the
 * question deserves to know that a Linux account would do nothing for a SQL
 * Server login, instead of seeing an empty panel and guessing.
 */
import type { OsAccountContext, OsAccountDialect, OsAccountSteps } from './os-account.types.js';
import { notApplicable } from './os-account-helpers.js';
import { postgresOsAccount } from '../../providers/postgres/postgres.os-account.js';
import { mysqlOsAccount } from '../../providers/mysql/mysql.os-account.js';
import { oracleOsAccount } from '../../providers/oracle/oracle.os-account.js';
import { sqliteOsAccount } from '../../providers/sqlLite/sqlite.os-account.js';

/** Engines with nothing to add here, and the reason each. */
const NO_OS_ROLE: Record<string, string> = {
  // Not "no OS account" — the opposite. Db2 has no user store of its own, so
  // the OS account *is* the account, and the full procedure covers it.
  db2:
    'Db2 authenticates against the operating system, so its OS account is not an optional extra — Add user (OS) already emits the whole procedure, including GRANT CONNECT.',
  sqlserver:
    'SQL Server on Linux authenticates with its own logins, or with Active Directory. A local Linux account plays no part, so creating one would do nothing.',
  azuresql:
    'Azure SQL authenticates with its own logins or Microsoft Entra ID. There is no host you could add a Linux account to.',
  clickhouse:
    'ClickHouse keeps its users in its own configuration and system tables. A Linux account is not consulted.',
  redshift:
    'Redshift is managed by AWS — there is no server to add a Linux account to. Access is the database user plus IAM.',
  cockroachdb:
    'CockroachDB authenticates with certificates or passwords it holds itself, not with OS accounts.',
  yugabytedb:
    'YugabyteDB follows Postgres for SQL but does not ship peer authentication as a default, so an OS account is not normally consulted.',
};

const MAP: Record<string, OsAccountDialect> = {
  postgres: postgresOsAccount,
  mysql: mysqlOsAccount,
  mariadb: mysqlOsAccount,
  tidb: mysqlOsAccount,
  oracle: oracleOsAccount,
  sqlite: sqliteOsAccount,
  duckdb: sqliteOsAccount,
};

/**
 * The OS-account steps for a dialect.
 *
 * Db2 is deliberately absent: its OS account is not an optional extra, it is
 * the account, and `buildDb2OsUserInstructions` already emits the whole
 * procedure including GRANT CONNECT.
 */
export function osAccountSteps(dialect: string, ctx: OsAccountContext): OsAccountSteps {
  const key = (dialect || '').toLowerCase();
  const reason = NO_OS_ROLE[key];
  if (reason) return notApplicable(reason);
  const impl = MAP[key];
  if (!impl) {
    return notApplicable(
      `Fox Schema does not know whether ${dialect || 'this engine'} can authenticate against the operating system, so it will not suggest an account that may do nothing.`
    );
  }
  return impl.steps(ctx);
}
