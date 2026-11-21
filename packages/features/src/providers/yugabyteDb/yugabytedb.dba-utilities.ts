import { makePostgresDbaUtilities } from '../postgres/postgres.dba-utilities.js';

export const yugabyteDbDbaUtilities = makePostgresDbaUtilities({
  id: 'yugabytedb',
  mode: 'estimated',
  hintSuffix: '(YugabyteDB may differ).',
});
