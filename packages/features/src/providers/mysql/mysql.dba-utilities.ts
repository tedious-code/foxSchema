/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MySQL DBA probes. TiDB reuses them with a different status table; MariaDB
 * has its own file because two of these probes are wrong on it.
 */
import {
  noProbe,
  probeSupport,
  type DbaProbeOptions,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilityQuery,
  type DbaUtilitySupport,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'MySQL: status/variables (buffer pool, uptime). Host disk/CPU are limited.',
  pool: 'MySQL: max_connections, Threads_connected, Threads_running.',
  sessions: 'MySQL: information_schema.PROCESSLIST.',
  sizes: 'MySQL: information_schema.TABLES DATA_LENGTH / INDEX_LENGTH.',
};

/** Shared by MySQL, MariaDB and TiDB — PROCESSLIST is identical on all three. */
export const MYSQL_SESSIONS_SQL = `
SELECT
  CAST(ID AS CHAR) AS session_id,
  USER AS user_name,
  HOST AS client_host,
  DB AS database_name,
  COMMAND AS state,
  STATE AS wait_event,
  LEFT(INFO, 500) AS query_text,
  NULL AS connected_at,
  NULL AS application_name
FROM information_schema.PROCESSLIST
ORDER BY ID
LIMIT 500
`.trim();

/** Shared by the whole family — information_schema.TABLES is the same. */
export const MYSQL_SIZES_SQL = `
SELECT
  TABLE_SCHEMA AS schema_name,
  TABLE_NAME AS object_name,
  'table' AS object_type,
  TABLE_NAME AS table_name,
  (DATA_LENGTH + INDEX_LENGTH) AS total_bytes,
  DATA_LENGTH AS data_bytes,
  INDEX_LENGTH AS index_bytes,
  TABLE_ROWS AS row_count
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_TYPE = 'BASE TABLE'
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
LIMIT 1000
`.trim();

function poolSql(statusTable: string): string {
  return `
SELECT
  CAST(@@max_connections AS SIGNED) AS max_connections,
  (SELECT VARIABLE_VALUE FROM ${statusTable} WHERE VARIABLE_NAME = 'Threads_connected' LIMIT 1) AS current_connections,
  (SELECT VARIABLE_VALUE FROM ${statusTable} WHERE VARIABLE_NAME = 'Threads_running' LIMIT 1) AS active_connections,
  (SELECT VARIABLE_VALUE FROM ${statusTable} WHERE VARIABLE_NAME = 'Threads_cached' LIMIT 1) AS available_connections,
  (SELECT VARIABLE_VALUE FROM ${statusTable} WHERE VARIABLE_NAME = 'Connection_errors_max_connections' LIMIT 1) AS wait_count
`.trim();
}

function systemSql(statusTable: string): string {
  return `
SELECT
  CAST(@@innodb_buffer_pool_instances AS SIGNED) AS cpu_count,
  NULL AS cpu_usage_percent,
  CAST(@@innodb_buffer_pool_size AS SIGNED) AS memory_total_bytes,
  NULL AS memory_used_bytes,
  NULL AS memory_available_bytes,
  NULL AS storage_total_bytes,
  (SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  (SELECT VARIABLE_VALUE FROM ${statusTable} WHERE VARIABLE_NAME = 'Uptime' LIMIT 1) AS uptime_seconds,
  VERSION() AS server_version
`.trim();
}

export interface MysqlDbaVariant {
  id: string;
  /** Replaces "MySQL" in every hint. */
  label?: string;
  /**
   * Where status variables live. TiDB keeps them in information_schema, not
   * performance_schema — reading the latter fails outright with "SELECT
   * command denied ... for table 'global_status'".
   */
  statusTable?: string;
  mode?: 'native' | 'estimated';
}

export function makeMysqlDbaUtilities(variant: MysqlDbaVariant): DbaUtilityDialect {
  const statusTable = variant.statusTable ?? 'performance_schema.global_status';
  const base = probeSupport(HINTS);
  const support = (kind: DbaUtilityKind): DbaUtilitySupport => {
    const s = base(kind);
    return {
      mode: variant.mode ?? s.mode,
      query: s.query,
      hint: variant.label ? s.hint.replace('MySQL', variant.label) : s.hint,
    };
  };
  return {
    id: variant.id,
    support,
    build(kind, opts: DbaProbeOptions): DbaUtilityQuery | { error: string } {
      switch (kind) {
        case 'pool':
          return { mode: opts.mode, params: [], sql: poolSql(statusTable) };
        case 'sessions':
          return { mode: opts.mode, params: [], sql: MYSQL_SESSIONS_SQL };
        case 'system':
          return { mode: opts.mode, params: [], sql: systemSql(statusTable) };
        case 'sizes':
          return { mode: opts.mode, params: [], sql: MYSQL_SIZES_SQL };
        default:
          return noProbe(kind);
      }
    },
  };
}

export const mysqlDbaUtilities = makeMysqlDbaUtilities({ id: 'mysql' });
