/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redshift has no secondary indexes. The probe returns an empty typed result
 * so Refresh % succeeds and the UI can offer VACUUM / ANALYZE instead.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  CAST(NULL AS VARCHAR(128)) AS index_name,
  CAST(NULL AS FLOAT) AS fragmentation_percent,
  CAST(NULL AS BIGINT) AS page_count,
  CAST(NULL AS TIMESTAMP) AS last_used,
  CAST(NULL AS BIGINT) AS scan_count
WHERE 1 = 0
`.trim();

export const redshiftIndexFragmentation: IndexFragmentationDialect = {
  id: 'redshift',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'Redshift: no secondary indexes — probe returns empty; use VACUUM / ANALYZE (custom SQL for unsorted %).',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Reindex',
  probe() {
    return { mode: 'estimated', params: [], sql: PROBE_SQL };
  },
  usageQueries() {
    return [];
  },
  defragSql(target) {
    const table = quoteIndexTarget(target).table;
    return [`VACUUM ${table};`, `ANALYZE ${table};`];
  },
  dropSql() {
    // Nothing to drop: there are no secondary indexes.
    return [];
  },
  customTemplate(target) {
    const sch = target.schema || 'schema';
    const tbl = target.table || 'table';
    return `-- Redshift has no secondary indexes; unsorted block % example:
SELECT 'unsorted' AS index_name,
       CAST(unsorted AS float) AS fragmentation_percent
FROM svv_table_info
WHERE schema = '${sch}' AND "table" = '${tbl}';`;
  },
};
