/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle DBA probes: v$parameter / v$session for the pool, v$osstat for the
 * host, user_segments for sizes.
 */
import {
  noProbe,
  probeSupport,
  type DbaUtilityDialect,
  type DbaUtilityKind,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'Oracle: v$osstat / v$sga when permitted; otherwise session/SGA estimates.',
  pool: 'Oracle: sessions / processes from v$parameter + v$session.',
  sessions: 'Oracle: v$session.',
  sizes: 'Oracle: user_segments / all_segments sizes.',
};

const POOL_SQL = `
SELECT
  (SELECT TO_NUMBER(value) FROM v$parameter WHERE name = 'sessions') AS max_connections,
  (SELECT COUNT(*) FROM v$session) AS current_connections,
  (SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE') AS active_connections,
  (SELECT COUNT(*) FROM v$session_wait WHERE state = 'WAITING') AS wait_count
FROM dual
`.trim();

const SESSIONS_SQL = `
SELECT * FROM (
  SELECT
    -- SID alone is reused; ALTER SYSTEM KILL / CANCEL SQL need "SID,SERIAL#".
    sid || ',' || serial# AS session_id,
    username AS user_name,
    machine AS client_host,
    COALESCE(service_name, schemaname) AS database_name,
    status AS state,
    event AS wait_event,
    SUBSTR(sql_id, 1, 500) AS query_text,
    TO_CHAR(logon_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at,
    program AS application_name
  FROM v$session
  WHERE type = 'USER'
  ORDER BY logon_time DESC NULLS LAST
) WHERE ROWNUM <= 500
`.trim();

const SYSTEM_SQL = `
SELECT
  (SELECT value FROM v$osstat WHERE stat_name = 'NUM_CPUS') AS cpu_count,
  NULL AS cpu_usage_percent,
  (SELECT value FROM v$osstat WHERE stat_name = 'PHYSICAL_MEMORY_BYTES') AS memory_total_bytes,
  NULL AS memory_used_bytes,
  NULL AS memory_available_bytes,
  NULL AS storage_total_bytes,
  (SELECT SUM(bytes) FROM user_segments) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  NULL AS uptime_seconds,
  (SELECT banner FROM v$version WHERE banner LIKE 'Oracle%' AND ROWNUM = 1) AS server_version
FROM dual
`.trim();

const SIZES_SQL = `
SELECT * FROM (
  SELECT
    tablespace_name AS schema_name,
    segment_name AS object_name,
    CASE WHEN segment_type LIKE 'TABLE%' THEN 'table' WHEN segment_type LIKE 'INDEX%' THEN 'index' ELSE 'other' END AS object_type,
    CASE WHEN segment_type LIKE 'INDEX%' THEN NULL ELSE segment_name END AS table_name,
    bytes AS total_bytes,
    CASE WHEN segment_type LIKE 'TABLE%' THEN bytes ELSE NULL END AS data_bytes,
    CASE WHEN segment_type LIKE 'INDEX%' THEN bytes ELSE NULL END AS index_bytes,
    NULL AS row_count
  FROM user_segments
  WHERE segment_type LIKE 'TABLE%' OR segment_type LIKE 'INDEX%'
  ORDER BY bytes DESC NULLS LAST
) WHERE ROWNUM <= 1000
`.trim();

export const oracleDbaUtilities: DbaUtilityDialect = {
  id: 'oracle',
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
