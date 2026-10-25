import { type SchemaProvider } from '@foxschema/sql';
import { Db2Provider } from './db2/db2.provider.js';
import { PostgresProvider } from './postgres/postgres.provider.js';
import { MysqlProvider } from './mysql/mysql.provider.js';
import { MariadbProvider } from './mysql/mariadb.provider.js';
import { SqlServerProvider } from './sqlServer/sqlserver.provider.js';
import { OracleProvider } from './oracle/oracle.provider.js';
import { SqliteProvider } from './sqlLite/sqlLite.provider.js';
import { RedshiftProvider } from './redshift/redshift.provider.js';
import { ClickHouseProvider } from './clickHouse/clickhouse.provider.js';
import { AzureSqlProvider } from './azureSql/azuresql.provider.js';
import { CockroachDbProvider } from './cockroachDb/cockroachdb.provider.js';
import { YugabyteDbProvider } from './yugabyteDb/yugabytedb.provider.js';
import { TiDbProvider } from './tiDb/tidb.provider.js';
import { DuckDbProvider } from './duckDb/duckdb.provider.js';
import { RedisProvider } from './redis/redis.provider.js';

// Register a dialect's schema provider (queries) here — one line per platform.
export const PROVIDERS: Record<string, SchemaProvider> = {
  db2: new Db2Provider(),
  postgres: new PostgresProvider(),
  mysql: new MysqlProvider(),
  mariadb: new MariadbProvider(),
  sqlserver: new SqlServerProvider(),
  oracle: new OracleProvider(),
  sqlite: new SqliteProvider(),
  redshift: new RedshiftProvider(),
  clickhouse: new ClickHouseProvider(),
  azuresql: new AzureSqlProvider(),
  cockroachdb: new CockroachDbProvider(),
  yugabytedb: new YugabyteDbProvider(),
  tidb: new TiDbProvider(),
  duckdb: new DuckDbProvider(),
  // Browsing only: keyspace as tables. Compare and history refuse Redis
  // (`schemaCompareSupport`), so nothing diffs or generates DDL for it.
  redis: new RedisProvider(),
};

export function getRegisteredProvider(dialect: string): SchemaProvider {
  const provider = PROVIDERS[dialect.toLowerCase()];
  if (!provider) {
    throw new Error(`No provider registered for dialect: ${dialect}`);
  }
  return provider;
}
