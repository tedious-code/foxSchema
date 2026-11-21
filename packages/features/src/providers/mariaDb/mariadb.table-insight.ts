import { makeMysqlTableInsight } from '../mysql/mysql.table-insight.js';

export const mariaDbTableInsight = makeMysqlTableInsight(
  'mariadb',
  'MariaDB: information_schema.TABLES / STATISTICS.'
);
