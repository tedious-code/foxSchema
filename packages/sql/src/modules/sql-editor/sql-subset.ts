/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A deliberately tiny SQL grammar, parsed into an intent a non-SQL store can
 * carry out.
 *
 * MongoDB and Redis do not speak SQL — the official drivers take MQL documents
 * and RESP commands. Making them work behind the SQL editor and data-migrate
 * therefore means translating, and translating means parsing. Parsing *all* of
 * SQL is a project; parsing what this application actually emits is not.
 *
 * Data migrate only ever produces three shapes, each with equality predicates
 * on key columns (see rowDml.ts):
 *
 *   INSERT INTO t (a, b) VALUES (?, ?)
 *   UPDATE t SET a = ? WHERE k = ? AND k2 = ?
 *   DELETE FROM t WHERE k = ? AND k2 = ?
 *
 * plus `SELECT … FROM t [WHERE …] [LIMIT n [OFFSET m]]` for browsing. That is
 * the whole surface, and it maps cleanly onto find/insert/update/delete in
 * either store. OFFSET is there because the editor pages every SELECT; it only
 * ever narrows what a read returns.
 *
 * ## Everything else is refused, on purpose
 *
 * The dangerous failure for a translator is not rejecting valid SQL — it is
 * *accepting* SQL it only partly understands. `DELETE FROM t WHERE age > 65`
 * with the predicate silently dropped empties the collection. So this parser
 * fails closed: anything it cannot represent exactly returns an error, and the
 * caller must refuse to execute rather than approximate.
 *
 * That is why there are no ranges, no OR, no joins, no subqueries, no
 * functions and no expressions here. Not "not yet" — admitting any of them
 * means the intent can no longer be checked by inspection.
 */

export interface SubsetColumnEq {
  column: string;
  /** Index into the statement's bind parameters, or a literal value. */
  value: SubsetValue;
}

export type SubsetValue =
  | { kind: 'param'; index: number }
  | { kind: 'literal'; value: string | number | null | boolean };

export type SubsetIntent =
  | {
      kind: 'select';
      table: string;
      columns: string[] | '*';
      where: SubsetColumnEq[];
      limit?: number;
      /** Rows to skip before the first one returned. */
      offset?: number;
    }
  | { kind: 'insert'; table: string; assignments: SubsetColumnEq[] }
  | { kind: 'update'; table: string; set: SubsetColumnEq[]; where: SubsetColumnEq[] }
  | { kind: 'delete'; table: string; where: SubsetColumnEq[] };

export type SubsetParse =
  | { ok: true; intent: SubsetIntent }
  | { ok: false; error: string };

/** Unwrap "x", `x`, [x] — the quoting styles the generators emit. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
    if (s.startsWith('`') && s.endsWith('`')) return s.slice(1, -1).replace(/``/g, '`');
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).replace(/\]\]/g, ']');
  }
  return s;
}

/**
 * `schema.table` → `table`; a non-SQL store has one namespace.
 *
 * Splits only on dots outside quotes. A Redis key is often dotted
 * (`cache.v1:users`), and splitting `"cache.v1:users"` before unquoting read it
 * as the table `v1:users"`, which matched nothing.
 */
function tableName(raw: string): string {
  const parts: string[] = [];
  let current = '';
  let close: string | null = null;
  for (const ch of raw.trim()) {
    if (close) {
      current += ch;
      if (ch === close) close = null;
      continue;
    }
    if (ch === '"' || ch === '`') close = ch;
    else if (ch === '[') close = ']';
    if (ch === '.' && !close) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const names = parts.map(unquote).filter(Boolean);
  return names[names.length - 1] ?? '';
}

/**
 * A bind placeholder in any dialect's spelling, or a simple literal.
 *
 * Anything else — an expression, a function call, a nested SELECT — is not a
 * value this can represent, and returns null so the caller refuses.
 */
function parseValue(raw: string, nextParamIndex: () => number): SubsetValue | null {
  const s = raw.trim();
  if (!s) return null;
  // $1 / ? / :1 / @p0 — the placeholder styles renderSqlQuery emits.
  if (s === '?') return { kind: 'param', index: nextParamIndex() };
  const dollar = /^\$(\d+)$/.exec(s);
  if (dollar) return { kind: 'param', index: Number(dollar[1]) - 1 };
  const colon = /^:(\d+)$/.exec(s);
  if (colon) return { kind: 'param', index: Number(colon[1]) - 1 };
  // SQL Server names are already 0-based.
  const at = /^@p(\d+)$/.exec(s);
  if (at) return { kind: 'param', index: Number(at[1]) };

  if (/^NULL$/i.test(s)) return { kind: 'literal', value: null };
  if (/^TRUE$/i.test(s)) return { kind: 'literal', value: true };
  if (/^FALSE$/i.test(s)) return { kind: 'literal', value: false };
  // Plain decimal only — no exponent, no sign games, no expressions.
  if (/^-?\d+$/.test(s)) return { kind: 'literal', value: Number(s) };
  if (/^-?\d+\.\d+$/.test(s)) return { kind: 'literal', value: Number(s) };
  // Single-quoted string with '' escaping — and nothing after its closing
  // quote. `'1' OR id = '2'` starts and ends with a quote too; read as one
  // string it made `WHERE id = '1' OR id = '2'` match nothing instead of being
  // refused, and a DELETE address a key nobody has.
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'") && isOneStringLiteral(s)) {
    return { kind: 'literal', value: s.slice(1, -1).replace(/''/g, "'") };
  }
  return null;
}

