import { makeMysqlTableInsight } from '../mysql/mysql.table-insight.js';

export const tiDbTableInsight = makeMysqlTableInsight(
  'tidb',
  'TiDB: information_schema.TABLES / STATISTICS.'
);
