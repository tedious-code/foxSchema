/**
 * The sql-formatter grammars Fox Schema formats with, and nothing more.
 *
 * `format()` with a language name keeps every grammar the package has (19);
 * `formatDialect()` with the grammar objects keeps only those imported here.
 * The eight unused ones (BigQuery, Db2 for i, Hive, N1QL, Spark, Trino,
 * SingleStore, Snowflake) were 70 kB of the first Format. Loaded on demand by
 * formatSql.ts, which maps each Fox Schema dialect to one of these.
 */
import {
  clickhouse,
  db2,
  duckdb,
  formatDialect,
  mariadb,
  mysql,
  plsql,
  postgresql,
  redshift,
  sql,
  sqlite,
  tidb,
  transactsql,
} from 'sql-formatter';

export { formatDialect };

export const GRAMMARS = {
  clickhouse,
  db2,
  duckdb,
  mariadb,
  mysql,
  plsql,
  postgresql,
  redshift,
  sql,
  sqlite,
  tidb,
  tsql: transactsql,
} as const;

export type GrammarName = keyof typeof GRAMMARS;
