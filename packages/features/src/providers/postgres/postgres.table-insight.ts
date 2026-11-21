/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL: pg_stats + pg_class.reltuples. No live COUNT(DISTINCT).
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
  hint: 'PostgreSQL: pg_stats.n_distinct and pg_class.reltuples (ANALYZE).',
};

/**
 * `pg_total_relation_size` is table plus indexes plus TOAST, in bytes, and it
 * is exact rather than estimated. Redshift does not have it — its stand-in in
 * this repo is a real Postgres, so a test would happily pass while production
 * failed — which is why the expression is a parameter and not baked in here.
 */
const SIZE_EXPR = 'pg_total_relation_size(c.oid)';

const sqlFor = (sizeExpr: string) => `
SELECT
  s.attname AS column_name,
  s.n_distinct AS n_distinct,
  s.null_frac AS null_frac,
  c.reltuples::bigint AS estimated_rows,
  ${sizeExpr} AS size_bytes
FROM pg_stats s
JOIN pg_namespace n ON n.nspname = s.schemaname
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.tablename
WHERE s.schemaname = $1
  AND s.tablename = $2
ORDER BY s.attname
`.trim();

export function makePostgresTableInsight(
  id: string,
  hint = SUPPORT.hint,
  /** Pass 'NULL' for an engine without pg_total_relation_size. */
  sizeExpr: string = SIZE_EXPR
): TableInsightDialect {
  const sql = sqlFor(sizeExpr);
  return {
    id,
    support: { ...SUPPORT, hint },
    probe(target: TableInsightTarget): TableInsightQuery {
      return {
        mode: 'catalog',
        sql,
        params: [target.schema || 'public', target.table],
      };
    },
  };
}

export const postgresTableInsight = makePostgresTableInsight('postgres');
