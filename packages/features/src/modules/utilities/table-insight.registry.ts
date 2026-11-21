/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to its catalog-only table-insight probe.
 */
import type { TableInsightDialect } from './table-insight.types.js';
import { postgresTableInsight } from '../../providers/postgres/postgres.table-insight.js';
import { cockroachDbTableInsight } from '../../providers/cockroachDb/cockroachdb.table-insight.js';
import { yugabyteDbTableInsight } from '../../providers/yugabyteDb/yugabytedb.table-insight.js';
import { mysqlTableInsight } from '../../providers/mysql/mysql.table-insight.js';
import { mariaDbTableInsight } from '../../providers/mariaDb/mariadb.table-insight.js';
import { tiDbTableInsight } from '../../providers/tiDb/tidb.table-insight.js';
import { sqlServerTableInsight } from '../../providers/sqlServer/sqlserver.table-insight.js';
import { azureSqlTableInsight } from '../../providers/azureSql/azuresql.table-insight.js';
import { oracleTableInsight } from '../../providers/oracle/oracle.table-insight.js';
import { db2TableInsight } from '../../providers/db2/db2.table-insight.js';
import { sqliteTableInsight } from '../../providers/sqlLite/sqlite.table-insight.js';
import { duckDbTableInsight } from '../../providers/duckDb/duckdb.table-insight.js';
import { clickHouseTableInsight } from '../../providers/clickHouse/clickhouse.table-insight.js';
import { redshiftTableInsight } from '../../providers/redshift/redshift.table-insight.js';

export const TABLE_INSIGHT_MAP: Record<string, TableInsightDialect> = {
  postgres: postgresTableInsight,
  cockroachdb: cockroachDbTableInsight,
  yugabytedb: yugabyteDbTableInsight,
  mysql: mysqlTableInsight,
  mariadb: mariaDbTableInsight,
  tidb: tiDbTableInsight,
  sqlserver: sqlServerTableInsight,
  azuresql: azureSqlTableInsight,
  oracle: oracleTableInsight,
  db2: db2TableInsight,
  sqlite: sqliteTableInsight,
  duckdb: duckDbTableInsight,
  clickhouse: clickHouseTableInsight,
  redshift: redshiftTableInsight,
};

export function resolveTableInsight(dialect: string): TableInsightDialect | undefined {
  return TABLE_INSIGHT_MAP[(dialect || '').toLowerCase()];
}
