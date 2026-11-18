/**
 * Safe SQL construction for code cells: a tagged template whose `${…}`
 * interpolations become **bind parameters**, never text.
 *
 *   sql`SELECT * FROM users WHERE id = ${id}`      → "… id = $1",  [id]
 *   sql`INSERT INTO t ${sql.values(rows)}`         → "… VALUES ($1,$2),($3,$4)"
 *   sql`DELETE FROM ${sql.id(name)} WHERE x = ${v}` → identifier quoted, v bound
 *
 * Why not string interpolation: a value containing `'` ends the literal and
 * changes the statement, `null` becomes the bare word null, Date becomes a
 * locale string most engines reject, and an object becomes "[object Object]".
 * Binding hands the value to the driver as data, so none of that can happen.
 *
 * `sql.raw()` exists for genuinely dynamic SQL and is deliberately explicit —
 * it is the one construct that puts caller text straight into the statement.
 */

import { sqlTokens } from './sql-tokens.js';
import { sqlReadings } from './sql-readings.js';

/** Placeholder syntax per engine family. */
export type SqlPlaceholderStyle = 'dollar' | 'question' | 'colon' | 'at';

// ClickHouse's adapter substitutes `$N` (string-escaped) — it does not bind `?`.
// Emitting question-mark placeholders left peek FK drills and `sql\`…\`` cells
// unbound ("Syntax error … failed at position") while catalog probes that
// already used `$1` worked. Keep ClickHouse on dollar so every path matches.
const DOLLAR_DIALECTS = new Set([
  'postgres',
  'redshift',
  'cockroachdb',
  'yugabytedb',
  'clickhouse',
]);
const COLON_DIALECTS = new Set(['oracle']);
const BACKTICK_DIALECTS = new Set(['mysql', 'mariadb', 'tidb', 'clickhouse']);
/** The T-SQL family: bracket-quoted names, `@p0`-named parameters, OFFSET/FETCH paging. */
const TSQL_DIALECTS = new Set(['sqlserver', 'mssql', 'azuresql']);

export function isTsqlDialect(dialect: string): boolean {
  return TSQL_DIALECTS.has(dialect.toLowerCase());
}

export function placeholderStyleFor(dialect: string): SqlPlaceholderStyle {
  const d = dialect.toLowerCase();
  if (DOLLAR_DIALECTS.has(d)) return 'dollar';
  if (COLON_DIALECTS.has(d)) return 'colon';
  // The T-SQL adapters bind `@p0, @p1, …` by name. A `?` in the text binds
  // nothing there, so the statement fails at the engine.
  if (TSQL_DIALECTS.has(d)) return 'at';
  return 'question';
}

/** `index` is 1-based; `@p` names are 0-based, matching the adapters' binding. */
export function renderPlaceholder(style: SqlPlaceholderStyle, index: number): string {
  if (style === 'dollar') return `$${index}`;
  if (style === 'colon') return `:${index}`;
  if (style === 'at') return `@p${index - 1}`;
  return '?';
}

/**
 * Quote an identifier for `dialect`. Mirrors the SQL editor's `quoteIdent` —
 * engines cannot bind identifiers, so this is the only safe way to make a
 * table/column name dynamic.
 */