/** True when `'…'` is a single literal: every quote inside it is a doubled `''`. */
function isOneStringLiteral(s: string): boolean {
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== "'") continue;
    if (s[i + 1] !== "'" || i + 1 === s.length - 1) return false;
    i++;
  }
  return true;
}

/**
 * Split on a separator that appears at paren depth 0 and outside quotes.
 * Keeps `('a, b')` and `f(x, y)` from being cut in the middle.
 */
function splitTop(text: string, separator: RegExp): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === inQuote) {
        if (text[i + 1] === inQuote) i++;
        else inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return null;
    } else if (depth === 0) {
      separator.lastIndex = 0;
      const m = separator.exec(text.slice(i));
      if (m && m.index === 0) {
        out.push(text.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  if (depth !== 0 || inQuote) return null;
  out.push(text.slice(start));
  return out;
}

/**
 * A bare field reference: `name`, `user_id`, `profile.city`.
 *
 * Deliberately strict. Anything with parentheses, operators or spaces is an
 * expression, and an expression in the column position cannot be turned into
 * a document field without evaluating it.
 */
function isPlainFieldRef(name: string): boolean {
  if (!name) return false;
  // Split rather than match `(?:\.[A-Za-z_$][\w$]*)*` — nesting a quantifier
  // inside a repeated group is the shape security/detect-unsafe-regex rejects,
  // and this runs per predicate per statement.
  const segments = name.split('.');
  return segments.every((segment) => SEGMENT.test(segment));
}

/** One identifier segment. No nesting, so no backtracking to worry about. */
const SEGMENT = /^[A-Za-z_$][\w$]*$/;

/**
 * The text inside `( … )` when one pair of parentheses wraps all of `text`,
 * else null. `(a = 1) AND (b = 2)` is not wrapped: its first `(` closes early.
 */
function innerOfParens(text: string): string | null {
  if (!text.startsWith('(') || !text.endsWith(')')) return null;
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === inQuote) {
        if (text[i + 1] === inQuote) i++;
        else inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inQuote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === text.length - 1 ? text.slice(1, -1) : null;
    }
  }
  return null;
}

/** `a = ? AND b = ?` → equality pairs, or null if anything else appears. */
function parseEqualityList(
  text: string,
  separator: RegExp,
  nextParamIndex: () => number
): SubsetColumnEq[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = splitTop(trimmed, separator);
  if (!parts) return null;
  const out: SubsetColumnEq[] = [];
  for (const part of parts) {
    // A predicate group, `(a = 1 AND b = 2)`, means the same as its contents.
    // Data peek wraps every WHERE it is given in one, so refusing it refused
    // every peek filter on this store. Only for AND lists: OR inside a group
    // still fails below, as it does outside one.
    const group = separator === AND ? innerOfParens(part.trim()) : null;
    if (group !== null) {
      const inner = parseEqualityList(group, separator, nextParamIndex);
      if (!inner || inner.length === 0) return null;
      out.push(...inner);
      continue;
    }
    // Exactly `column = value`. Any other operator is outside the subset, and
    // treating `>=` as `=` would silently match the wrong rows.
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const before = part.slice(0, eq).trim();
    const after = part.slice(eq + 1).trim();
    // Reject compound operators: `>=`, `<=`, `!=`, `<>`.
    if (/[<>!]$/.test(before)) return null;
    const column = unquote(before);
    // Must be a plain field reference. Rejecting only whitespace was not
    // enough: `lower(a)` has none and sailed through as a column name, which
    // would have matched on a field that does not exist. A dot is allowed —
    // it addresses a nested field in a document store.
    if (!isPlainFieldRef(column)) return null;
    const value = parseValue(after, nextParamIndex);
    if (!value) return null;
    out.push({ column, value });
  }
  return out;
}

