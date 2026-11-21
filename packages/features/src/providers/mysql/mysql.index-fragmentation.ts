/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MySQL-family index fragmentation: the table-level DATA_FREE ratio applied
 * to each index (an estimate — InnoDB keeps no per-index figure). MariaDB and
 * TiDB reuse the probe and differ in usage catalogs and maintenance verbs.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
  type IndexFragmentationSupport,
  type IndexTarget,
  type IndexUsageQuery,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  s.INDEX_NAME AS index_name,
  CASE
    WHEN (IFNULL(t.DATA_LENGTH, 0) + IFNULL(t.INDEX_LENGTH, 0)) = 0 THEN NULL
    ELSE ROUND(
      100 * IFNULL(t.DATA_FREE, 0) / (IFNULL(t.DATA_LENGTH, 0) + IFNULL(t.INDEX_LENGTH, 0)),
      2
    )
  END AS fragmentation_percent,
  NULL AS page_count,
  NULL AS last_used,
  NULL AS scan_count
FROM information_schema.STATISTICS s
JOIN information_schema.TABLES t
  ON t.TABLE_SCHEMA = s.TABLE_SCHEMA AND t.TABLE_NAME = s.TABLE_NAME
WHERE s.TABLE_SCHEMA = ?
  AND s.TABLE_NAME = ?
GROUP BY s.INDEX_NAME, t.DATA_FREE, t.DATA_LENGTH, t.INDEX_LENGTH
ORDER BY s.INDEX_NAME
`.trim();

/** performance_schema I/O counters — present on MySQL, MariaDB and TiDB. */
export const MYSQL_INDEX_IO_USAGE_SQL = `
SELECT INDEX_NAME AS index_name,
       CAST(NULL AS DATETIME) AS last_used,
       COUNT_READ AS scan_count
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE OBJECT_SCHEMA = ?
  AND OBJECT_NAME = ?
  AND INDEX_NAME IS NOT NULL
`.trim();

export function mysqlCustomTemplate(target: IndexTarget): string {
  const sch = target.schema || 'schema';
  const tbl = target.table || 'table';
  return `SELECT INDEX_NAME AS index_name, NULL AS fragmentation_percent,
       CAST(NULL AS DATETIME) AS last_used, COUNT_READ AS scan_count
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE OBJECT_SCHEMA = '${sch}' AND OBJECT_NAME = '${tbl}'
  AND INDEX_NAME IS NOT NULL;`;
}

export interface MysqlIndexFragmentationVariant {
  id: string;
  support: IndexFragmentationSupport;
  maintenanceVerb: string;
  /** Usage catalogs to try, in order, once the schema is known. */
  usageQueries: (schema: string, table: string) => IndexUsageQuery[];
  defragSql: (quotedTable: string) => string[];
  customTemplate: (target: IndexTarget) => string;
}

export function makeMysqlIndexFragmentation(
  variant: MysqlIndexFragmentationVariant
): IndexFragmentationDialect {
  return {
    id: variant.id,
    support: variant.support,
    maintenanceVerb: variant.maintenanceVerb,
    probe(target) {
      if (!target.schema) {
        return { error: 'MySQL-family fragmentation probe needs a schema (database) name.' };
      }
      return { mode: 'estimated', params: [target.schema, target.table], sql: PROBE_SQL };
    },
    usageQueries(target) {
      if (!target.schema) return [];
      return variant.usageQueries(target.schema, target.table);
    },
    defragSql(target) {
      return variant.defragSql(quoteIndexTarget(target).table);
    },
    dropSql(target, indexName) {
      const q = quoteIndexTarget(target);
      return [`DROP INDEX ${q.index(indexName)} ON ${q.table};`];
    },
    customTemplate: variant.customTemplate,
  };
}

export const mysqlIndexFragmentation = makeMysqlIndexFragmentation({
  id: 'mysql',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'MySQL: table-level DATA_FREE ratio (same estimate on each index). Scan count from performance_schema.table_io_waits_summary_by_index_usage (COUNT_READ since restart).',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Optimize',
  usageQueries: (schema, table) => [{ params: [schema, table], sql: MYSQL_INDEX_IO_USAGE_SQL }],
  defragSql: (table) => [`OPTIMIZE TABLE ${table};`],
  customTemplate: mysqlCustomTemplate,
});
