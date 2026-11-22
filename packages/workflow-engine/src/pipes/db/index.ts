/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/db/src/index.ts).
 */
export {
  PostgresSinkPipe,
  type PostgresClient,
  type PostgresClientFactory,
} from './postgres.js';
export { PostgresSourcePipe } from './postgres-source.js';
export { SharedHandleGate, gateForHandle, type GateSession } from './shared-handle-gate.js';
export { MysqlSourcePipe, type MysqlClient, type MysqlClientFactory } from './mysql-source.js';
export { MysqlSinkPipe, fallbackMysqlType } from './mysql.js';
export {
  NATIVE_ADDON_SQL_DIALECTS,
  MappedDbSinkPipe,
  SqlSinkPipe,
  SqlSourcePipe,
  applyColumnMapping,
  columnMappingItemSchema,
  connectionFromSecret,
  resolveUpsertKeys,
  runSqlScript,
  setSqlRunnerDelegate,
  upsertSql,
  type ColumnMappingItem,
  type RunSqlScriptOptions,
  type SqlConnection,
  type SqlRunner,
  type SqlSession,
} from './sql.js';
