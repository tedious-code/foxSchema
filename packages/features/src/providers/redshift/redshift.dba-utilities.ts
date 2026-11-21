/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redshift DBA probes: stv_sessions / stv_recents / svv_table_info. Postgres-
 * wire, but the system views are its own.
 */
import {
  noProbe,
  probeSupport,
  type DbaUtilityDialect,
  type DbaUtilityKind,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'Redshift: limited cluster metrics via SVV / STL views.',
  pool: 'Redshift: max_connections and stv_sessions counts.',
  sessions: 'Redshift: stv_sessions / pg_stat_activity.',
  sizes: 'Redshift: svv_table_info sizes.',
};

const POOL_SQL = `
SELECT
  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
  (SELECT count(*)::int FROM stv_sessions) AS current_connections,
  (SELECT count(*)::int FROM stv_recents WHERE status = 'Running') AS active_connections
`.trim();

const SESSIONS_SQL = `
SELECT
  process::text AS session_id,
  user_name,
  remotehost AS client_host,
  db_name AS database_name,
  'connected' AS state,
  NULL AS wait_event,
  NULL AS query_text,
  starttime::text AS connected_at,
  NULL AS application_name
FROM stv_sessions
ORDER BY starttime DESC
LIMIT 500
`.trim();

const SYSTEM_SQL = `
SELECT
  NULL::int AS cpu_count,
  NULL::float8 AS cpu_usage_percent,
  NULL::bigint AS memory_total_bytes,
  NULL::bigint AS memory_used_bytes,
  NULL::bigint AS memory_available_bytes,
  NULL::bigint AS storage_total_bytes,
  (SELECT sum(size)::bigint * 1024 * 1024 FROM stv_partitions) AS storage_used_bytes,
  NULL::bigint AS storage_available_bytes,
  NULL::bigint AS uptime_seconds,
  version() AS server_version
`.trim();

const SIZES_SQL = `
SELECT
  schema AS schema_name,
  "table" AS object_name,
  'table' AS object_type,
  "table" AS table_name,
  size * 1024 * 1024 AS total_bytes,
  size * 1024 * 1024 AS data_bytes,
  NULL AS index_bytes,
  tbl_rows AS row_count
FROM svv_table_info
ORDER BY size DESC
LIMIT 1000
`.trim();

export const redshiftDbaUtilities: DbaUtilityDialect = {
  id: 'redshift',
  support: probeSupport(HINTS),
  build(kind, opts) {
    switch (kind) {
      case 'pool':
        return { mode: opts.mode, params: [], sql: POOL_SQL };
      case 'sessions':
        return { mode: opts.mode, params: [], sql: SESSIONS_SQL };
      case 'system':
        return { mode: opts.mode, params: [], sql: SYSTEM_SQL };
      case 'sizes':
        return { mode: opts.mode, params: [], sql: SIZES_SQL };
      default:
        return noProbe(kind);
    }
  },
};
