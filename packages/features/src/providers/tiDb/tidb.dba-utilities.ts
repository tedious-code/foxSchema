import { makeMysqlDbaUtilities } from '../mysql/mysql.dba-utilities.js';

// MySQL-shaped everywhere except where status variables live.
export const tiDbDbaUtilities = makeMysqlDbaUtilities({
  id: 'tidb',
  label: 'TiDB',
  mode: 'estimated',
  statusTable: 'information_schema.global_status',
});
