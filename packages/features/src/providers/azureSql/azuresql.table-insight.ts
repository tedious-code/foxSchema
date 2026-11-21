import { makeSqlServerTableInsight } from '../sqlServer/sqlserver.table-insight.js';

export const azureSqlTableInsight = makeSqlServerTableInsight(
  'azuresql',
  'Azure SQL: sys.dm_db_partition_stats row counts (catalog).'
);