export function quoteSqlIdentifier(name: string, dialect: string): string {
  const d = dialect.toLowerCase();
  if (BACKTICK_DIALECTS.has(d)) return '`' + name.replace(/`/g, '``') + '`';
  if (TSQL_DIALECTS.has(d)) return '[' + name.replace(/]/g, ']]') + ']';
  return '"' + name.replace(/"/g, '""') + '"';
}

/** A name that needs no quoting in any supported dialect. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote `name` for `dialect` only when it is not a plain identifier — what the
 * editor inserts when a user clicks a table or column. Plain names stay bare so
 * inserted SQL reads the way people write it.
 *
 * The web app had two hand copies of this. One of them left `tidb` and
 * `azuresql` out of their families, so a TiDB name needing quotes came out as
 * `"x"` — which MySQL-mode TiDB reads as a string literal, not an identifier.
 * Built on `quoteSqlIdentifier`, so the families live in one place.
 */
export function quoteIdentifierIfNeeded(name: string, dialect: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : quoteSqlIdentifier(name, dialect);
}

/**
 * Split `schema.table` into identifier parts, honouring quoted segments.
 *
 * A dot inside `"we.ird"` is part of the name, not a separator, so splitting on
 * `.` alone would produce two identifiers that do not exist. `""` inside a
 * quoted segment is one literal quote.
 */
export function qualifiedNameParts(qualified: string): string[] {
  const trimmed = qualified.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '"') {
      if (quoted && trimmed[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (ch === '.' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((p) => p.length > 0);
}

/**
 * Quote a possibly-qualified table name for `dialect`.
 *
 * For statements that name a table outside a bound query — `SET IDENTITY_INSERT
 * <table> ON`, for one, where the table cannot be a parameter.
 *
 * Returns an empty string when nothing usable is left, so a caller can refuse
 * rather than emit a statement naming nothing.
 */
export function quoteQualifiedName(qualified: string, dialect: string): string {
  return qualifiedNameParts(qualified)
    .map((part) => quoteSqlIdentifier(part, dialect))
    .join('.');
}

const FRAGMENT = Symbol.for('foxschema.sql.fragment');
const QUERY = Symbol.for('foxschema.sql.query');

type Fragment =
  | { [FRAGMENT]: true; kind: 'raw'; text: string }
  | { [FRAGMENT]: true; kind: 'identifier'; parts: string[] }
  | {
      [FRAGMENT]: true;
      kind: 'values';
      rows: Record<string, unknown>[];
      columns?: string[];
      /** Clause between the column list and VALUES, e.g. OVERRIDING SYSTEM VALUE. */
      between?: string;
    }
  | { [FRAGMENT]: true; kind: 'list'; values: unknown[] };

export interface SqlQuery {
  [QUERY]: true;
  strings: readonly string[];
  values: readonly unknown[];
}

function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && FRAGMENT in v;
}

export function isSqlQuery(v: unknown): v is SqlQuery {
  return typeof v === 'object' && v !== null && QUERY in v;
}

export interface RenderedSql {
  text: string;
  params: unknown[];
}

/** Column union across rows, in first-seen order (matches grid semantics). */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) set.add(k);
  return [...set];
}

/** Engines that read a backslash inside `'…'` as an escape by default. */
const BACKSLASH_STRING_DIALECTS = new Set(['mysql', 'mariadb', 'tidb', 'clickhouse']);
/** Engines with no TRUE/FALSE literal (T-SQL `bit`, Oracle before 23ai): 1 and 0 instead. */
const NUMERIC_BOOLEAN_DIALECTS = new Set([...TSQL_DIALECTS, 'oracle']);
const POSTGRES_FAMILY = new Set(['postgres', 'cockroachdb', 'yugabytedb']);

/** Bytes from a driver value: a Uint8Array (Node's Buffer is one), or a Buffer after JSON (`{ type: 'Buffer', data }`). */
function bytesOf(value: object): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  const json = value as { type?: unknown; data?: unknown };
  if (json.type === 'Buffer' && Array.isArray(json.data) && json.data.every((b) => Number.isInteger(b))) {
    return Uint8Array.from(json.data as number[]);
  }
  return null;
}

function binaryLiteral(bytes: Uint8Array, dialect: string): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  if (POSTGRES_FAMILY.has(dialect)) return `'\\x${hex}'`;
  if (TSQL_DIALECTS.has(dialect)) return `0x${hex}`;
  if (dialect === 'oracle') return `HEXTORAW('${hex}')`;
  if (dialect === 'db2') return `BX'${hex}'`;
  if (dialect === 'clickhouse') return `unhex('${hex}')`;
  if (dialect === 'duckdb' || dialect === 'redshift') return `from_hex('${hex}')`;
  return `X'${hex}'`; // MySQL, MariaDB, TiDB, SQLite
}

