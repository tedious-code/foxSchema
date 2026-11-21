/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * DuckDB is embedded: no server pool or sessions. It does report its own
 * threads, buffer memory and block storage, and per-table row estimates.
 */
import {
  noProbe,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilitySupport,
} from '../../modules/utilities/dba-utilities.types.js';

/**
 * `duckdb_tables().estimated_size` is DuckDB's estimated *row count*. It used
 * to be reported as total/data bytes as well, so a 50 000-row table showed as
 * "48.8 KB". DuckDB has no per-table byte figure short of walking
 * `pragma_storage_info` table by table, so the byte columns stay empty.
 */
const SIZES_SQL = `
SELECT
  schema_name,
  table_name AS object_name,
  'table' AS object_type,
  table_name,
  NULL AS total_bytes,
  NULL AS data_bytes,
  NULL AS index_bytes,
  estimated_size AS row_count
FROM duckdb_tables()
ORDER BY estimated_size DESC NULLS LAST
LIMIT 1000
`.trim();

/** Threads, buffer-manager memory and the database file's block usage. */
const SYSTEM_SQL = `
SELECT
  CAST(current_setting('threads') AS BIGINT) AS cpu_count,
  NULL AS cpu_usage_percent,
  NULL AS memory_total_bytes,
  (SELECT SUM(memory_usage_bytes) FROM duckdb_memory()) AS memory_used_bytes,
  NULL AS memory_available_bytes,
  (SELECT SUM(total_blocks * block_size) FROM pragma_database_size()) AS storage_total_bytes,
  (SELECT SUM(used_blocks * block_size) FROM pragma_database_size()) AS storage_used_bytes,
  (SELECT SUM(free_blocks * block_size) FROM pragma_database_size()) AS storage_available_bytes,
  NULL AS uptime_seconds,
  version() AS server_version
`.trim();

function support(kind: DbaUtilityKind): DbaUtilitySupport {
  if (kind === 'sizes') {
    return {
      mode: 'estimated',
      query: true,
      hint: 'DuckDB: estimated row counts per table (DuckDB reports no per-table bytes).',
    };
  }
  if (kind === 'system') {
    return {
      mode: 'estimated',
      query: true,
      hint: 'DuckDB: worker threads, buffer memory in use, and database file blocks.',
    };
  }
  return {
    mode: 'unsupported',
    query: false,
    hint: 'DuckDB is embedded — no server connection pool or multi-user sessions.',
  };
}

export const duckDbDbaUtilities: DbaUtilityDialect = {
  id: 'duckdb',
  support,
  build(kind, opts) {
    if (kind === 'sizes') return { mode: opts.mode, params: [], sql: SIZES_SQL };
    if (kind === 'system') return { mode: opts.mode, params: [], sql: SYSTEM_SQL };
    return noProbe(kind);
  },
};
