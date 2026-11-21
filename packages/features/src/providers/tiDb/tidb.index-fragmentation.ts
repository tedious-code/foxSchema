import { CUSTOM_HINT } from '../../modules/utilities/index-fragmentation.types.js';
import {
  MYSQL_INDEX_IO_USAGE_SQL,
  makeMysqlIndexFragmentation,
} from '../mysql/mysql.index-fragmentation.js';

const CLUSTER_USAGE_SQL = `
SELECT INDEX_NAME AS index_name,
       LAST_ACCESS_TIME AS last_used,
       QUERY_TOTAL AS scan_count
FROM INFORMATION_SCHEMA.CLUSTER_TIDB_INDEX_USAGE
WHERE TABLE_SCHEMA = ?
  AND TABLE_NAME = ?
`.trim();

const NODE_USAGE_SQL = `
SELECT INDEX_NAME AS index_name,
       LAST_ACCESS_TIME AS last_used,
       QUERY_TOTAL AS scan_count
FROM INFORMATION_SCHEMA.TIDB_INDEX_USAGE
WHERE TABLE_SCHEMA = ?
  AND TABLE_NAME = ?
`.trim();

export const tiDbIndexFragmentation = makeMysqlIndexFragmentation({
  id: 'tidb',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'TiDB: table-level DATA_FREE-style estimate. Last used from INFORMATION_SCHEMA.TIDB_INDEX_USAGE (LAST_ACCESS_TIME, QUERY_TOTAL).',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Optimize',
  usageQueries: (schema, table) => [
    { params: [schema, table], sql: CLUSTER_USAGE_SQL },
    { params: [schema, table], sql: NODE_USAGE_SQL },
    { params: [schema, table], sql: MYSQL_INDEX_IO_USAGE_SQL },
  ],
  // TiDB answers OPTIMIZE TABLE with "OPTIMIZE TABLE is not supported" — it
  // compacts storage itself and gives no way to ask. Refreshing the optimiser
  // statistics is the real, supported maintenance here.
  defragSql: (table) => [`ANALYZE TABLE ${table};`],
  customTemplate: (target) => {
    const sch = target.schema || 'schema';
    const tbl = target.table || 'table';
    return `SELECT INDEX_NAME AS index_name, NULL AS fragmentation_percent,
       LAST_ACCESS_TIME AS last_used, QUERY_TOTAL AS scan_count
FROM INFORMATION_SCHEMA.TIDB_INDEX_USAGE
WHERE TABLE_SCHEMA = '${sch}' AND TABLE_NAME = '${tbl}';`;
  },
});
