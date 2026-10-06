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
  isSafeSeekColumn,
  isTsqlDialect,
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
 * Copy of `sql` with comments, string literals and quoted/bracketed
 * identifiers blanked to spaces. Same length, so indexes map 1:1 back to the
 * original text and keyword regexes can't match inside literals.
 */
function maskSqlLiterals(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? '';
    const start = i;
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === ch && sql[i + 1] === ch) {
          i += 2;
          continue;
        }
        if (sql[i] === ch) {
          i++;
          break;
        }
        i++;
      }
    } else if (ch === '[') {
      while (i < n && sql[i] !== ']') i++;
      i = Math.min(n, i + 1);
    } else {
      i++;
      continue;
    }
    blank(start, i);
  }
  return out.join('');
}

/** Depth-0 view of a masked statement: parenthesized text blanked too. */
function maskSubqueries(masked: string): string {
  let depth = 0;
  let out = '';
  for (const ch of masked) {
    if (ch === '(') depth++;
    out += depth > 0 && ch !== '\n' ? ' ' : ch;
    if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return out;
}

export interface TsqlTopClause {
  /** Index of the `TOP` keyword in the original statement. */
  start: number;
  /** Index just past the clause (incl. PERCENT / WITH TIES and trailing space). */
  end: number;
  /** Row count when the TOP argument is a plain integer literal; else null. */
  count: number | null;
  percent: boolean;
  withTies: boolean;
}

/**
 * Finds `TOP …` on the statement's leading top-level SELECT
 * (`SELECT [ALL|DISTINCT] TOP (n) [PERCENT] [WITH TIES]`), skipping strings,
 * comments, `[brackets]` and subqueries/CTE bodies. A column merely named
 * `top` (`SELECT [top] …`, `SELECT x AS top`) is not a match.
 */
export function findTsqlTopClause(sql: string): TsqlTopClause | null {
  const masked = maskSqlLiterals(sql);
  const flat = maskSubqueries(masked);
  const sel = /\bselect\b/i.exec(flat);
  if (!sel) return null;
  let start = sel.index + /^select\s*/i.exec(masked.slice(sel.index))![0].length;
  const quantifier = /^(?:all|distinct)\b\s*/i.exec(masked.slice(start));
  if (quantifier) start += quantifier[0].length;
  const kw = /^top\b\s*/i.exec(masked.slice(start));
  if (!kw) return null;
  let i = start + kw[0].length;
  let arg: string;
  if (masked[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < masked.length; j++) {
      if (masked[j] === '(') depth++;
      if (masked[j] === ')' && --depth === 0) break;
    }
    if (j >= masked.length) return null;
    arg = sql.slice(i + 1, j).trim();
    i = j + 1;
  } else {
    const tok = /^[@\w.]+/.exec(masked.slice(i));
    if (!tok) return null;
    arg = tok[0];
    i += tok[0].length;
  }
  i += /^\s*/.exec(masked.slice(i))![0].length;
  const pct = /^percent\b\s*/i.exec(masked.slice(i));
  if (pct) i += pct[0].length;
  const ties = /^with\s+ties\b\s*/i.exec(masked.slice(i));
  if (ties) i += ties[0].length;
  const count = /^\d+$/.test(arg) ? Number(arg) : null;
  return { start, end: i, count, percent: Boolean(pct), withTies: Boolean(ties) };
}

/** True when the statement has a top-level UNION / EXCEPT / INTERSECT. */
function hasTopLevelSetOperator(sql: string): boolean {
  return /\b(union|except|intersect)\b/i.test(maskSubqueries(maskSqlLiterals(sql)));
}

/**
 * T-SQL page wrap.
 *
 * SQL Server needs ORDER BY for OFFSET/FETCH, rejects ORDER BY in a bare
 * derived table, and rejects TOP and OFFSET in the same query block
 * ("A TOP can not be used in the same query or sub-query as a OFFSET").
 *
 * - No top-level ORDER BY: nest in a derived table with a dummy ORDER BY.
 *   A TOP inside the derived table is fine here.
 * - Top-level ORDER BY, no TOP: append OFFSET/FETCH to the statement.
 * - Top-level ORDER BY + `TOP n` (integer literal, no PERCENT / WITH TIES):
 *   drop TOP and fold it into the bound: rows `[offset, min(n, offset+limit+1))`
 *   via `FETCH NEXT min(limit+1, n-offset)`. ORDER BY stays on the user's
 *   query block, so the page order is guaranteed and identical to the
 *   unpaged result; TOP's cap still holds (hasNext turns false at row n).
 * - Top-level ORDER BY + TOP PERCENT / WITH TIES / non-literal `TOP (@n)`:
 *   OFFSET/FETCH can't express these, so keep TOP and nest the statement in a
 *   derived table (ORDER BY is legal there because TOP is present). Trade-off:
 *   SQL Server doesn't promise that an outer `ORDER BY (SELECT NULL)` keeps
 *   the derived table's order. Serial plans stream Sort→Top in order, so in
 *   practice it holds; parallel plans may not. We can't safely re-sort on the
 *   user's ORDER BY keys outside the derived table (they may be expressions or
 *   columns not in the select list), and a bounded, occasionally reordered
 *   page beats a hard "Paging failed".
 * - Same fallback once offset ≥ n (the page is empty either way; a FETCH of 0
 *   rows is rejected).
 * - A leading TOP in a UNION / EXCEPT / INTERSECT applies to its branch only,
 *   not to the ORDER BY'd result, so those keep the plain append.
 */
function wrapTsqlForPage(inner: string, offset: number, fetchLimit: number): string {
  const tail = (count: number): string => `OFFSET ${offset} ROWS FETCH NEXT ${count} ROWS ONLY`;
  const nested = `SELECT * FROM (${inner}) AS ${PAGE_ALIAS} ORDER BY (SELECT NULL) ${tail(fetchLimit)}`;
  if (!hasTopLevelOrderBy(inner)) return nested;
  const top = hasTopLevelSetOperator(inner) ? null : findTsqlTopClause(inner);
  if (!top) return `${inner} ${tail(fetchLimit)}`;
  if (top.count === null || top.percent || top.withTies || top.count <= offset) return nested;
  const withoutTop = `${inner.slice(0, top.start)}${inner.slice(top.end)}`;
  return `${withoutTop} ${tail(Math.min(fetchLimit, top.count - offset))}`;
}

/**
 * Best-effort page wrap. Dialects without OFFSET still get a subquery + LIMIT
 * when offset is 0; non-zero offset uses the closest dialect syntax.
 */
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

  if (isTsqlDialect(d)) {
    return wrapTsqlForPage(inner, offset, fetchLimit);
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
