import { ConnectionFactory, getAdapter, type ConnectionOptions } from '@foxschema/db';
import { autoAliasSelectColumns, errorMessage } from '@foxschema/sql';
import { isPageableStatement, trimPageProbe, wrapSqlForPage, wrapSqlForSeek, type SqlSeek } from './sql-page-wrap.service';

/**
 * Helpers behind POST /api/sql/execute (SQL Editor). One request = one
 * credential + N statements; the frontend fans out across credentials with
 * parallel requests. Statements run sequentially on one connection (so
 * SET CURRENT SCHEMA / search_path sticks); each result is isolated so one
 * broken statement doesn't hide the others.
 */

export interface StatementResultOk {
  ok: true;
  columns: string[];
  /** Rows as arrays in `columns` order, cells JSON-safe (BigInt→string, Date→ISO). */
  rows: unknown[][];
  rowCount: number;
  /** True when the driver returned more rows than maxRows and the tail was dropped. */
  truncated: boolean;
  /** True when another page is available (page probe). */
  hasNext?: boolean;
  durationMs: number;
}
export interface StatementResultErr {
  ok: false;
  error: string;
  durationMs: number;
}
export type StatementResult = StatementResultOk | StatementResultErr;

export const MAX_STATEMENTS = 25;
export const MAX_STATEMENT_LENGTH = 100_000;

/** A statement `runStatements` will accept: a non-blank, length-capped string. */
export function isRunnableStatement(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_STATEMENT_LENGTH;
}
const MAX_ROWS_CAP = 5000;
const DEFAULT_MAX_ROWS = 200;

export function clampMaxRows(v: unknown): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROWS;
  return Math.min(Math.max(n, 1), MAX_ROWS_CAP);
}

/** One JSON-safe cell. Drivers hand back BigInt/Date/Buffer/objects that JSON.stringify either rejects or mangles. */
function serializeCell(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) {
    // Display-only hex. Long values are truncated for payload size — Peek / result
    // grid CRUD refuses tables with binary columns so this string is never written
    // back (see assessPeekEditability / columnTypeIsBinary).
    const hex = Buffer.from(v).toString('hex');
    return `0x${hex.length > 64 ? hex.slice(0, 64) + '…' : hex}`;
  }
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

/**
 * Shape raw driver rows into {columns, rows} for the grid. Column names are the
 * union of keys over the first 50 kept rows (empty result ⇒ no column names —
 * accepted v1 limitation, the UI shows "0 rows"). Non-array driver results
 * (e.g. a mysql2 OkPacket from a write) are treated as an empty result set.
 */
export function shapeRows(raw: unknown, maxRows: number): Omit<StatementResultOk, 'ok' | 'durationMs'> {
  const all: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];
  const truncated = all.length > maxRows;
  const kept = truncated ? all.slice(0, maxRows) : all;

  const colSet = new Set<string>();
  for (const row of kept.slice(0, 50)) {
    if (row && typeof row === 'object') for (const k of Object.keys(row)) colSet.add(k);
  }
  const columns = [...colSet];
  const rows = kept.map((r) => columns.map((c) => serializeCell(r?.[c])));
  return { columns, rows, rowCount: kept.length, truncated };
}

/**
 * Shape positional driver rows for the grid.
 *
 * The counterpart to {@link shapeRows} for drivers that can return rows as
 * arrays. Duplicate column names survive here, which is the whole point: a
 * join selecting `id` from four tables keeps four `id` columns instead of one.
 */
export function shapePositional(
  raw: { columns: string[]; rows: unknown[][] },
  maxRows: number
): Omit<StatementResultOk, 'ok' | 'durationMs'> {
  const all = Array.isArray(raw.rows) ? raw.rows : [];
  const truncated = all.length > maxRows;
  const kept = truncated ? all.slice(0, maxRows) : all;
  const columns = Array.isArray(raw.columns) ? raw.columns : [];
  return {
    columns,
    rows: kept.map((r) => columns.map((_, i) => serializeCell(r?.[i]))),
    rowCount: kept.length,
    truncated,
  };
}

/**
 * Run statements in order against one credential, isolating failures per statement.
 * Applies `schema` the same way migration does (connection option + adapter
 * setCurrentSchema) so unqualified names resolve — e.g. DB2 CURRENT SCHEMA
 * instead of the auth-id default (CARTER.ORDERS).
 */
