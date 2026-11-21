import { type DriverAdapter } from '@foxschema/sql';
import { addonPackageFor, missingAddonMessage } from '../plugins/addon-packages.js';
import { postgresAdapter } from './postgres/postgres.adapter.js';
import { mysqlAdapter } from './mysql/mysql.adapter.js';
import { sqlServerAdapter } from './sqlServer/sqlserver.adapter.js';
import { oracleAdapter } from './oracle/oracle.adapter.js';
import { sqliteAdapter } from './sqlLite/sqlLite.adapter.js';
import { redshiftAdapter } from './redshift/redshift.adapter.js';
import { clickHouseAdapter } from './clickHouse/clickhouse.adapter.js';
import { azureSqlAdapter } from './azureSql/azuresql.adapter.js';
import { duckDbAdapter } from './duckDb/duckdb.adapter.js';
import { mongoDbAdapter } from './mongodb/mongodb.adapter.js';
import { redisAdapter } from './redis/redis.adapter.js';

// Register a dialect's native driver adapter here — one line per platform.
// Db2 is an add-on (@foxschema/db-db2) and joins this map through
// registerDialectPlugin (plugins/dialect-plugin.ts).
// MariaDB shares the mysql2 adapter (same wire protocol & driver).
export const ADAPTERS: Record<string, DriverAdapter> = {
  [postgresAdapter.dialect]: postgresAdapter,
  cockroachdb: postgresAdapter, // Postgres wire-compatible — shares the pg adapter.
  yugabytedb: postgresAdapter,  // Postgres wire-compatible — shares the pg adapter.
  [mysqlAdapter.dialect]: mysqlAdapter,
  mariadb: mysqlAdapter, // MariaDB shares the mysql2 adapter (same wire protocol & driver).
  tidb: mysqlAdapter,    // MySQL wire-compatible — shares the mysql2 adapter.
  [sqlServerAdapter.dialect]: sqlServerAdapter,
  [oracleAdapter.dialect]: oracleAdapter,
  [sqliteAdapter.dialect]: sqliteAdapter,
  // Not SQL engines: statements are translated by parseSqlSubset. They are
  // registered for the editor and data migrate only — schema diff does not
  // apply to a schemaless store, so neither appears in DIALECT_MAP.
  [mongoDbAdapter.dialect]: mongoDbAdapter,
  [redisAdapter.dialect]: redisAdapter,
  [redshiftAdapter.dialect]: redshiftAdapter,
  [clickHouseAdapter.dialect]: clickHouseAdapter,
  [azureSqlAdapter.dialect]: azureSqlAdapter,
  [duckDbAdapter.dialect]: duckDbAdapter,
};

export function getAdapter(dialect: string): DriverAdapter {
  const adapter = ADAPTERS[dialect.toLowerCase()];
  if (!adapter) {
    if (addonPackageFor(dialect)) throw new Error(missingAddonMessage(dialect));
    throw new Error(`Unsupported dialect: ${dialect}`);
  }
  return adapter;
}
