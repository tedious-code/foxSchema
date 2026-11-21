import { CUSTOM_HINT } from '../../modules/utilities/index-fragmentation.types.js';
import { makePostgresIndexFragmentation } from '../postgres/postgres.index-fragmentation.js';

export const yugabyteDbIndexFragmentation = makePostgresIndexFragmentation({
  id: 'yugabytedb',
  support: {
    mode: 'estimated',
    query: true,
    // REINDEX in any form answers "REINDEX not supported yet".
    defrag: false,
    hint: 'YugabyteDB: index size and usage from the core catalogs. Indexes are LSM-backed, so there is no leaf fragmentation to measure and REINDEX is not supported yet.',
    customSqlHint: CUSTOM_HINT,
  },
  hasPgstatindex: false,
  reindexConcurrently: true,
});