/**
 * WHERE `column = NULL` is not SQL equality (that needs IS NULL), and on MongoDB
 * `{ field: null }` also matches documents where the field is missing — so a
 * DELETE/UPDATE would over-match. Refuse it the same way IS NULL is refused.
 * SET/INSERT may still assign NULL.
 */
function whereHasNullLiteral(where: SubsetColumnEq[]): boolean {
  return where.some((w) => w.value.kind === 'literal' && w.value.value === null);
}

const WHERE_NULL_REFUSED =
  'Equality to NULL is not supported on this store (SQL uses IS NULL; document stores treat null as matching missing fields).';

const AND = /^\s+AND\s+/i;

/**
 * `LIMIT n` or `LIMIT n OFFSET m` at the end of a SELECT, read as whole words
 * from the end: `base` is the statement before it. Scanned rather than matched
 * with one pattern, which the unsafe-regex check refuses, and so `nameLIMIT 5`
 * is never read as a LIMIT.
 */
function trailingLimit(text: string): { base: string; limit: number; offset?: number } | null {
  const words: Array<{ word: string; start: number }> = [];
  let end = text.length;
  while (words.length < 4) {
    while (end > 0 && /\s/.test(text[end - 1]!)) end--;
    if (end === 0) break;
    let start = end;
    while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
    words.unshift({ word: text.slice(start, end), start });
    end = start;
  }
  const isCount = (w?: { word: string }) => w !== undefined && /^\d+$/.test(w.word);
  const isWord = (w: { word: string } | undefined, kw: string) => w?.word.toUpperCase() === kw;
  const n = words.length;
  if (n >= 4 && isWord(words[n - 4], 'LIMIT') && isCount(words[n - 3]) && isWord(words[n - 2], 'OFFSET') && isCount(words[n - 1])) {
    return { base: text.slice(0, words[n - 4]!.start).trimEnd(), limit: Number(words[n - 3]!.word), offset: Number(words[n - 1]!.word) };
  }
  if (n >= 2 && isWord(words[n - 2], 'LIMIT') && isCount(words[n - 1])) {
    return { base: text.slice(0, words[n - 2]!.start).trimEnd(), limit: Number(words[n - 1]!.word) };
  }
  return null;
}
const COMMA = /^\s*,\s*/;

/**
 * Parse one statement into an intent, or explain why it is out of subset.
 *
 * The caller is expected to treat `ok: false` as "refuse to run", never as
 * "run it some other way".
 */
