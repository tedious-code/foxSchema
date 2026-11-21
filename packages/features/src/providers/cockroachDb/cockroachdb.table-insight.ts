import { makePostgresTableInsight } from '../postgres/postgres.table-insight.js';

export const cockroachDbTableInsight = makePostgresTableInsight(
  'cockroachdb',
  'CockroachDB: pg_stats / table statistics (estimated). Table size is not reported.',
  // CockroachDB accepts pg_total_relation_size and always answers NULL — it is
  // a compatibility stub, not an implementation. Measured on v26.3.0:
  //   SELECT pg_total_relation_size('demo_a.orders'::regclass);  ->  NULL
  // Asking for it costs a call and returns nothing, so say so up front.
  'NULL'
);
