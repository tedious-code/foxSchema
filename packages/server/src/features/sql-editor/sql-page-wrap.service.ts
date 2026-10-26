/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wrap a statement so the engine returns a page (LIMIT/OFFSET).
 * Fetches `limit + 1` rows so the caller can detect `hasNext` without a COUNT.
 *
 * Alias must not start with `_` — DB2 treats `_…` as a conditional-compilation
 * directive (SQL20521N). Keep a plain letter-led name for all dialects.
 */

import { isPageableStatement } from '@foxschema/db';
import {
  findTopLevelOrderByIndex,
  isSafeSeekColumn,
  isSubsetDialect,
  isTsqlDialect,
  pageSubsetSelect,
  parseTopLevelOrderBy,
  placeholderStyleFor,
  quoteSqlIdentifier,
  renderPlaceholder,
} from '@foxschema/sql';

export { isPageableStatement };

/** Derived-table alias for page wraps (no leading underscore — see file header). */
const PAGE_ALIAS = 'fox_page';

export function clampOffset(v: unknown): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1_000_000);
}

/**
 * True when `sql` has a top-level `ORDER BY` (paren depth 0), ignoring
 * strings and comments. Used so T-SQL paging can append OFFSET/FETCH to the
 * original statement instead of nesting it in a derived table (SQL Server
 * rejects `ORDER BY` in a subquery without TOP/OFFSET).
 */
export function hasTopLevelOrderBy(sql: string): boolean {
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      i++;
      while (i < n && sql[i] !== ']') i++;
      i = Math.min(n, i + 1);
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }

    if (depth === 0 && (ch === 'o' || ch === 'O')) {
      // Word-boundary ORDER BY at top level.
      if (/\border\s+by\b/i.test(sql.slice(i, i + 16))) {
        const before = i === 0 ? ' ' : sql[i - 1]!;
        if (!/[A-Za-z0-9_]/.test(before)) return true;
      }
    }
    i++;
  }
  return false;
}

/**
 * Best-effort page wrap. Dialects without OFFSET still get a subquery + LIMIT
 * when offset is 0; non-zero offset uses the closest dialect syntax.
 */
/** Dialects whose plain `EXPLAIN` parses and plans a statement without running it. */
const EXPLAIN_PROBE_DIALECTS = new Set([
  'mysql',
  'mariadb',
  'tidb',
  'postgres',
  'postgresql',
  'sqlite',
  'duckdb',
  'clickhouse',
  'cockroach',
  'cockroachdb',
  'yugabyte',
  'yugabytedb',
  'redshift',
]);

/**
 * A probe of the reader's statement that never runs it, used only after a
 * page wrap fails: plain `EXPLAIN`, which parses and plans — and so reports a
 * missing table or column in the statement's own words, rather than as a
 * failure of `SELECT * FROM (…) AS fox_page` — without fetching a row.
 *
 * It used to append `LIMIT 1` and run the statement. That ran it unbounded
 * whenever the limit did not take: a trailing `-- comment` swallowed it, and
 * a `limit` anywhere in the text (a subquery, a string) skipped it. On MySQL
 * the wrapper also fails for valid joins — two `id` columns in a derived
 * table — so that was a whole join materialised to report an error the
 * wrapper had already given. Paging fails closed so nothing is ever read
 * unbounded; a probe must not reopen that.
 */
export function syntaxProbeSql(sql: string, dialect: string): string | null {
  if (!EXPLAIN_PROBE_DIALECTS.has(dialect.toLowerCase())) return null;
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!trimmed) return null;
  return `EXPLAIN ${trimmed}`;
}

