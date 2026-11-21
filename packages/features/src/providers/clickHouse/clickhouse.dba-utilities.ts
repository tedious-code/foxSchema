/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * ClickHouse DBA probes: system.processes, system.asynchronous_metrics,
 * system.parts.
 */
import {
  noProbe,
  probeSupport,
  type DbaUtilityDialect,
  type DbaUtilityKind,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'ClickHouse: system.asynchronous_metrics / metrics (partial).',
  pool: 'ClickHouse: max_concurrent_queries and current query counts.',
  sessions: 'ClickHouse: system.processes.',
  sizes: 'ClickHouse: system.parts sizes.',
};

// toInt64OrNull is right here: system.settings.value really is a String.
const POOL_SQL = `
SELECT
  toInt64OrNull((SELECT value FROM system.settings WHERE name = 'max_concurrent_queries' LIMIT 1)) AS max_connections,
  (SELECT count() FROM system.processes) AS current_connections,
  (SELECT count() FROM system.processes WHERE is_cancelled = 0) AS active_connections
`.trim();

const SESSIONS_SQL = `
SELECT
  toString(query_id) AS session_id,
  user AS user_name,
  client_hostname AS client_host,
  current_database AS database_name,
  if(is_cancelled = 1, 'cancelled', 'running') AS state,
  '' AS wait_event,
  substring(query, 1, 500) AS query_text,
  toString(elapsed) AS connected_at,
  '' AS application_name
FROM system.processes
LIMIT 500
`.trim();

const SYSTEM_SQL = `
-- CAST, not toInt64OrNull: the *OrNull conversions take a String, while
-- system.asynchronous_metrics.value is Float64 and system.metrics.value is
-- Int64. Passing a number gave "Illegal type Float64 of first argument of
-- function toInt64OrNull", which failed the whole System tab. (The pool query
-- above may keep toInt64OrNull — system.settings.value really is a String.)
SELECT
  CAST((SELECT value FROM system.asynchronous_metrics WHERE metric = 'NumberOfProcessors' LIMIT 1) AS Nullable(Int64)) AS cpu_count,
  CAST((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSCPUUtilization' LIMIT 1) AS Nullable(Float64)) AS cpu_usage_percent,
  CAST((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSMemoryTotal' LIMIT 1) AS Nullable(Int64)) AS memory_total_bytes,
  CAST((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSMemoryAvailable' LIMIT 1) AS Nullable(Int64)) AS memory_available_bytes,
  NULL AS memory_used_bytes,
  NULL AS storage_total_bytes,
  CAST((SELECT value FROM system.asynchronous_metrics WHERE metric = 'DiskUsed_default' LIMIT 1) AS Nullable(Int64)) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  CAST((SELECT value FROM system.metrics WHERE metric = 'Uptime' LIMIT 1) AS Nullable(Int64)) AS uptime_seconds,
  version() AS server_version
`.trim();

const SIZES_SQL = `
SELECT
  database AS schema_name,
  table AS object_name,
  'table' AS object_type,
  table AS table_name,
  sum(bytes_on_disk) AS total_bytes,
  sum(data_uncompressed_bytes) AS data_bytes,
  NULL AS index_bytes,
  sum(rows) AS row_count
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY total_bytes DESC
LIMIT 1000
`.trim();

export const clickHouseDbaUtilities: DbaUtilityDialect = {
  id: 'clickhouse',
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