export async function runStatements(
  dialect: string,
  option: ConnectionOptions,
  statements: string[],
  maxRows: number,
  schema?: string,
  offset = 0,
  /** Bind parameters per statement, aligned by index. Missing = no params. */
  paramsList: readonly (readonly unknown[])[] = [],
  seek?: SqlSeek
): Promise<StatementResult[]> {
  const schemaName = (schema ?? option.schema)?.trim() || '';
  const optionWithSchema: ConnectionOptions = schemaName
    ? { ...option, schema: schemaName }
    : option;

  const connection = await ConnectionFactory.create(dialect, optionWithSchema);
  try {
    if (schemaName) {
      await getAdapter(dialect).setCurrentSchema(connection, schemaName);
    }

    const results: StatementResult[] = [];
    for (const [index, original] of statements.entries()) {
      const started = Date.now();
      // Name any SELECT expression the user left unaliased. The grid keys its
      // columns off the row object, and Postgres calls every unaliased
      // expression `?column?` while SQL Server leaves them unnamed — so
      // `SELECT 1, 2` arrived as a single key and one column silently vanished.
      // The rewrite is conservative and returns the statement untouched
      // whenever it cannot parse the select list with confidence.
      const sql = autoAliasSelectColumns(original).sql;
      // Placeholders survive the paging wrap (it only nests the SQL in a
      // subquery), so the same positional params apply on either path.
      const params = [...(paramsList[index] ?? [])];
      const pushErr = (message: string) => {
        results.push({ ok: false, error: message, durationMs: Date.now() - started });
      };
      const pushUnwrappedOk = async () => {
        // Positional first: it is the only path that survives a join whose
        // tables share a column name. Drivers without it keep the old one.
        const positional = ConnectionFactory.executePositional(dialect, connection, sql, params);
        const shaped = positional
          ? shapePositional(await positional, maxRows)
          : shapeRows(
              await ConnectionFactory.executeOnConnection<Record<string, unknown>>(
                dialect,
                connection,
                sql,
                params
              ),
              maxRows
            );
        results.push({
          ok: true,
          ...shaped,
          hasNext: false,
          durationMs: Date.now() - started,
        });
      };

      // Non-SELECT/DDL/utility: never wrap (avoids a failed subquery attempt).
      // Paging requires a wrap — fail closed when offset > 0.
      if (!isPageableStatement(sql, dialect)) {
        if (offset > 0) {
          pushErr('Cannot page a non-SELECT statement');
          continue;
        }
        try {
          await pushUnwrappedOk();
        } catch (error: unknown) {
          pushErr(errorMessage(error));
        }
        continue;
      }

      let paged = wrapSqlForPage(sql, dialect, offset, maxRows);
      if (seek && offset === 0) {
        const keyed = wrapSqlForSeek(sql, dialect, seek, maxRows, params.length);
        if ('error' in keyed) {
          pushErr(keyed.error);
          continue;
        }
        paged = keyed.sql;
        params.push(...keyed.seekParams);
      } else if (seek && offset > 0) {
        pushErr('Last Id paging cannot skip to an unvisited page; walk Next or use OFFSET when ORDER BY is not unique');
        continue;
      }
      try {
        const positional = ConnectionFactory.executePositional(dialect, connection, paged, params);
        const shaped = positional
          ? shapePositional(await positional, maxRows + 1)
          : shapeRows(
              await ConnectionFactory.executeOnConnection<Record<string, unknown>>(
                dialect,
                connection,
                paged,
                params
              ),
              maxRows + 1
            );
        const page = trimPageProbe(shaped, maxRows);
        results.push({
          ok: true,
          columns: page.columns,
          rows: page.rows,
          rowCount: page.rowCount,
          truncated: page.truncated,
          hasNext: page.hasNext,
          durationMs: Date.now() - started,
        });
      } catch (error: unknown) {
        const wrapMsg = errorMessage(error);
        // Fail closed for all pageable statements: raw fallback can materialize
        // an unbounded result set before shapeRows truncates, and ignores OFFSET.
        // Include the wrapped SQL so DB2 alias / dialect issues are diagnosable.
        const preview = paged.length > 240 ? `${paged.slice(0, 240)}…` : paged;
        pushErr(`Paging failed: ${wrapMsg}\nWrapped SQL: ${preview}`);
      }
    }
    return results;
  } finally {
    await ConnectionFactory.close(dialect, connection);
  }
}
