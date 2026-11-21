/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQLite has no native fragmentation % or last-used catalog. The probe lists
 * indexes so Refresh % works; custom SQL / dbstat can add page counts when the
 * VTAB is compiled in.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  name AS index_name,
  CAST(NULL AS REAL) AS fragmentation_percent,
  CAST(NULL AS INTEGER) AS page_count,
  CAST(NULL AS TEXT) AS last_used,
  CAST(NULL AS INTEGER) AS scan_count
FROM sqlite_master
WHERE type = 'index'
  AND tbl_name = ?
  AND IFNULL(name, '') NOT LIKE 'sqlite_%'
ORDER BY name
`.trim();

export const sqliteIndexFragmentation: IndexFragmentationDialect = {
  id: 'sqlite',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'SQLite: lists indexes (no native fragmentation % or last-used catalog). Use custom SQL / dbstat for page sizes; Defrag suggests REINDEX.',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Reindex',
  probe(target) {
    return { mode: 'estimated', params: [target.table], sql: PROBE_SQL };
  },
  usageQueries() {
    return [];
  },
  defragSql(target, indexName) {
    return [`REINDEX ${quoteIndexTarget(target).index(indexName)};`, `-- Or whole DB: VACUUM;`];
  },
  dropSql(target, indexName) {
    return [`DROP INDEX IF EXISTS ${quoteIndexTarget(target).index(indexName)};`];
  },
  customTemplate(target) {
    const tbl = target.table || 'table';
    return `-- Optional: page sizes via dbstat (SQLITE_ENABLE_DBSTAT_VTAB)
SELECT m.name AS index_name,
       CAST(NULL AS REAL) AS fragmentation_percent,
       (SELECT SUM(pgsize) FROM dbstat d WHERE d.name = m.name) AS page_count
FROM sqlite_master m
WHERE m.type = 'index' AND m.tbl_name = '${tbl}' AND m.name NOT LIKE 'sqlite_%';`;
  },
};
