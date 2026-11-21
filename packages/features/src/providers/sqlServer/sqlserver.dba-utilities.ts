/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server DBA probes: DMVs for sessions, memory and partition stats.
 * Every probe is native — the engine exposes all of this directly.
 */
import {
  noProbe,
  probeSupport,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilitySupport,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'SQL Server: sys.dm_os_sys_info / performance counters.',
  pool: 'SQL Server: @@MAX_CONNECTIONS and session counts.',
  sessions: 'SQL Server: sys.dm_exec_sessions / requests.',
  sizes: 'SQL Server: partition stats + index sizes.',
};

const POOL_SQL = `
SELECT
  CAST(@@MAX_CONNECTIONS AS int) AS max_connections,
  (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS current_connections,
  (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id > 50) AS active_connections,
  (SELECT COUNT(*) FROM sys.dm_os_waiting_tasks) AS wait_count
`.trim();

const SESSIONS_SQL = `
SELECT TOP 500
  CAST(s.session_id AS varchar(32)) AS session_id,
  s.login_name AS user_name,
  s.host_name AS client_host,
  DB_NAME(s.database_id) AS database_name,
  s.status AS state,
  r.wait_type AS wait_event,
  LEFT(t.text, 500) AS query_text,
  CONVERT(varchar(33), s.login_time, 126) AS connected_at,
  s.program_name AS application_name
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1
ORDER BY s.login_time DESC
`.trim();

const SYSTEM_SQL = `
SELECT
  i.cpu_count AS cpu_count,
  NULL AS cpu_usage_percent,
  i.physical_memory_kb * 1024 AS memory_total_bytes,
  (i.physical_memory_kb - m.available_physical_memory_kb) * 1024 AS memory_used_bytes,
  m.available_physical_memory_kb * 1024 AS memory_available_bytes,
  NULL AS storage_total_bytes,
  (SELECT SUM(size) * 8 * 1024 FROM sys.database_files) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  datediff_big(second, i.sqlserver_start_time, sysdatetime()) AS uptime_seconds,
  @@VERSION AS server_version
FROM sys.dm_os_sys_info i
CROSS JOIN sys.dm_os_sys_memory m
`.trim();

const SIZES_SQL = `
SELECT TOP 1000
  OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
  i.name AS object_name,
  CASE WHEN i.index_id <= 1 THEN 'table' ELSE 'index' END AS object_type,
  OBJECT_NAME(i.object_id) AS table_name,
  SUM(ps.used_page_count) * 8 * 1024 AS total_bytes,
  SUM(CASE WHEN i.index_id IN (0,1) THEN ps.used_page_count ELSE 0 END) * 8 * 1024 AS data_bytes,
  SUM(CASE WHEN i.index_id > 1 THEN ps.used_page_count ELSE 0 END) * 8 * 1024 AS index_bytes,
  SUM(ps.row_count) AS row_count
FROM sys.dm_db_partition_stats ps
JOIN sys.indexes i ON i.object_id = ps.object_id AND i.index_id = ps.index_id
WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
GROUP BY i.object_id, i.name, i.index_id
ORDER BY SUM(ps.used_page_count) DESC
`.trim();

/** Azure SQL reads the same DMVs; only the product name in the hint differs. */
export function makeSqlServerDbaUtilities(id: string, label = 'SQL Server'): DbaUtilityDialect {
  const base = probeSupport(HINTS, []);
  const support = (kind: DbaUtilityKind): DbaUtilitySupport => {
    const s = base(kind);
    return { ...s, hint: s.hint.replace('SQL Server', label) };
  };
  return {
    id,
    support,
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
}

export const sqlServerDbaUtilities = makeSqlServerDbaUtilities('sqlserver');
