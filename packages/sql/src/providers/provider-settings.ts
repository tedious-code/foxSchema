import { type ProviderConnectionSettings } from '../interfaces/schema-provider.interface.js';
import { postgresSettings } from './postgres/postgres.settings.js';
import { mysqlSettings } from './mysql/mysql.settings.js';
import { db2Settings } from './db2/db2.settings.js';
import { mariaDbSettings } from './mariaDb/mariaDb.settings.js';
import { sqlServerSettings } from './sqlServer/sqlserver.settings.js';
import { oracleSettings } from './oracle/oracle.settings.js';
import { sqliteSettings } from './sqlLite/sqlLite.settings.js';
import { redshiftSettings } from './redshift/redshift.settings.js';
import { clickHouseSettings } from './clickHouse/clickhouse.settings.js';
import { azureSqlSettings } from './azureSql/azuresql.settings.js';
import { cockroachDbSettings } from './cockroachDb/cockroachdb.settings.js';
import { yugabyteDbSettings } from './yugabyteDb/yugabytedb.settings.js';
import { tiDbSettings } from './tiDb/tidb.settings.js';
import { duckDbSettings } from './duckDb/duckdb.settings.js';
import { redisSettings } from './redis/redis.settings.js';
import { mongoDbSettings } from './mongodb/mongodb.settings.js';

// Register a new dialect by adding its settings here — nothing else changes
export const PROVIDER_SETTINGS: Record<string, ProviderConnectionSettings> = {
  [postgresSettings.dialect]: postgresSettings,
  [mysqlSettings.dialect]: mysqlSettings,
  [mariaDbSettings.dialect]: mariaDbSettings,
  [db2Settings.dialect]: db2Settings,
  [sqlServerSettings.dialect]: sqlServerSettings,
  [oracleSettings.dialect]: oracleSettings,
  [sqliteSettings.dialect]: sqliteSettings,
  [redshiftSettings.dialect]: redshiftSettings,
  [clickHouseSettings.dialect]: clickHouseSettings,
  [azureSqlSettings.dialect]: azureSqlSettings,
  [cockroachDbSettings.dialect]: cockroachDbSettings,
  [yugabyteDbSettings.dialect]: yugabyteDbSettings,
  [tiDbSettings.dialect]: tiDbSettings,
  [duckDbSettings.dialect]: duckDbSettings,
  // Not SQL engines — statements are translated by parseSqlSubset. They are
  // here so a connection can be created and used from the SQL editor and data
  // migrate; they are deliberately absent from DIALECT_MAP, which drives
  // schema diff and DDL generation.
  [redisSettings.dialect]: redisSettings,
  [mongoDbSettings.dialect]: mongoDbSettings,
};

export function getProviderSettings(dialect: string): ProviderConnectionSettings {
  const settings = PROVIDER_SETTINGS[dialect.toLowerCase()];
  if (!settings) {
    throw new Error(`Unsupported dialect: ${dialect}`);
  }
  return settings;
}

/**
 * Every dialect this package can build a connection for.
 *
 * `PROVIDER_SETTINGS` is keyed by `string`, so it cannot give callers a checked
 * set of names. The frontend needed one and had been carrying its own copy of
 * this union beside its own copy of the whole registry; both live here now.
 *
 * `PROVIDER_SETTINGS` is built with computed keys (`[postgresSettings.dialect]`),
 * which TypeScript widens to `string`, so the two cannot be tied together at
 * compile time — the obvious `Record<Dialect, …>` assertion needs a cast, and
 * the cast makes it pass unconditionally. `dialect-registry.test.ts` checks the
 * union against the registry's actual keys instead.
 */
export type Dialect =
  | 'postgres'
  | 'cockroachdb'
  | 'yugabytedb'
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'db2'
  | 'sqlserver'
  | 'azuresql'
  | 'oracle'
  | 'sqlite'
  | 'duckdb'
  | 'clickhouse'
  | 'redshift'
  | 'redis'
  | 'mongodb';

/**
 * Dialects that are a file on disk rather than a server.
 *
 * They have no host, port, user or password, so anything that asks for one has
 * to know not to. Selecting a saved SQLite connection used to open a password
 * prompt — the credential form had stopped offering a password to store, and
 * the picker still treated "no stored password" as "ask the user for one",
 * which snapped the selection back and left no target set.
 */
export const DIALECTS: readonly Dialect[] = [
  'postgres',
  'cockroachdb',
  'yugabytedb',
  'mysql',
  'mariadb',
  'tidb',
  'db2',
  'sqlserver',
  'azuresql',
  'oracle',
  'sqlite',
  'duckdb',
  'clickhouse',
  'redshift',
  'redis',
  'mongodb',
];

/**
 * Dialects that speak another dialect's wire protocol and SQL, keyed to that
 * base dialect. Anything not listed is its own family.
 *
 * Redshift is in the PostgreSQL family (its grammar and privilege model follow
 * Postgres); a caller that must treat it differently — no triggers, a different
 * boolean literal set — checks for it before asking for the family.
 */
const DIALECT_FAMILY: Partial<Record<Dialect, 'mysql' | 'postgres' | 'sqlserver'>> = {
  mariadb: 'mysql',
  tidb: 'mysql',
  cockroachdb: 'postgres',
  yugabytedb: 'postgres',
  redshift: 'postgres',
  azuresql: 'sqlserver',
};

/**
 * The base dialect whose syntax this one follows: `mysql` for MariaDB and
 * TiDB, `postgres` for CockroachDB, YugabyteDB and Redshift, `sqlserver` for
 * Azure SQL; otherwise the dialect itself, lower-cased.
 */
export function dialectFamily(dialect: string): string {
  const d = (dialect || '').toLowerCase();
  return Object.hasOwn(DIALECT_FAMILY, d) ? DIALECT_FAMILY[d as Dialect]! : d;
}

/**
 * Whether a batch on this engine can be rolled back. ClickHouse, Redis and
 * MongoDB answer `false`: their adapters open no transaction, so a "one
 * transaction" run there commits each statement as it goes, and a failure
 * leaves the earlier ones in place while the editor reported a rollback.
 * An unknown dialect answers `true`; it is refused elsewhere.
 */
export function dialectHasTransactions(dialect: string): boolean {
  return PROVIDER_SETTINGS[(dialect || '').toLowerCase()]?.transactions !== false;
}

export function isFileDialect(dialect: string): boolean {
  const name = dialect.toLowerCase();
  return name === 'sqlite' || name === 'duckdb';
}
