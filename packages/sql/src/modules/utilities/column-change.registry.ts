/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maps a dialect id to its safe column change steps. Engines not listed get
 * "not yet" from the planner rather than SQL that might not run there.
 */
import type { ColumnChangeDialect } from './column-change.types.js';
import { postgresColumnChange } from '../../providers/postgres/postgres.column-change.js';
import { cockroachDbColumnChange } from '../../providers/cockroachDb/cockroachdb.column-change.js';
import { yugabyteDbColumnChange } from '../../providers/yugabyteDb/yugabytedb.column-change.js';
import { mysqlColumnChange } from '../../providers/mysql/mysql.column-change.js';
import { mariaDbColumnChange } from '../../providers/mariaDb/mariadb.column-change.js';
import { tiDbColumnChange } from '../../providers/tiDb/tidb.column-change.js';
import { sqlServerColumnChange } from '../../providers/sqlServer/sqlserver.column-change.js';
import { azureSqlColumnChange } from '../../providers/azureSql/azuresql.column-change.js';

export const COLUMN_CHANGE_MAP: Record<string, ColumnChangeDialect> = {
  postgres: postgresColumnChange,
  cockroachdb: cockroachDbColumnChange,
  yugabytedb: yugabyteDbColumnChange,
  mysql: mysqlColumnChange,
  mariadb: mariaDbColumnChange,
  tidb: tiDbColumnChange,
  sqlserver: sqlServerColumnChange,
  azuresql: azureSqlColumnChange,
};

export function resolveColumnChange(dialect: string): ColumnChangeDialect | undefined {
  return COLUMN_CHANGE_MAP[(dialect || '').toLowerCase()];
}
