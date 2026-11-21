import { makePostgresTableInsight } from '../postgres/postgres.table-insight.js';

export const yugabyteDbTableInsight = makePostgresTableInsight(
  'yugabytedb',
  'YugabyteDB: pg_stats / table statistics (estimated).'
);
