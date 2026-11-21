/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * DuckDB lists indexes from duckdb_indexes(); there is no native % or
 * last-used catalog, and CHECKPOINT is the closest thing to maintenance.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

const COLUMNS = `
SELECT
  index_name AS index_name,
  CAST(NULL AS DOUBLE) AS fragmentation_percent,
  CAST(NULL AS BIGINT) AS page_count,
  CAST(NULL AS TIMESTAMP) AS last_used,
  CAST(NULL AS BIGINT) AS scan_count
FROM duckdb_indexes()
WHERE table_name = ?`;

export const duckDbIndexFragmentation: IndexFragmentationDialect = {
  id: 'duckdb',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'DuckDB: lists indexes from duckdb_indexes() (no native % or last-used catalog). Prefer custom SQL for ART / zone-map stats.',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Rebuild',
  probe(target) {
    return {
      mode: 'estimated',
      params: target.schema ? [target.table, target.schema] : [target.table],
      sql: target.schema
        ? `${COLUMNS}\n  AND schema_name = ?\nORDER BY index_name`.trim()
        : `${COLUMNS}\nORDER BY index_name`.trim(),
    };
  },
  usageQueries() {
    return [];
  },
  defragSql() {
    return [`CHECKPOINT;`];
  },
  dropSql(target, indexName) {
    return [`DROP INDEX IF EXISTS ${quoteIndexTarget(target).indexQualified(indexName)};`];
  },
  customTemplate(target) {
    const tbl = target.table || 'table';
    return `SELECT index_name AS index_name,
       CAST(NULL AS DOUBLE) AS fragmentation_percent
FROM duckdb_indexes()
WHERE table_name = '${tbl}'${target.schema ? ` AND schema_name = '${target.schema}'` : ''};`;
  },
};
