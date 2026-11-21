/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to its DBA utility probes. Unknown engines resolve to
 * nothing — the facade then reports "unsupported" rather than guessing SQL.
 */
import type { DbaUtilityDialect } from './dba-utilities.types.js';
import { postgresDbaUtilities } from '../../providers/postgres/postgres.dba-utilities.js';
import { cockroachDbDbaUtilities } from '../../providers/cockroachDb/cockroachdb.dba-utilities.js';
import { yugabyteDbDbaUtilities } from '../../providers/yugabyteDb/yugabytedb.dba-utilities.js';
import { mysqlDbaUtilities } from '../../providers/mysql/mysql.dba-utilities.js';
import { mariaDbDbaUtilities } from '../../providers/mariaDb/mariadb.dba-utilities.js';
import { tiDbDbaUtilities } from '../../providers/tiDb/tidb.dba-utilities.js';
import { sqlServerDbaUtilities } from '../../providers/sqlServer/sqlserver.dba-utilities.js';
import { azureSqlDbaUtilities } from '../../providers/azureSql/azuresql.dba-utilities.js';
import { oracleDbaUtilities } from '../../providers/oracle/oracle.dba-utilities.js';
import { db2DbaUtilities } from '../../providers/db2/db2.dba-utilities.js';
import { sqliteDbaUtilities } from '../../providers/sqlLite/sqlite.dba-utilities.js';
import { duckDbDbaUtilities } from '../../providers/duckDb/duckdb.dba-utilities.js';
import { clickHouseDbaUtilities } from '../../providers/clickHouse/clickhouse.dba-utilities.js';
import { redshiftDbaUtilities } from '../../providers/redshift/redshift.dba-utilities.js';

export const DBA_UTILITY_MAP: Record<string, DbaUtilityDialect> = {
  postgres: postgresDbaUtilities,
  cockroachdb: cockroachDbDbaUtilities,
  yugabytedb: yugabyteDbDbaUtilities,
  mysql: mysqlDbaUtilities,
  mariadb: mariaDbDbaUtilities,
  tidb: tiDbDbaUtilities,
  sqlserver: sqlServerDbaUtilities,
  azuresql: azureSqlDbaUtilities,
  oracle: oracleDbaUtilities,
  db2: db2DbaUtilities,
  sqlite: sqliteDbaUtilities,
  duckdb: duckDbDbaUtilities,
  clickhouse: clickHouseDbaUtilities,
  redshift: redshiftDbaUtilities,
};

export function resolveDbaUtilities(dialect: string): DbaUtilityDialect | undefined {
  return DBA_UTILITY_MAP[(dialect || '').toLowerCase()];
}
