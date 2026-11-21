/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 DBA probes: DBCFG + MON_GET_CONNECTION for the pool and sessions,
 * SYSCAT page counts for sizes.
 */
import {
  noProbe,
  probeSupport,
  type DbaProbeOptions,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilityQuery,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'DB2: ENV_GET_SYSTEM_RESOURCES / snapshot when available.',
  pool: 'DB2: MAXAPPLS and application counts.',
  sessions: 'DB2: MON_GET_CONNECTION / SYSIBMADM.APPLICATIONS.',
  sizes: 'DB2: SYSCAT.TABLES FPAGES + SYSCAT.INDEXES NLEAF × tablespace page size.',
};

const POOL_SQL = `
SELECT
  (SELECT CAST(VALUE AS INTEGER) FROM SYSIBMADM.DBCFG WHERE NAME = 'maxappls' FETCH FIRST 1 ROW ONLY) AS max_connections,
  (SELECT COUNT(*) FROM TABLE(MON_GET_CONNECTION(NULL, -2))) AS current_connections,
  (SELECT COUNT(*) FROM TABLE(MON_GET_CONNECTION(NULL, -2)) WHERE APPLICATION_HANDLE IS NOT NULL) AS active_connections
FROM SYSIBM.SYSDUMMY1
`.trim();

// `database_name` is CURRENT SERVER, not a partition column. The original
// query selected a partition number here under a column name that promised
// the database — and picked one MON_GET_CONNECTION does not expose, so DB2
// answered SQL0206N and Sessions failed outright for every DB2 user.
const SESSIONS_SQL = `
SELECT
  CAST(APPLICATION_HANDLE AS VARCHAR(32)) AS session_id,
  SESSION_AUTH_ID AS user_name,
  CLIENT_HOSTNAME AS client_host,
  CURRENT SERVER AS database_name,
  APPLICATION_NAME AS state,
  CAST(NULL AS VARCHAR(128)) AS wait_event,
  CAST(NULL AS VARCHAR(500)) AS query_text,
  CAST(CONNECTION_START_TIME AS VARCHAR(40)) AS connected_at,
  APPLICATION_NAME AS application_name
FROM TABLE(MON_GET_CONNECTION(NULL, -2))
FETCH FIRST 500 ROWS ONLY
`.trim();

const SYSTEM_SQL = `
SELECT
  CAST(NULL AS INTEGER) AS cpu_count,
  CAST(NULL AS DOUBLE) AS cpu_usage_percent,
  CAST(NULL AS BIGINT) AS memory_total_bytes,
  CAST(NULL AS BIGINT) AS memory_used_bytes,
  CAST(NULL AS BIGINT) AS memory_available_bytes,
  CAST(NULL AS BIGINT) AS storage_total_bytes,
  CAST(NULL AS BIGINT) AS storage_used_bytes,
  CAST(NULL AS BIGINT) AS storage_available_bytes,
  CAST(NULL AS BIGINT) AS uptime_seconds,
  (SELECT SERVICE_LEVEL FROM TABLE(SYSPROC.ENV_GET_INST_INFO()) FETCH FIRST 1 ROW ONLY) AS server_version
FROM SYSIBM.SYSDUMMY1
`.trim();

// FPAGES = allocated pages (use for data). NPAGES can be lower and must not
// be used as "total" or Total < Data. Index leaf pages from SYSCAT.INDEXES.
// Page size from the table's tablespace when available.
const TABLE_SELECT = `
SELECT
  t.TABSCHEMA AS schema_name,
  t.TABNAME AS object_name,
  'table' AS object_type,
  t.TABNAME AS table_name,
  BIGINT(COALESCE(t.FPAGES, t.NPAGES, 0) + COALESCE(i.index_pages, 0))
    * BIGINT(COALESCE(ts.PAGESIZE, 4096)) AS total_bytes,
  BIGINT(COALESCE(t.FPAGES, t.NPAGES, 0))
    * BIGINT(COALESCE(ts.PAGESIZE, 4096)) AS data_bytes,
  BIGINT(COALESCE(i.index_pages, 0))
    * BIGINT(COALESCE(ts.PAGESIZE, 4096)) AS index_bytes,
  t.CARD AS row_count
FROM SYSCAT.TABLES t
LEFT JOIN SYSCAT.TABLESPACES ts ON ts.TBSPACE = t.TBSPACE
LEFT JOIN (
  SELECT TABSCHEMA, TABNAME, SUM(BIGINT(COALESCE(NLEAF, 0))) AS index_pages
  FROM SYSCAT.INDEXES
  GROUP BY TABSCHEMA, TABNAME
) i ON i.TABSCHEMA = t.TABSCHEMA AND i.TABNAME = t.TABNAME
WHERE t.TYPE = 'T'`.trim();

const INDEX_SELECT = `
SELECT
  ix.TABSCHEMA AS schema_name,
  ix.INDNAME AS object_name,
  'index' AS object_type,
  ix.TABNAME AS table_name,
  BIGINT(COALESCE(ix.NLEAF, 0)) * BIGINT(COALESCE(ts.PAGESIZE, 4096)) AS total_bytes,
  CAST(NULL AS BIGINT) AS data_bytes,
  BIGINT(COALESCE(ix.NLEAF, 0)) * BIGINT(COALESCE(ts.PAGESIZE, 4096)) AS index_bytes,
  CAST(NULL AS BIGINT) AS row_count
FROM SYSCAT.INDEXES ix
JOIN SYSCAT.TABLES t ON t.TABSCHEMA = ix.TABSCHEMA AND t.TABNAME = ix.TABNAME AND t.TYPE = 'T'
LEFT JOIN SYSCAT.TABLESPACES ts ON ts.TBSPACE = t.TBSPACE`.trim();

function sizesQuery(schema: string, mode: DbaProbeOptions['mode']): DbaUtilityQuery {
  return {
    mode,
    params: schema ? [schema.toUpperCase(), schema.toUpperCase()] : [],
    sql: schema
      ? `
SELECT * FROM (
  ${TABLE_SELECT}
    AND t.TABSCHEMA = ?
  UNION ALL
  ${INDEX_SELECT}
    AND ix.TABSCHEMA = ?
) u
ORDER BY COALESCE(total_bytes, 0) DESC
FETCH FIRST 1000 ROWS ONLY
`.trim()
      : `
SELECT * FROM (
  ${TABLE_SELECT}
    AND t.TABSCHEMA NOT LIKE 'SYS%'
  UNION ALL
  ${INDEX_SELECT}
    AND ix.TABSCHEMA NOT LIKE 'SYS%'
) u
ORDER BY COALESCE(total_bytes, 0) DESC
FETCH FIRST 1000 ROWS ONLY
`.trim(),
  };
}

export const db2DbaUtilities: DbaUtilityDialect = {
  id: 'db2',
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
        return sizesQuery(opts.schema, opts.mode);
      default:
        return noProbe(kind);
    }
  },
};
