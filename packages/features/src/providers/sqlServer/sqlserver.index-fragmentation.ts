/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server index fragmentation: physical % via dm_db_index_physical_stats,
 * usage from dm_db_index_usage_stats, joined into one probe. Azure SQL reads
 * the same DMVs.
 *
 * Placeholders are named `@pN` because that is what the adapter binds; a bare
 * `?` reached the server verbatim and answered "Incorrect syntax near '?'".
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
  type IndexTarget,
} from '../../modules/utilities/index-fragmentation.types.js';

const PROBE_SQL = `
SELECT
  i.name AS index_name,
  CAST(ps.avg_fragmentation_in_percent AS float) AS fragmentation_percent,
  CAST(ps.page_count AS bigint) AS page_count,
  (
    SELECT MAX(v)
    FROM (VALUES
      (us.last_user_seek),
      (us.last_user_scan),
      (us.last_user_lookup),
      (us.last_user_update)
    ) AS t(v)
  ) AS last_used,
  CAST(ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0) AS bigint) AS scan_count
FROM sys.dm_db_index_physical_stats(DB_ID(), OBJECT_ID(@p0), NULL, NULL, 'LIMITED') AS ps
INNER JOIN sys.indexes AS i
  ON ps.object_id = i.object_id AND ps.index_id = i.index_id
LEFT JOIN sys.dm_db_index_usage_stats AS us
  ON us.database_id = DB_ID()
 AND us.object_id = i.object_id
 AND us.index_id = i.index_id
WHERE i.name IS NOT NULL
  AND ps.index_level = 0
ORDER BY i.name
`.trim();

export function makeSqlServerIndexFragmentation(id: string, label: string): IndexFragmentationDialect {
  return {
    id,
    support: {
      mode: 'physical',
      query: true,
      defrag: true,
      hint: `${label}: avg_fragmentation_in_percent from sys.dm_db_index_physical_stats (LIMITED); last used from dm_db_index_usage_stats.`,
      customSqlHint: CUSTOM_HINT,
    },
    maintenanceVerb: 'Rebuild',
    probe(target: IndexTarget) {
      const objectIdArg = target.schema ? `${target.schema}.${target.table}` : target.table;
      return { mode: 'physical', params: [objectIdArg], sql: PROBE_SQL };
    },
    usageQueries() {
      // Usage is already joined into the main probe.
      return [];
    },
    defragSql(target, indexName, pct) {
      const q = quoteIndexTarget(target);
      // Microsoft's bands: under 30% reorganise, otherwise rebuild.
      if (pct != null && pct < 30) {
        return [`ALTER INDEX ${q.index(indexName)} ON ${q.table} REORGANIZE;`];
      }
      return [`ALTER INDEX ${q.index(indexName)} ON ${q.table} REBUILD;`];
    },
    dropSql(target, indexName) {
      const q = quoteIndexTarget(target);
      return [`DROP INDEX ${q.index(indexName)} ON ${q.table};`];
    },
    customTemplate(target) {
      const sch = target.schema || 'schema';
      const tbl = target.table || 'table';
      return `-- Custom fragmentation probe (must return index_name, fragmentation_percent)
SELECT i.name AS index_name,
       CAST(ps.avg_fragmentation_in_percent AS float) AS fragmentation_percent,
       CAST(ps.page_count AS bigint) AS page_count,
       (SELECT MAX(v) FROM (VALUES (us.last_user_seek),(us.last_user_scan),(us.last_user_lookup),(us.last_user_update)) AS t(v)) AS last_used,
       CAST(ISNULL(us.user_seeks,0)+ISNULL(us.user_scans,0)+ISNULL(us.user_lookups,0) AS bigint) AS scan_count
FROM sys.dm_db_index_physical_stats(DB_ID(), OBJECT_ID(N'${sch}.${tbl}'), NULL, NULL, 'DETAILED') ps
JOIN sys.indexes i ON ps.object_id = i.object_id AND ps.index_id = i.index_id
LEFT JOIN sys.dm_db_index_usage_stats us
  ON us.database_id = DB_ID() AND us.object_id = i.object_id AND us.index_id = i.index_id
WHERE i.name IS NOT NULL AND ps.index_level = 0;`;
    },
  };
}

export const sqlServerIndexFragmentation = makeSqlServerIndexFragmentation('sqlserver', 'SQL Server');
