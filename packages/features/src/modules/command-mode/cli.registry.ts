/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect to the client that runs its SQL.
 *
 * Several engines share a client, and they alias here rather than duplicating
 * an emitter: Redshift, CockroachDB and YugabyteDB all speak to psql; TiDB to
 * the mysql client; Azure SQL to sqlcmd. MariaDB has its own emitter because
 * recent images ship `mariadb` and no `mysql` symlink.
 */
import type { CliDialect } from './cli.types.js';
import { postgresCli } from '../../providers/postgres/postgres.cli.js';
import { mysqlCli } from '../../providers/mysql/mysql.cli.js';
import { mariaDbCli } from '../../providers/mariaDb/mariadb.cli.js';
import { sqlServerCli } from '../../providers/sqlServer/sqlserver.cli.js';
import { oracleCli } from '../../providers/oracle/oracle.cli.js';
import { db2Cli } from '../../providers/db2/db2.cli.js';
import { clickHouseCli } from '../../providers/clickHouse/clickhouse.cli.js';
import { sqliteCli } from '../../providers/sqlLite/sqlite.cli.js';
import { duckDbCli } from '../../providers/duckDb/duckdb.cli.js';

export const CLI_MAP: Record<string, CliDialect> = {
  postgres: postgresCli,
  redshift: postgresCli,
  cockroachdb: postgresCli,
  yugabytedb: postgresCli,
  mysql: mysqlCli,
  mariadb: mariaDbCli,
  tidb: mysqlCli,
  sqlserver: sqlServerCli,
  azuresql: sqlServerCli,
  oracle: oracleCli,
  db2: db2Cli,
  clickhouse: clickHouseCli,
  sqlite: sqliteCli,
  duckdb: duckDbCli,
};

/** The client for a dialect, or undefined when command mode has no emitter. */
export function cliFor(dialect: string): CliDialect | undefined {
  return CLI_MAP[(dialect || '').toLowerCase()];
}

/**
 * Whether command mode can offer anything for this dialect.
 *
 * False is a real answer, not a gap to paper over: MongoDB and Redis do not
 * take SQL, so there is no statement to hand to a client.
 */
export function supportsCommandMode(dialect: string): boolean {
  return cliFor(dialect) !== undefined;
}
