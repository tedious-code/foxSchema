/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQLite is embedded: no server pool, no multi-user sessions. It can still
 * report file storage and per-object page sizes through dbstat.
 */
import {
  noProbe,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilitySupport,
} from '../../modules/utilities/dba-utilities.types.js';

const SYSTEM_SQL = `
SELECT
  NULL AS cpu_count,
  NULL AS cpu_usage_percent,
  NULL AS memory_total_bytes,
  NULL AS memory_used_bytes,
  NULL AS memory_available_bytes,
  NULL AS storage_total_bytes,
  (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  NULL AS uptime_seconds,
  sqlite_version() AS server_version
`.trim();

const SIZES_SQL = `
SELECT
  NULL AS schema_name,
  name AS object_name,
  CASE WHEN type = 'table' THEN 'table' WHEN type = 'index' THEN 'index' ELSE 'other' END AS object_type,
  CASE WHEN type = 'index' THEN tbl_name ELSE name END AS table_name,
  (SELECT SUM(pgsize) FROM dbstat WHERE name = m.name) AS total_bytes,
  CASE WHEN type = 'table' THEN (SELECT SUM(pgsize) FROM dbstat WHERE name = m.name) ELSE NULL END AS data_bytes,
  CASE WHEN type = 'index' THEN (SELECT SUM(pgsize) FROM dbstat WHERE name = m.name) ELSE NULL END AS index_bytes,
  NULL AS row_count
FROM sqlite_master m
WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'
ORDER BY total_bytes DESC NULLS LAST
LIMIT 1000
`.trim();

function support(kind: DbaUtilityKind): DbaUtilitySupport {
  if (kind === 'sizes') {
    return { mode: 'estimated', query: true, hint: 'SQLite: dbstat / page_count × page_size.' };
  }
  if (kind === 'system') {
    return {
      mode: 'estimated',
      query: true,
      hint: 'SQLite: database file page_count × page_size (storage only).',
    };
  }
  return {
    mode: 'unsupported',
    query: false,
    hint: 'SQLite is embedded — no server connection pool or multi-user sessions.',
  };
}

export const sqliteDbaUtilities: DbaUtilityDialect = {
  id: 'sqlite',
  support,
  build(kind, opts) {
    switch (kind) {
      case 'system':
        return { mode: opts.mode, params: [], sql: SYSTEM_SQL };
      case 'sizes':
        return { mode: opts.mode, params: [], sql: SIZES_SQL };
      default:
        return noProbe(kind);
    }
  },
};
