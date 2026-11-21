/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server: partition row counts. No COUNT(DISTINCT) on live tables.
 */
import type {
  TableInsightDialect,
  TableInsightQuery,
  TableInsightSupport,
  TableInsightTarget,
} from '../../modules/utilities/table-insight.types.js';

const SUPPORT: TableInsightSupport = {
  mode: 'catalog',
  query: true,
  hint: 'SQL Server: sys.dm_db_partition_stats row counts (catalog).',
};

const SQL = `
SELECT
  c.name AS column_name,
  NULL AS n_distinct,
  NULL AS null_frac,
  sz.estimated_rows,
  sz.size_bytes
FROM sys.tables t
INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
-- Table-level totals, computed once per table.
--
-- These used to be SUM(...) OVER () beside the LEFT JOIN to sys.columns, which
-- fans the result out to one row per column: the window then summed the fanned
-- set and every scalar came back multiplied by the column count. A 20-column
-- table reported 20x its rows and 20x its size. CROSS APPLY keeps the
-- aggregate on its own row set, where the column join cannot reach it.
CROSS APPLY (
  SELECT
    -- Rows live only in the heap or clustered index; counting every index
    -- would multiply by the number of indexes instead.
    SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS estimated_rows,
    -- Size is table *and* indexes, so every partition counts. Pages are always
    -- 8 KB on SQL Server, so the conversion is exact rather than an estimate.
    SUM(p.used_page_count) * 8192 AS size_bytes
  FROM sys.dm_db_partition_stats p
  WHERE p.object_id = t.object_id
) sz
LEFT JOIN sys.columns c ON c.object_id = t.object_id
WHERE s.name = @p0 AND t.name = @p1
`.trim();

export function makeSqlServerTableInsight(id: string, hint = SUPPORT.hint): TableInsightDialect {
  return {
    id,
    support: { ...SUPPORT, hint },
    probe(target: TableInsightTarget): TableInsightQuery {
      return {
        mode: 'catalog',
        sql: SQL,
        params: [target.schema || 'dbo', target.table],
      };
    },
  };
}

export const sqlServerTableInsight = makeSqlServerTableInsight('sqlserver');
