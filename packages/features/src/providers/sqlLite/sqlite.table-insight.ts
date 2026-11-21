/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQLite: sqlite_stat1 after ANALYZE. No live COUNT(DISTINCT).
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
  hint: 'SQLite: sqlite_stat1 (run ANALYZE). Empty until statistics exist.',
};

const SQL = `
SELECT
  idx AS column_name,
  stat AS n_distinct,
  NULL AS null_frac,
  CAST(NULL AS INTEGER) AS estimated_rows
FROM sqlite_stat1
WHERE tbl = ?
`.trim();

export function makeSqliteTableInsight(id: string, hint = SUPPORT.hint): TableInsightDialect {
  return {
    id,
    support: { ...SUPPORT, hint },
    probe(target: TableInsightTarget): TableInsightQuery {
      return {
        mode: 'catalog',
        sql: SQL,
        params: [target.table],
      };
    },
  };
}

export const sqliteTableInsight = makeSqliteTableInsight('sqlite');
