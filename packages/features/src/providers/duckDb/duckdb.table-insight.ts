import { makeSqliteTableInsight } from '../sqlLite/sqlite.table-insight.js';

export const duckDbTableInsight = makeSqliteTableInsight(
  'duckdb',
  'DuckDB: sqlite_stat1-style catalog stats when ANALYZE has run.'
);
