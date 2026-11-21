/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle index fragmentation: a weak estimate from ALL_INDEXES statistics.
 * Usage comes from DBA_INDEX_USAGE when the grant allows, then the older
 * object-usage views.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  INDEX_NAME AS index_name,
  CASE
    WHEN LEAF_BLOCKS IS NULL OR LEAF_BLOCKS = 0 OR NUM_ROWS IS NULL OR NUM_ROWS = 0 THEN NULL
    ELSE ROUND(
      GREATEST(0, LEAST(100, 100 * (1 - (DISTINCT_KEYS / NULLIF(NUM_ROWS, 0))))),
      2
    )
  END AS fragmentation_percent,
  LEAF_BLOCKS AS page_count,
  CAST(NULL AS TIMESTAMP) AS last_used,
  CAST(NULL AS NUMBER) AS scan_count
FROM ALL_INDEXES
WHERE OWNER = :1
  AND TABLE_NAME = :2
ORDER BY INDEX_NAME
`.trim();

export const oracleIndexFragmentation: IndexFragmentationDialect = {
  id: 'oracle',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'Oracle: weak estimate from ALL_INDEXES. Last used from DBA_INDEX_USAGE (LAST_USED / TOTAL_ACCESS_COUNT); falls back to DBA_OBJECT_USAGE / V$OBJECT_USAGE.',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Rebuild',
  probe(target) {
    if (!target.schema) return { error: 'Oracle fragmentation probe needs a schema (owner) name.' };
    return {
      mode: 'estimated',
      params: [target.schema.toUpperCase(), target.table.toUpperCase()],
      sql: PROBE_SQL,
    };
  },
  usageQueries(target) {
    if (!target.schema) return [];
    const owner = target.schema.toUpperCase();
    const tbl = target.table.toUpperCase();
    return [
      {
        params: [owner, tbl],
        sql: `
SELECT
  i.INDEX_NAME AS index_name,
  u.LAST_USED AS last_used,
  COALESCE(u.TOTAL_ACCESS_COUNT, 0) AS scan_count
FROM ALL_INDEXES i
LEFT JOIN DBA_INDEX_USAGE u
  ON u.OWNER = i.OWNER AND u.NAME = i.INDEX_NAME
WHERE i.OWNER = :1
  AND i.TABLE_NAME = :2
`.trim(),
      },
      {
        params: [owner, tbl],
        sql: `
SELECT
  INDEX_NAME AS index_name,
  CAST(NULL AS TIMESTAMP) AS last_used,
  CASE WHEN USED = 'YES' THEN 1 ELSE 0 END AS scan_count
FROM DBA_OBJECT_USAGE
WHERE OWNER = :1
  AND TABLE_NAME = :2
`.trim(),
      },
      {
        params: [tbl],
        sql: `
SELECT
  INDEX_NAME AS index_name,
  CAST(NULL AS TIMESTAMP) AS last_used,
  CASE WHEN USED = 'YES' THEN 1 ELSE 0 END AS scan_count
FROM V$OBJECT_USAGE
WHERE TABLE_NAME = :1
`.trim(),
      },
    ];
  },
  defragSql(target, indexName) {
    return [`ALTER INDEX ${quoteIndexTarget(target).indexQualified(indexName)} REBUILD;`];
  },
  dropSql(target, indexName) {
    return [`DROP INDEX ${quoteIndexTarget(target).indexQualified(indexName)};`];
  },
  customTemplate(target) {
    const sch = target.schema || 'schema';
    const tbl = target.table || 'table';
    return `-- Last used: DBA_INDEX_USAGE (12.2+). Fragmentation: ANALYZE INDEX … VALIDATE STRUCTURE.
SELECT i.INDEX_NAME AS index_name,
       CAST(NULL AS NUMBER) AS fragmentation_percent,
       u.LAST_USED AS last_used,
       COALESCE(u.TOTAL_ACCESS_COUNT, 0) AS scan_count
FROM ALL_INDEXES i
LEFT JOIN DBA_INDEX_USAGE u ON u.OWNER = i.OWNER AND u.NAME = i.INDEX_NAME
WHERE i.OWNER = '${sch.toUpperCase()}' AND i.TABLE_NAME = '${tbl.toUpperCase()}';`;
  },
};
