import { useLoaded } from '../lib/useLoaded';
import { formatSql, loadSqlFormatter } from './formatSql';

export type SqlFormat = (sql: string, dialect: string) => string;

const unformatted: SqlFormat = (sql) => sql;

/**
 * `formatSql` for a component that formats while it renders. Until
 * sql-formatter has loaded this returns the text unchanged; when it arrives the
 * function changes once, so a `useMemo` that lists it re-runs and the DDL is
 * re-shown formatted. If the load fails the text simply stays unformatted.
 */
export function useSqlFormat(): SqlFormat {
  return useLoaded(loadSqlFormatter) ? formatSql : unformatted;
}
