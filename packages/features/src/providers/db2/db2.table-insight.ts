/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2: SYSCAT.COLUMNS.COLCARD / SYSCAT.TABLES.CARD. No live COUNT(DISTINCT).
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
  hint: 'Db2: SYSCAT.COLUMNS.COLCARD and SYSCAT.TABLES.CARD.',
};

const SQL = `
SELECT
  c.COLNAME AS column_name,
  c.COLCARD AS n_distinct,
  NULL AS null_frac,
  t.CARD AS estimated_rows
FROM SYSCAT.COLUMNS c
JOIN SYSCAT.TABLES t
  ON t.TABSCHEMA = c.TABSCHEMA AND t.TABNAME = c.TABNAME
WHERE c.TABSCHEMA = ? AND c.TABNAME = ?
ORDER BY c.COLNO
`.trim();

export const db2TableInsight: TableInsightDialect = {
  id: 'db2',
  support: SUPPORT,
  probe(target: TableInsightTarget): TableInsightQuery {
    return {
      mode: 'catalog',
      sql: SQL,
      params: [(target.schema || '').toUpperCase(), target.table.toUpperCase()],
    };
  },
};
