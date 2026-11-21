import { makePostgresTableInsight } from '../postgres/postgres.table-insight.js';

export const redshiftTableInsight = makePostgresTableInsight(
  'redshift',
  'Redshift: pg_stats-style catalog estimates. Table size is not reported.',
  // Redshift has no pg_total_relation_size; size lives in SVV_TABLE_INFO,
  // which is a different query and not a drop-in expression here. The local
  // e2e "redshift" is a real Postgres, so baking the Postgres expression in
  // would pass every test here and fail on the actual warehouse.
  'NULL'
);