function stringLiteral(text: string, dialect: string): string {
  let body = text.replace(/'/g, "''");
  // MySQL reads `'C:\temp\'` as an unterminated string: the last `\` escapes the quote.
  if (BACKSLASH_STRING_DIALECTS.has(dialect)) body = body.replace(/\\/g, '\\\\');
  // Without N, SQL Server converts the text to the database code page first,
  // so characters outside it arrive as `?`. Plain ASCII keeps the bare form,
  // which compares against a varchar column without converting the column.
  const national = TSQL_DIALECTS.has(dialect) && /[^\x00-\x7f]/.test(text) ? 'N' : '';
  return `${national}'${body}'`;
}

/**
 * A value as a SQL literal `dialect` reads back as the same value. For SQL a
 * person will read, copy or run themselves: Copy INSERT, a peek opened in the
 * editor. A statement Fox runs binds its values instead (see {@link renderSqlQuery}).
 */
export function sqlLiteral(value: unknown, dialect: string): string {
  const d = dialect.toLowerCase();
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    if (NUMERIC_BOOLEAN_DIALECTS.has(d)) return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return stringLiteral(value.toISOString(), d);
  if (typeof value === 'object') {
    const bytes = bytesOf(value);
    if (bytes) return binaryLiteral(bytes, d);
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      json = String(value);
    }
    return stringLiteral(json, d);
  }
  return stringLiteral(String(value), d);
}

/**
 * Replace the placeholders of `text` (as {@link renderSqlQuery} wrote them for
 * `dialect`) with their values as literals. Reads the text as tokens, so a
 * `?`, `$1`, `:1` or `@p0` inside a string, a quoted name or a comment is left
 * alone, and only the dialect's own placeholder style is replaced. A
 * placeholder with no matching value stays as it is.
 */
export function inlineSqlParams(text: string, params: readonly unknown[], dialect: string): string {
  if (params.length === 0) return text;
  const d = dialect.toLowerCase();
  const style = placeholderStyleFor(d);
  const tokens = [...sqlTokens(text, sqlReadings(d)[0] ?? {})];
  const literalAt = (index: number) => (index >= 0 && index < params.length ? sqlLiteral(params[index], d) : null);
  let out = '';
  let question = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const raw = text.slice(token.start, token.end);
    const next = tokens[i + 1];
    const nextRaw = next ? text.slice(next.start, next.end) : '';
    let literal: string | null = null;
    let consumed = 0;
    if (style === 'dollar' && token.kind === 'word' && /^\$[1-9]\d*$/.test(raw)) {
      literal = literalAt(Number(raw.slice(1)) - 1);
    } else if (style === 'dollar' && raw === '$' && next?.kind === 'word' && /^[1-9]\d*$/.test(nextRaw)) {
      // A reading where names cannot start with a digit (PostgreSQL's) lexes
      // `$1` as `$` then `1`.
      literal = literalAt(Number(nextRaw) - 1);
      consumed = 1;
    } else if (style === 'question' && token.kind === 'punct' && raw === '?') {
      literal = literalAt(question++);
    } else if (style === 'colon' && raw === ':' && next?.kind === 'word' && /^[1-9]\d*$/.test(nextRaw)) {
      literal = literalAt(Number(nextRaw) - 1);
      consumed = 1;
    } else if (style === 'at' && raw === '@' && next?.kind === 'word' && /^p\d+$/i.test(nextRaw)) {
      literal = literalAt(Number(nextRaw.slice(1)));
      consumed = 1;
    }
    if (literal === null) {
      out += raw;
      continue;
    }
    out += literal;
    i += consumed;
  }
  return out;
}

export interface RenderSqlOptions {
  /**
   * Write each value into the text as a literal ({@link sqlLiteral}) instead
   * of a placeholder; `params` comes back empty. For SQL a person copies.
   */
  inlineValues?: boolean;
}

