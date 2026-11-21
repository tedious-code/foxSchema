import { makeSqlServerDbaUtilities } from '../sqlServer/sqlserver.dba-utilities.js';

// Same DMVs as SQL Server.
export const azureSqlDbaUtilities = makeSqlServerDbaUtilities('azuresql', 'Azure SQL');