export function wrapSqlForPage(
  sql: string,
  dialect: string,
  offset: number,
  limit: number
): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const d = dialect.toLowerCase();
  const inner = trimmed;
  const fetchLimit = limit + 1; // +1 probe row

  // Redis and MongoDB read SQL through a small parser with no subqueries: the
  // page goes onto the statement itself (sql-subset.ts).
  if (isSubsetDialect(d)) return pageSubsetSelect(inner, offset, fetchLimit);

  if (isTsqlDialect(d)) {
    // SQL Server / Azure SQL require ORDER BY for OFFSET/FETCH.
    // Prefer appending to a top-level ORDER BY so paging stays stable and the
    // engine accepts the statement (ORDER BY inside a bare derived table is illegal).
    const fetch = `OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
    if (hasTopLevelOrderBy(inner)) {
      return `${inner} ${fetch}`;
    }
    return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} ORDER BY (SELECT NULL) ${fetch}`;
  }
  if (d === 'oracle') {
    return `SELECT * FROM (${inner}) ${PAGE_ALIAS} OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
  }
  if (d === 'db2') {
    return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} OFFSET ${offset} ROWS FETCH FIRST ${fetchLimit} ROWS ONLY`;
  }
  // Postgres, MySQL, MariaDB, SQLite, Cockroach, Yugabyte, TiDB, DuckDB, ClickHouse-ish
  return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} LIMIT ${fetchLimit} OFFSET ${offset}`;
}

/** Longest key a compare run orders by: more columns than this is not a key. */
const MAX_ORDER_COLUMNS = 8;

/**
 * `orderBy` from a request: plain column names, or nothing. Anything else is
 * refused, never quoted into SQL as given.
 */
export function parseSqlOrderBy(raw: unknown): { ok: true; value?: string[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ORDER_COLUMNS) {
    return { ok: false, error: `orderBy must be 1 to ${MAX_ORDER_COLUMNS} column names` };
  }
  if (!raw.every((c) => typeof c === 'string' && isSafeSeekColumn(c))) {
    return { ok: false, error: 'orderBy must be plain column names' };
  }
  return { ok: true, value: raw as string[] };
}

/**
 * One page of `sql` in `orderBy` order: the order goes on the outer query,
 * where every engine honours it (an ORDER BY inside a derived table is not
 * guaranteed to survive, and SQL Server refuses one without TOP or OFFSET —
 * so on SQL Server a plain top-level ORDER BY of the statement is dropped;
 * the outer one decides anyway). Fetches `limit + 1` so the caller learns
 * whether more rows follow. A compare run reads both sides this way.
 */
export function wrapSqlForOrderedPage(
  sql: string,
  dialect: string,
  orderBy: readonly string[],
  offset: number,
  limit: number
): string {
  const d = dialect.toLowerCase();
  let inner = sql.trim().replace(/;+\s*$/, '');
  const fetchLimit = limit + 1;
  const orderSql = orderBy.map((c) => quoteSqlIdentifier(c, dialect)).join(', ');
  if (isTsqlDialect(d)) {
    const at = findTopLevelOrderByIndex(inner);
    if (at >= 0 && !/\boffset\b/i.test(inner.slice(at))) inner = inner.slice(0, at).trimEnd();
    return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} ORDER BY ${orderSql} OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
  }
  if (d === 'oracle') {
    return `SELECT * FROM (${inner}) ${PAGE_ALIAS} ORDER BY ${orderSql} OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
  }
  if (d === 'db2') {
    return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} ORDER BY ${orderSql} OFFSET ${offset} ROWS FETCH FIRST ${fetchLimit} ROWS ONLY`;
  }
  return `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} ORDER BY ${orderSql} LIMIT ${fetchLimit} OFFSET ${offset}`;
}

export interface SqlSeek {
  columns: string[];
  values: unknown[];
  descending?: boolean | boolean[];
}

export function parseSqlSeek(raw: unknown): { ok: true; value?: SqlSeek } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'seek must be an object with columns and values' };
  }
  const o = raw as { columns?: unknown; values?: unknown; descending?: unknown };
  if (!Array.isArray(o.columns) || !Array.isArray(o.values)) {
    return { ok: false, error: 'seek.columns and seek.values must be arrays' };
  }
  if (o.columns.some((c) => typeof c !== 'string')) {
    return { ok: false, error: 'seek.columns must be strings' };
  }
  let descending: boolean | boolean[] | undefined;
  if (typeof o.descending === 'boolean') descending = o.descending;
  else if (Array.isArray(o.descending) && o.descending.every((d) => typeof d === 'boolean')) {
    descending = o.descending;
  } else if (o.descending != null) {
    return { ok: false, error: 'seek.descending must be a boolean or boolean[]' };
  }
  return {
    ok: true,
    value: { columns: o.columns as string[], values: o.values, descending },
  };
}

function descAt(seek: SqlSeek, i: number): boolean {
  if (Array.isArray(seek.descending)) return Boolean(seek.descending[i]);
  return Boolean(seek.descending);
}

/** Last-Id / keyset wrap. OFFSET is not used; +1 probe row still applies. */
export function wrapSqlForSeek(
  sql: string,
  dialect: string,
  seek: SqlSeek,
  limit: number,
  existingParamCount: number
): { sql: string; seekParams: unknown[] } | { error: string } {
  if (!seek.columns.length || seek.columns.length !== seek.values.length) {
    return { error: 'seek.columns and seek.values must be the same non-empty length' };
  }
  if (!seek.columns.every(isSafeSeekColumn)) {
    return { error: 'seek.columns must be plain identifiers' };
  }
  const parsed = parseTopLevelOrderBy(sql);
  if (!parsed) {
    return { error: 'Last Id paging requires a top-level ORDER BY on columns' };
  }
  const orderCols = parsed.terms.map((t) => t.column.toLowerCase());
  const seekCols = seek.columns.map((c) => c.toLowerCase());
  if (seekCols.length > orderCols.length || seekCols.some((c, i) => c !== orderCols[i])) {
    return { error: 'seek.columns must match the ORDER BY prefix' };
  }
  const d = dialect.toLowerCase();
  const style = placeholderStyleFor(d);
  const inner = sql.trim().replace(/;+\s*$/, '');
  const fetchLimit = limit + 1;
  const clauses: string[] = [];
  const seekParams: unknown[] = [];
  const nextPh = (): string => {
    const idx = existingParamCount + seekParams.length;
    return renderPlaceholder(style, idx + 1);
  };
  for (let i = 0; i < seek.columns.length; i++) {
    const parts: string[] = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${quoteSqlIdentifier(seek.columns[j]!, dialect)} = ${nextPh()}`);
      seekParams.push(seek.values[j]);
    }
    const cmp = descAt(seek, i) ? '<' : '>';
    parts.push(`${quoteSqlIdentifier(seek.columns[i]!, dialect)} ${cmp} ${nextPh()}`);
    seekParams.push(seek.values[i]);
    clauses.push(`(${parts.join(' AND ')})`);
  }
  const pred = clauses.join(' OR ');
  const orderSql = parsed.terms
    .map((t) => `${quoteSqlIdentifier(t.column, dialect)}${t.descending ? ' DESC' : ''}`)
    .join(', ');
  let wrapped: string;
  if (isTsqlDialect(d)) {
    wrapped = `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} WHERE ${pred} ORDER BY ${orderSql} OFFSET 0 ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
  } else if (d === 'oracle') {
    wrapped = `SELECT * FROM (${inner}) ${PAGE_ALIAS} WHERE ${pred} ORDER BY ${orderSql} OFFSET 0 ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;
  } else if (d === 'db2') {
    wrapped = `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} WHERE ${pred} ORDER BY ${orderSql} OFFSET 0 ROWS FETCH FIRST ${fetchLimit} ROWS ONLY`;
  } else {
    wrapped = `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} WHERE ${pred} ORDER BY ${orderSql} LIMIT ${fetchLimit}`;
  }
  return { sql: wrapped, seekParams };
}

/** After shaping, drop the probe row and set truncated/hasNext. */
export function trimPageProbe<T extends { rows: unknown[][]; rowCount: number; truncated: boolean }>(
  shaped: T,
  pageSize: number
): T & { hasNext: boolean } {
  const hasNext = shaped.rows.length > pageSize;
  const rows = hasNext ? shaped.rows.slice(0, pageSize) : shaped.rows;
  return {
    ...shaped,
    rows,
    rowCount: rows.length,
    truncated: hasNext || shaped.truncated,
    hasNext,
  };
}
