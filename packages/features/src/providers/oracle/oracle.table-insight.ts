/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle: ALL_TAB_COL_STATISTICS / ALL_TAB_STATISTICS. No live COUNT(DISTINCT).
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
  hint: 'Oracle: ALL_TAB_COL_STATISTICS (NUM_DISTINCT) and NUM_ROWS.',
};

const SQL = `
SELECT
  c.column_name AS column_name,
  c.num_distinct AS n_distinct,
  CASE WHEN t.num_rows IS NULL OR t.num_rows = 0 THEN NULL
       ELSE c.num_nulls / t.num_rows END AS null_frac,
  t.num_rows AS estimated_rows
FROM all_tab_col_statistics c
JOIN all_tab_statistics t
  ON t.owner = c.owner AND t.table_name = c.table_name
WHERE c.owner = :1 AND c.table_name = :2
ORDER BY c.column_name
`.trim();

export const oracleTableInsight: TableInsightDialect = {
  id: 'oracle',
  support: SUPPORT,
  probe(target: TableInsightTarget): TableInsightQuery {
    return {
      mode: 'catalog',
      sql: SQL,
      params: [(target.schema || '').toUpperCase(), target.table.toUpperCase()],
    };
  },
};