/**
 * Flatten a tagged-template query into driver-ready `{ text, params }`.
 * Nested queries and fragments are expanded in place so composition works.
 */
export function renderSqlQuery(query: SqlQuery, dialect: string, options: RenderSqlOptions = {}): RenderedSql {
  const style = placeholderStyleFor(dialect);
  const params: unknown[] = [];
  let text = '';

  const bind = (value: unknown): string => {
    if (options.inlineValues) return sqlLiteral(value, dialect);
    params.push(value);
    return renderPlaceholder(style, params.length);
  };

  const emitValue = (value: unknown): void => {
    if (isSqlQuery(value)) {
      walk(value);
      return;
    }
    if (isFragment(value)) {
      if (value.kind === 'raw') {
        text += value.text;
        return;
      }
      if (value.kind === 'identifier') {
        text += value.parts.map((p) => quoteSqlIdentifier(p, dialect)).join('.');
        return;
      }
      if (value.kind === 'list') {
        text += `(${value.values.map(bind).join(', ')})`;
        return;
      }
      // values: a full `(cols) VALUES (…), (…)` tail for INSERT
      if (value.rows.length === 0) {
        // Emitting `() VALUES ` would surface as an opaque engine syntax error.
        // A migration loop hitting an empty batch should hear it plainly.
        throw new Error('sql.values() needs at least one row — guard the empty case in the cell');
      }
      const cols = value.columns ?? columnsOf(value.rows);
      if (cols.length === 0) {
        throw new Error('sql.values() rows have no columns');
      }
      const colList = cols.map((c) => quoteSqlIdentifier(c, dialect)).join(', ');
      const tuples = value.rows
        .map((row) => `(${cols.map((c) => bind(row[c] ?? null)).join(', ')})`)
        .join(', ');
      // `between` carries an engine clause that must sit after the column
      // list — Postgres/Db2 spell explicit identity writes that way. It is
      // caller-supplied SQL, so it is only ever set from a fixed capability
      // table, never from user input.
      const between = value.between ? `${value.between} ` : '';
      text += `(${colList}) ${between}VALUES ${tuples}`;
      return;
    }
    // A bare array is an IN-list — the single most common multi-value need.
    if (Array.isArray(value)) {
      text += `(${value.map(bind).join(', ')})`;
      return;
    }
    text += bind(value);
  };

  const walk = (q: SqlQuery): void => {
    q.strings.forEach((chunk, i) => {
      text += chunk;
      if (i < q.values.length) emitValue(q.values[i]);
    });
  };

  walk(query);
  return { text: text.trim(), params };
}

export interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlQuery;
  /** Interpolate text verbatim. The only unescaped path — use deliberately. */
  raw(text: string): Fragment;
  /** A quoted identifier; `sql.id('public', 'users')` → `"public"."users"`. */
  id(...parts: string[]): Fragment;
  /** `(a, b) VALUES (?, ?), (?, ?)` from an array of objects. */
  values(rows: Record<string, unknown>[], columns?: string[], between?: string): Fragment;
  /** `(?, ?, ?)` for `IN` lists (a bare array does this too). */
  list(values: unknown[]): Fragment;
}

/** Build a `SqlQuery` without a template literal (useful for tests/tools). */
export function makeSqlQuery(strings: readonly string[], values: readonly unknown[]): SqlQuery {
  return { [QUERY]: true, strings, values };
}

export const sqlTag: SqlTag = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): SqlQuery =>
    makeSqlQuery([...strings], values),
  {
    raw: (text: string): Fragment => ({ [FRAGMENT]: true, kind: 'raw', text }),
    id: (...parts: string[]): Fragment => ({ [FRAGMENT]: true, kind: 'identifier', parts }),
    values: (
      rows: Record<string, unknown>[],
      columns?: string[],
      between?: string
    ): Fragment => ({
      [FRAGMENT]: true,
      kind: 'values',
      between,
      rows,
      columns,
    }),
    list: (values: unknown[]): Fragment => ({ [FRAGMENT]: true, kind: 'list', values }),
  }
);
