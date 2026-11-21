import { CUSTOM_HINT } from '../../modules/utilities/index-fragmentation.types.js';
import { makePostgresIndexFragmentation } from '../postgres/postgres.index-fragmentation.js';

export const cockroachDbIndexFragmentation = makePostgresIndexFragmentation({
  id: 'cockroachdb',
  support: {
    mode: 'estimated',
    query: true,
    // REINDEX is rejected as "unimplemented: this syntax", and the server's own
    // hint explains why there is nothing to offer: "CockroachDB does not
    // require reindexing." Emitting a statement that always errors is worse
    // than saying so.
    defrag: false,
    hint: 'CockroachDB: index size and usage from the core catalogs (no pgstattuple). Storage is compacted automatically — CockroachDB does not require reindexing.',
    customSqlHint: CUSTOM_HINT,
  },
  hasPgstatindex: false,
  reindexConcurrently: false,
});
