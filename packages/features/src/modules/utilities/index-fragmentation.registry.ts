/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to its index fragmentation probes and maintenance SQL.
 * Unknown engines resolve to nothing; the facade then offers the generic
 * listing probe and custom SQL.
 */
import type { IndexFragmentationDialect } from './index-fragmentation.types.js';
import { postgresIndexFragmentation } from '../../providers/postgres/postgres.index-fragmentation.js';
import { cockroachDbIndexFragmentation } from '../../providers/cockroachDb/cockroachdb.index-fragmentation.js';
import { yugabyteDbIndexFragmentation } from '../../providers/yugabyteDb/yugabytedb.index-fragmentation.js';
import { mysqlIndexFragmentation } from '../../providers/mysql/mysql.index-fragmentation.js';
import { mariaDbIndexFragmentation } from '../../providers/mariaDb/mariadb.index-fragmentation.js';
import { tiDbIndexFragmentation } from '../../providers/tiDb/tidb.index-fragmentation.js';
import { sqlServerIndexFragmentation } from '../../providers/sqlServer/sqlserver.index-fragmentation.js';
import { azureSqlIndexFragmentation } from '../../providers/azureSql/azuresql.index-fragmentation.js';
import { oracleIndexFragmentation } from '../../providers/oracle/oracle.index-fragmentation.js';
import { db2IndexFragmentation } from '../../providers/db2/db2.index-fragmentation.js';
import { sqliteIndexFragmentation } from '../../providers/sqlLite/sqlite.index-fragmentation.js';
import { duckDbIndexFragmentation } from '../../providers/duckDb/duckdb.index-fragmentation.js';
import { clickHouseIndexFragmentation } from '../../providers/clickHouse/clickhouse.index-fragmentation.js';
import { redshiftIndexFragmentation } from '../../providers/redshift/redshift.index-fragmentation.js';

export const INDEX_FRAGMENTATION_MAP: Record<string, IndexFragmentationDialect> = {
  postgres: postgresIndexFragmentation,
  cockroachdb: cockroachDbIndexFragmentation,
  yugabytedb: yugabyteDbIndexFragmentation,
  mysql: mysqlIndexFragmentation,
  mariadb: mariaDbIndexFragmentation,
  tidb: tiDbIndexFragmentation,
  sqlserver: sqlServerIndexFragmentation,
  azuresql: azureSqlIndexFragmentation,
  oracle: oracleIndexFragmentation,
  db2: db2IndexFragmentation,
  sqlite: sqliteIndexFragmentation,
  duckdb: duckDbIndexFragmentation,
  clickhouse: clickHouseIndexFragmentation,
  redshift: redshiftIndexFragmentation,
};

export function resolveIndexFragmentation(dialect: string): IndexFragmentationDialect | undefined {
  return INDEX_FRAGMENTATION_MAP[(dialect || '').toLowerCase()];
}
