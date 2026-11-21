import { makePostgresDbaUtilities } from '../postgres/postgres.dba-utilities.js';

// Postgres-wire, but every figure is an estimate and there is no
// pg_postmaster_start_time() to read uptime from.
export const cockroachDbDbaUtilities = makePostgresDbaUtilities({
  id: 'cockroachdb',
  mode: 'estimated',
  hintSuffix: '(CockroachDB may differ).',
  hasPostmasterStartTime: false,
});
