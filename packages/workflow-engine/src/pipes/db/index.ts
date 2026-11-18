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
export { MysqlSourcePipe, type MysqlClient, type MysqlClientFactory } from './mysql-source.js';
export { MysqlSinkPipe, fallbackMysqlType } from './mysql.js';
export { SqlSinkPipe, SqlSourcePipe, connectionFromSecret, runSqlScript, type RunSqlScriptOptions, type SqlConnection, type SqlRunner } from './sql.js';
