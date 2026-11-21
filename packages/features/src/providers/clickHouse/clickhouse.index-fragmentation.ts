/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * ClickHouse lists data-skipping indices from system.data_skipping_indices.
 * There is no B-tree % or last-used catalog; OPTIMIZE TABLE forces merges.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  name AS index_name,
  -- Nullable(...) is required: ClickHouse types are non-nullable by default
  -- and rejects the cast outright ("Cannot convert NULL to a non-nullable
  -- type"). These columns are genuinely unknown for skip indexes.
  CAST(NULL AS Nullable(Float64)) AS fragmentation_percent,
  CAST(NULL AS Nullable(UInt64)) AS page_count,
  CAST(NULL AS Nullable(DateTime)) AS last_used,
  CAST(NULL AS Nullable(UInt64)) AS scan_count
FROM system.data_skipping_indices
-- Numbered placeholders, not positional ones: the ClickHouse adapter
-- substitutes $1/$2 itself, so a bare question mark would reach the server
-- unbound and fail to parse.
WHERE database = $1
  AND table = $2
ORDER BY name
`.trim();

export const clickHouseIndexFragmentation: IndexFragmentationDialect = {
  id: 'clickhouse',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'ClickHouse: data-skipping indices from system.data_skipping_indices (no B-tree % or last-used catalog). OPTIMIZE TABLE for merges.',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Rebuild',
  probe(target) {
    return { mode: 'estimated', params: [target.schema || 'default', target.table], sql: PROBE_SQL };
  },
  usageQueries() {
    return [];
  },
  defragSql(target) {
    return [`OPTIMIZE TABLE ${quoteIndexTarget(target).table} FINAL;`];
  },
  dropSql(target, indexName) {
    // Data-skipping indexes listed in Index Management, not traditional B-trees.
    const q = quoteIndexTarget(target);
    return [`ALTER TABLE ${q.table} DROP INDEX ${q.index(indexName)};`];
  },
  customTemplate(target) {
    const sch = target.schema || 'schema';
    const tbl = target.table || 'table';
    return `SELECT name AS index_name,
       CAST(NULL AS Float64) AS fragmentation_percent
FROM system.data_skipping_indices
WHERE database = '${sch}' AND table = '${tbl}';`;
  },
};
