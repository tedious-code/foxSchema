/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to how that engine backs up and restores. Unknown engines
 * resolve to nothing — the facade then says so rather than guessing a tool.
 */
import type { BackupDialect } from './backup.types.js';
import { postgresBackup } from '../../providers/postgres/postgres.backup.js';
import { yugabyteDbBackup } from '../../providers/yugabyteDb/yugabytedb.backup.js';
import { cockroachDbBackup } from '../../providers/cockroachDb/cockroachdb.backup.js';
import { redshiftBackup } from '../../providers/redshift/redshift.backup.js';
import { mysqlBackup } from '../../providers/mysql/mysql.backup.js';
import { mariaDbBackup } from '../../providers/mariaDb/mariadb.backup.js';
import { tiDbBackup } from '../../providers/tiDb/tidb.backup.js';
import { sqlServerBackup } from '../../providers/sqlServer/sqlserver.backup.js';
import { azureSqlBackup } from '../../providers/azureSql/azuresql.backup.js';
import { oracleBackup } from '../../providers/oracle/oracle.backup.js';
import { db2Backup } from '../../providers/db2/db2.backup.js';
import { clickHouseBackup } from '../../providers/clickHouse/clickhouse.backup.js';
import { duckDbBackup } from '../../providers/duckDb/duckdb.backup.js';
import { sqliteBackup } from '../../providers/sqlLite/sqlite.backup.js';
import { mongoDbBackup } from '../../providers/mongodb/mongodb.backup.js';
import { redisBackup } from '../../providers/redis/redis.backup.js';

export const BACKUP_MAP: Record<string, BackupDialect> = {
  postgres: postgresBackup,
  yugabytedb: yugabyteDbBackup,
  cockroachdb: cockroachDbBackup,
  redshift: redshiftBackup,
  mysql: mysqlBackup,
  mariadb: mariaDbBackup,
  tidb: tiDbBackup,
  sqlserver: sqlServerBackup,
  azuresql: azureSqlBackup,
  oracle: oracleBackup,
  db2: db2Backup,
  clickhouse: clickHouseBackup,
  duckdb: duckDbBackup,
  sqlite: sqliteBackup,
  mongodb: mongoDbBackup,
  redis: redisBackup,
};

export function resolveBackup(dialect: string): BackupDialect | undefined {
  return BACKUP_MAP[(dialect || '').toLowerCase()];
}
