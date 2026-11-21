/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * ClickHouse: system.tables.total_rows. No live COUNT(DISTINCT).
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
  hint: 'ClickHouse: system.tables.total_rows.',
};

const SQL = `
SELECT
  name AS column_name,
  NULL AS n_distinct,
  NULL AS null_frac,
  total_rows AS estimated_rows
FROM system.tables
WHERE database = $1 AND name = $2
`.trim();

export const clickHouseTableInsight: TableInsightDialect = {
  id: 'clickhouse',
  support: SUPPORT,
  probe(target: TableInsightTarget): TableInsightQuery {
    return {
      mode: 'catalog',
      sql: SQL,
      params: [target.schema, target.table],
    };
  },
};