export function parseSqlSubset(sql: string): SubsetParse {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!text) return { ok: false, error: 'Empty statement.' };

  // One statement only. A batch here would translate the first and drop the
  // rest, which is exactly the silent-partial-success this must not do.
  if (splitTop(text, /^;/) === null) {
    return { ok: false, error: 'Unbalanced quotes or parentheses.' };
  }
  const statements = splitTop(text, /^;/);
  if (statements && statements.filter((s) => s.trim()).length > 1) {
    return { ok: false, error: 'Only one statement at a time is supported on this store.' };
  }

  let paramCursor = 0;
  const nextParamIndex = () => paramCursor++;

  const select = /^SELECT\s+([\s\S]+?)\s+FROM\s+([^\s]+)([\s\S]*)$/i.exec(text);
  if (select) {
    const [, cols, table, tail] = select;
    const columnTexts = cols!.trim() === '*' ? null : splitTop(cols!, COMMA);
    if (cols!.trim() !== '*' && !columnTexts) return { ok: false, error: 'Could not read the column list.' };
    // An unquoted column is a plain field name. `COUNT(*)` or `a + 1` is an
    // expression this store cannot evaluate; it used to come back as a column
    // of NULLs. A quoted name is taken as written: a Redis field can be
    // `first-name`.
    const badColumn = columnTexts?.find((c) => {
      const t = c.trim();
      const quoted = /^["`[]/.test(t);
      return !quoted && !isPlainFieldRef(t);
    });
    if (badColumn !== undefined) {
      return { ok: false, error: `Only plain column names are supported on this store, not \`${badColumn.trim()}\`.` };
    }
    const columns = columnTexts ? columnTexts.map(unquote) : ('*' as const);
    let rest = (tail ?? '').trim();
    let limit: number | undefined;
    let offset: number | undefined;
    const paged = trailingLimit(rest);
    if (paged) {
      limit = paged.limit;
      offset = paged.offset;
      rest = paged.base.trim();
    }
    let where: SubsetColumnEq[] = [];
    if (rest) {
      const w = /^WHERE\s+([\s\S]+)$/i.exec(rest);
      if (!w) return { ok: false, error: `Unsupported clause: ${rest.slice(0, 40)}` };
      const parsed = parseEqualityList(w[1]!, AND, nextParamIndex);
      if (!parsed) {
        return {
          ok: false,
          error: 'Only `column = value` predicates joined by AND are supported on this store.',
        };
      }
      if (whereHasNullLiteral(parsed)) return { ok: false, error: WHERE_NULL_REFUSED };
      where = parsed;
    }
    return {
      ok: true,
      intent: {
        kind: 'select',
        table: tableName(table!),
        columns,
        where,
        limit,
        ...(offset === undefined ? {} : { offset }),
      },
    };
  }

  const insert = /^INSERT\s+INTO\s+(\S+)\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)$/i.exec(text);
  if (insert) {
    const [, table, colText, valText] = insert;
    const cols = splitTop(colText!, COMMA)?.map(unquote);
    const vals = splitTop(valText!, COMMA);
    if (!cols || !vals || cols.length !== vals.length) {
      return { ok: false, error: 'INSERT column and value counts differ.' };
    }
    const assignments: SubsetColumnEq[] = [];
    for (let i = 0; i < cols.length; i++) {
      const value = parseValue(vals[i]!, nextParamIndex);
      if (!value) return { ok: false, error: `Unsupported value in INSERT: ${vals[i]!.trim()}` };
      assignments.push({ column: cols[i]!, value });
    }
    return { ok: true, intent: { kind: 'insert', table: tableName(table!), assignments } };
  }

  const update = /^UPDATE\s+(\S+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(text);
  if (update) {
    const [, table, setText, whereText] = update;
    const set = parseEqualityList(setText!, COMMA, nextParamIndex);
    if (!set || set.length === 0) {
      return { ok: false, error: 'Only `column = value` assignments are supported in SET.' };
    }
    const where = parseEqualityList(whereText!, AND, nextParamIndex);
    if (!where || where.length === 0) {
      return {
        ok: false,
        error: 'Only `column = value` predicates joined by AND are supported on this store.',
      };
    }
    if (whereHasNullLiteral(where)) return { ok: false, error: WHERE_NULL_REFUSED };
    return { ok: true, intent: { kind: 'update', table: tableName(table!), set, where } };
  }

  // An UPDATE with no WHERE would rewrite the whole collection.
  if (/^UPDATE\s/i.test(text)) {
    return { ok: false, error: 'UPDATE without a WHERE clause is refused on this store.' };
  }

  const del = /^DELETE\s+FROM\s+(\S+)\s+WHERE\s+([\s\S]+)$/i.exec(text);
  if (del) {
    const [, table, whereText] = del;
    const where = parseEqualityList(whereText!, AND, nextParamIndex);
    if (!where || where.length === 0) {
      return {
        ok: false,
        error: 'Only `column = value` predicates joined by AND are supported on this store.',
      };
    }
    if (whereHasNullLiteral(where)) return { ok: false, error: WHERE_NULL_REFUSED };
    return { ok: true, intent: { kind: 'delete', table: tableName(table!), where } };
  }

  if (/^DELETE\s/i.test(text)) {
    return { ok: false, error: 'DELETE without a WHERE clause is refused on this store.' };
  }

  return {
    ok: false,
    error:
      'This store supports only single-table SELECT / INSERT / UPDATE / DELETE with `column = value` predicates.',
  };
}

/** Resolve an intent's values against the statement's bind parameters. */
export function subsetValue(value: SubsetValue, params: readonly unknown[]): unknown {
  return value.kind === 'literal' ? value.value : (params[value.index] ?? null);
}

/** Stores Fox reaches through this subset rather than through SQL. */
const SUBSET_DIALECTS: ReadonlySet<string> = new Set(['redis', 'mongodb']);

/** Whether `dialect` is read through `parseSqlSubset` instead of an SQL engine. */
export function isSubsetDialect(dialect: string): boolean {
  return SUBSET_DIALECTS.has((dialect || '').toLowerCase());
}

/**
 * One page of a subset SELECT: `limit` rows after `offset`.
 *
 * The editor pages an SQL engine by nesting the statement in
 * `SELECT * FROM (…) LIMIT … OFFSET …`. A subset store cannot read a nested
 * SELECT, so every Redis and MongoDB query failed with "Unsupported clause".
 * The page is written onto the statement itself instead. A LIMIT the reader
 * wrote still bounds it, as it would inside the SQL engines' nesting: page two
 * of `LIMIT 5` is empty.
 */
export function pageSubsetSelect(sql: string, offset: number, limit: number): string {
  const text = sql.trim().replace(/;\s*$/, '');
  const own = trailingLimit(text);
  const base = own ? own.base : text;
  const ownOffset = own?.offset ?? 0;
  const ownLimit = own ? own.limit : Number.POSITIVE_INFINITY;
  const pageLimit = Math.max(0, Math.min(limit, ownLimit - offset));
  return `${base} LIMIT ${pageLimit} OFFSET ${ownOffset + offset}`;
}
