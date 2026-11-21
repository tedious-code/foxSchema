import { CUSTOM_HINT } from '../../modules/utilities/index-fragmentation.types.js';
import {
  MYSQL_INDEX_IO_USAGE_SQL,
  makeMysqlIndexFragmentation,
  mysqlCustomTemplate,
} from '../mysql/mysql.index-fragmentation.js';

// MariaDB adds the userstat plugin's INDEX_STATISTICS as a second usage source.
const INDEX_STATISTICS_SQL = `
SELECT INDEX_NAME AS index_name,
       CAST(NULL AS DATETIME) AS last_used,
       ROWS_READ AS scan_count
FROM information_schema.INDEX_STATISTICS
WHERE TABLE_SCHEMA = ?
  AND TABLE_NAME = ?
`.trim();

export const mariaDbIndexFragmentation = makeMysqlIndexFragmentation({
  id: 'mariadb',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'MariaDB: table-level DATA_FREE ratio (same estimate on each index). Usage from performance_schema, then information_schema.INDEX_STATISTICS (userstat).',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Optimize',
  usageQueries: (schema, table) => [
    { params: [schema, table], sql: MYSQL_INDEX_IO_USAGE_SQL },
    { params: [schema, table], sql: INDEX_STATISTICS_SQL },
  ],
  defragSql: (table) => [`OPTIMIZE TABLE ${table};`],
  customTemplate: mysqlCustomTemplate,
});
