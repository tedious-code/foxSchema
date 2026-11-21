import { makeSqlServerIndexFragmentation } from '../sqlServer/sqlserver.index-fragmentation.js';

// Same DMVs as SQL Server.
export const azureSqlIndexFragmentation = makeSqlServerIndexFragmentation('azuresql', 'Azure SQL');
