/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MySQL: information_schema.TABLES.TABLE_ROWS + STATISTICS.CARDINALITY.
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
  hint: 'MySQL: information_schema.TABLES / STATISTICS (SHOW TABLE STATUS equivalent).',
};

const SQL = `
SELECT
  s.COLUMN_NAME AS column_name,
  s.CARDINALITY AS n_distinct,
  NULL AS null_frac,
  t.TABLE_ROWS AS estimated_rows,
  -- What the engine itself reports for the table: data plus indexes. InnoDB
  -- rounds to extent boundaries, so this is the engine's own answer rather
  -- than a byte-exact one, and it is the number every MySQL tool shows.
  (t.DATA_LENGTH + t.INDEX_LENGTH) AS size_bytes
FROM information_schema.TABLES t
LEFT JOIN information_schema.STATISTICS s
  ON s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME
WHERE t.TABLE_SCHEMA = ?
  AND t.TABLE_NAME = ?
ORDER BY s.SEQ_IN_INDEX, s.COLUMN_NAME
`.trim();

export function makeMysqlTableInsight(id: string, hint = SUPPORT.hint): TableInsightDialect {
  return {
    id,
    support: { ...SUPPORT, hint },
    probe(target: TableInsightTarget): TableInsightQuery {
      return {
        mode: 'catalog',
        sql: SQL,
        params: [target.schema, target.table],
      };
    },
  };
}

export const mysqlTableInsight = makeMysqlTableInsight('mysql');
