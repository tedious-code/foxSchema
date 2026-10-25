/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which table each column of a joined result came from.
 *
 * A five-table join returns forty columns, three of them called `id` and two
 * called `created_at`, and the grid shows them as forty identical-looking
 * headers. The reader cannot tell `orders.id` from `customers.id`, and there is
 * no way back to the row a column belongs to. Attribution is what turns that
 * grid back into something readable.
 *
 * ## Why not just read the driver's column metadata
 *
 * Because the drivers do not agree on giving it. Postgres reports a table OID
 * per column, MySQL reports the table name, SQL Server reports it only when
 * asked for extended metadata, and Oracle and Db2 report nothing usable for a
 * join. Deriving it from the statement and the schema cache is the one approach
 * that behaves identically on all fourteen dialects.
 *
 * ## What it will not do
 *
 * Guess. Every column is attributed with a stated confidence, and `unknown` is
 * a normal answer — for an expression, an aggregate, a column name that two
 * joined tables both have and position cannot separate. Callers show what is
 * known and stay quiet about the rest. Labelling `id` as `orders` when it is
 * really `customers.id` is worse than labelling nothing, because the next thing
 * the reader does is act on it.
 */
import type { TableSchema } from '../../interfaces/schema.interface.js';

/** How the table for a column was established. */
export type OriginConfidence =
  /** The statement said so: `o.total`, with `o` bound to a known table. */
  | 'qualified'
  /** `SELECT *` expanded in FROM order and the names lined up exactly. */
  | 'positional'
  /** Exactly one table in the FROM clause has a column with this name. */
  | 'unique'
  /** Nothing reliable: an expression, or a name two joined tables share. */
  | 'unknown';

export interface ColumnOrigin {
  /** Index into the result's `columns` array. */
  index: number;
  /** The column name as the driver returned it. */
  column: string;
  /** Schema-cache table name, absent when confidence is `unknown`. */
  table?: string;
  /** The qualifier written in the SQL (`o`), when there was one. */
  qualifier?: string;
  confidence: OriginConfidence;
}

/** One entry of the FROM clause, in the order it was written. */
export interface FromEntry {
  /** Table name as written, e.g. `sales.orders`. */
  name: string;
  /** Alias when one was given: `FROM orders o` → `o`. */
  alias?: string;
}

/** One identifier: bare, or wrapped in any of the three quote styles. */
const IDENT_PART = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
/**
 * A possibly qualified name: `orders`, `sales.orders`, `"sales"."orders"`.
 *
 * Each repetition must consume a literal `.`, and no alternative of
 * IDENT_PART can match one, so the repeated group cannot overlap itself —
 * there is no ambiguous split for the engine to backtrack through.
 */
const IDENT = `${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})*`;

/**
 * Words that follow a table in a FROM clause and are not aliases.
 *
 * `FROM orders WHERE …` would otherwise bind the alias `where` to `orders`, and
 * a later `WHERE.total` lookup would resolve. Kept deliberately small: real
 * tables and aliases are often keywords, so only the words that genuinely
 * cannot be an alias in this position are listed.
 */
const NOT_AN_ALIAS = new Set([
  'on', 'where', 'group', 'order', 'having', 'limit', 'offset', 'fetch',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'natural',
  'union', 'except', 'intersect', 'window', 'using', 'set', 'values',
  'and', 'or', 'not', 'as', 'lateral', 'with',
]);

/**
 * Unquote each part of a qualified name: `"sales"."orders"` → `sales.orders`.
 *
 * Stripping the outer quotes of the whole string instead would yield
 * `sales"."orders`, which matches no table in the cache — the reason a
 * schema-qualified quoted name went unattributed.
 */
function stripQuotes(raw: string): string {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '`' | '[' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (quote === '[' && ch === ']') { quote = null; continue; }
      if (ch === quote) {
        if (ch !== '[' && raw[i + 1] === ch) { current += ch; i++; continue; }
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') { quote = ch === '[' ? '[' : (ch as '"' | '`'); continue; }
    if (ch === '.') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean).join('.');
}

/** Last segment of a possibly qualified name: `sales.orders` → `orders`. */
function bareName(name: string): string {
  const n = name.toLowerCase();
  return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n;
}

/**
 * The FROM/JOIN entries of a statement, in written order.
 *
 * Order is the point — `SELECT *` returns each table's columns in this
 * sequence, which is the only thing that separates three columns all called
 * `id`. `extractTableAliases` answers a different question (name → table, for
 * completion) and returns an unordered map, so it cannot be reused here.
 */
export function fromClauseEntries(sql: string): FromEntry[] {
  if (!sql.trim()) return [];
  const re = new RegExp(
    `\\b(?:FROM|JOIN)\\s+(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?|,\\s*(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?`,
    'gi'
  );
  const entries: FromEntry[] = [];
  const seen = new Set<string>();
  // Only commas *inside* the FROM clause introduce tables; a comma in the
  // SELECT list separates output columns. Bound the comma branch to the region
  // after the first FROM.
  const fromAt = sql.search(/\bFROM\b/i);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const viaComma = Boolean(m[3] && !m[1]);
    // Every rejection rewinds to just past the match start. The comma branch
    // can consume the `FROM` keyword as a candidate alias, so skipping without
    // rewinding steps over the real FROM clause and finds no tables at all.
    const reject = () => {
      re.lastIndex = m!.index + 1;
    };

    // A comma before the FROM clause separates SELECT-list columns.
    if (viaComma && (fromAt < 0 || m.index < fromAt)) { reject(); continue; }

    const rawName = m[1] ?? m[3];
    const rawAlias = m[2] ?? m[4];
    if (!rawName || rawName.startsWith('(')) { reject(); continue; }
    const name = stripQuotes(rawName);
    if (!name) { reject(); continue; }

    let alias = rawAlias ? stripQuotes(rawAlias) : undefined;
    if (alias && NOT_AN_ALIAS.has(alias.toLowerCase())) alias = undefined;
    // A comma branch whose "alias" is really a keyword means this comma was in
    // the SELECT list after all.
    if (viaComma && rawAlias && !alias) { reject(); continue; }

    const key = `${name.toLowerCase()}|${alias?.toLowerCase() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(alias ? { name, alias } : { name });
  }
  return entries;
}

/** A FROM entry paired with the catalog table it resolved to. */
interface ResolvedEntry {
  entry: FromEntry;
  table: TableSchema;
}

/**
 * Match a FROM name against the schema cache.
 *
 * Bare and qualified names both resolve, because the cache stores a bare name
 * on the engines that scope a connection to one schema and a qualified one
 * elsewhere. This is attribution for display, not a write target, so a bare
 * match is acceptable here in a way it is not in `findCachedTableForEdit`.
 */
function resolveTable(name: string, tables: readonly TableSchema[]): TableSchema | undefined {
  const wanted = name.toLowerCase();
  const exact = tables.find((t) => t.name.toLowerCase() === wanted);
  if (exact) return exact;
  const bare = bareName(name);
  return tables.find((t) => bareName(t.name) === bare);
}

/**
 * Split `text` on top-level occurrences of `sep` — outside parentheses and
 * outside quoted text (`'…'`, `"…"`, `` `…` ``, `[…]`).
 *
 * `sep` is either a punctuation character (`,`) or a keyword (`AND`). A
 * keyword matches case-insensitively and only on word boundaries, so
 * `name LIKE '%AND%'` and a column called `brand` stay in one piece.
 *
 * This is the one top-level splitter — do not add a second scanner.
 */
export function splitTopLevel(text: string, sep: string): string[] {
  const isKeyword = /^[A-Za-z]/.test(sep);
  const lowerSep = sep.toLowerCase();
  const items: string[] = [];
  let depth = 0;
  let current = '';
  let quote: '"' | '`' | "'" | '[' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (quote === '[' && ch === ']') quote = null;
      else if (ch === quote) {
        if ((quote === '"' || quote === "'") && text[i + 1] === quote) {
          current += text[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'" || ch === '[') {
      quote = ch === '[' ? '[' : ch;
      current += ch;
      continue;
    }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    const hit =
      depth === 0 &&
      (isKeyword
        ? text.slice(i, i + sep.length).toLowerCase() === lowerSep &&
          !/[\w$]/.test(text[i - 1] ?? '') &&
          !/[\w$]/.test(text[i + sep.length] ?? '')
        : ch === sep);
    if (hit) {
      items.push(current.trim());
      current = '';
      i += sep.length - 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** Split a SELECT list on commas that are not inside parens or quotes. */
export function splitSelectItems(list: string): string[] {
  return splitTopLevel(list, ',');
}

/** The outer SELECT list text, or null when it cannot be isolated. */
function selectListOf(sql: string): string | null {
  // `FROM` inside a parenthesised subquery in the SELECT list must not end it.
  const t = sql.trim();
  const start = t.match(/^\s*SELECT\b/i);
  if (!start) return null;
  let depth = 0;
  let quote: '"' | '`' | "'" | '[' | null = null;
  for (let i = start[0].length; i < t.length; i++) {
    const ch = t[i]!;
    if (quote) {
      if (quote === '[' && ch === ']') quote = null;
      else if (ch === quote) {
        if ((quote === '"' || quote === "'") && t[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'" || ch === '[') { quote = ch === '[' ? '[' : ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && /\s/.test(ch) && /^FROM\b/i.test(t.slice(i + 1))) {
      return t.slice(start[0].length, i).trim();
    }
  }
  return null;
}

/** `o.total` / `"s"."t"."c"` → its qualifier and column, or null. */
function parseColumnRef(item: string): { qualifier?: string; column: string } | null {
  const ref = new RegExp(
    `^(?:((?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*))\\s*\\.\\s*)?("[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)$`
  ).exec(item.trim());
  if (!ref) return null;
  const column = stripQuotes(ref[2]!);
  if (!column) return null;
  const qualifier = ref[1] ? stripQuotes(ref[1]) : undefined;
  return qualifier ? { qualifier, column } : { column };
}

/** One column the statement is expected to produce, and where it came from. */
interface ExpectedColumn {
  column: string;
  table?: string;
  qualifier?: string;
  confidence: OriginConfidence;
}

export interface AttributeOptions {
  /** The statement that produced the grid. */
  sql: string;
  /** Column names exactly as the driver returned them. */
  resultColumns: readonly string[];
  /** Schema cache for the connection. */
  tables: readonly TableSchema[] | undefined;
}

/**
 * Work out which table each result column came from.
 *
 * Two passes, because they fail in different places. The first expands the
 * SELECT list against the FROM tables and lines it up with the result columns
 * position by position — exact for `SELECT *` and for explicit column lists,
 * and the only thing that can separate columns sharing a name. If the alignment
 * does not match the result the statement actually produced, it is abandoned
 * whole rather than trusted partially: a alignment that has drifted is
 * confidently wrong, which is the one outcome worth avoiding.
 *
 * The second pass then attributes each column on its own, by finding the tables
 * that have a column of that name. One table means one answer; more than one is
 * left `unknown`.
 */
export function attributeResultColumns(options: AttributeOptions): ColumnOrigin[] {
  const { sql, resultColumns, tables } = options;
  const blank = (): ColumnOrigin[] =>
    resultColumns.map((column, index) => ({ index, column, confidence: 'unknown' as const }));

  if (!sql?.trim() || resultColumns.length === 0 || !tables?.length) return blank();

  const resolved: ResolvedEntry[] = [];
  for (const entry of fromClauseEntries(sql)) {
    const table = resolveTable(entry.name, tables);
    if (table) resolved.push({ entry, table });
  }
  if (resolved.length === 0) return blank();

  const byQualifier = new Map<string, ResolvedEntry>();
  for (const r of resolved) {
    if (r.entry.alias) byQualifier.set(r.entry.alias.toLowerCase(), r);
    byQualifier.set(r.entry.name.toLowerCase(), r);
    byQualifier.set(bareName(r.entry.name), r);
  }

  const aligned = alignSelectList(sql, resolved, byQualifier);
  if (aligned && sameShape(aligned, resultColumns)) {
    return aligned.map((e, index) => ({
      index,
      column: resultColumns[index]!,
      ...(e.table ? { table: e.table } : {}),
      ...(e.qualifier ? { qualifier: e.qualifier } : {}),
      confidence: e.confidence,
    }));
  }

  return resultColumns.map((column, index) => {
    const owners = resolved.filter((r) =>
      r.table.columns?.some((c) => c.name.toLowerCase() === column.toLowerCase())
    );
    if (owners.length === 1) {
      const only = owners[0]!;
      return {
        index,
        column,
        table: only.table.name,
        ...(only.entry.alias ? { qualifier: only.entry.alias } : {}),
        confidence: 'unique' as const,
      };
    }
    return { index, column, confidence: 'unknown' as const };
  });
}

/** Expand the SELECT list into the columns it should produce, in order. */
function alignSelectList(
  sql: string,
  resolved: readonly ResolvedEntry[],
  byQualifier: ReadonlyMap<string, ResolvedEntry>
): ExpectedColumn[] | null {
  const list = selectListOf(sql);
  if (list == null || !list) return null;
  const body = list.replace(/^(?:DISTINCT|ALL)\s+/i, '').trim();
  if (!body) return null;

  const out: ExpectedColumn[] = [];
  const columnsOf = (r: ResolvedEntry): ExpectedColumn[] =>
    (r.table.columns ?? []).map((c) => ({
      column: c.name,
      table: r.table.name,
      ...(r.entry.alias ? { qualifier: r.entry.alias } : {}),
      confidence: 'positional' as const,
    }));

  for (const raw of splitSelectItems(body)) {
    const item = raw.trim();
    if (item === '*') {
      // Every table's columns, in FROM order — this is what the engine does.
      for (const r of resolved) out.push(...columnsOf(r));
      continue;
    }
    const starRef = /^(.+?)\s*\.\s*\*$/.exec(item);
    if (starRef) {
      const owner = byQualifier.get(stripQuotes(starRef[1]!).toLowerCase());
      if (!owner) return null;
      out.push(...columnsOf(owner));
      continue;
    }
    const ref = parseColumnRef(item);
    if (!ref) return null; // an expression, a cast, a function — give up on alignment
    if (ref.qualifier) {
      const owner = byQualifier.get(ref.qualifier.toLowerCase());
      if (!owner) return null;
      out.push({
        column: ref.column,
        table: owner.table.name,
        qualifier: ref.qualifier,
        confidence: 'qualified',
      });
      continue;
    }
    const owners = resolved.filter((r) =>
      r.table.columns?.some((c) => c.name.toLowerCase() === ref.column.toLowerCase())
    );
    if (owners.length === 1) {
      const only = owners[0]!;
      out.push({
        column: ref.column,
        table: only.table.name,
        ...(only.entry.alias ? { qualifier: only.entry.alias } : {}),
        confidence: 'unique',
      });
    } else {
      out.push({ column: ref.column, confidence: 'unknown' });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Does the expansion describe the result the driver actually returned?
 *
 * Both the count and the names must line up. A stale schema cache, a column
 * added since it was loaded, or a `SELECT *` over a view would otherwise shift
 * every attribution by one and label the whole grid wrongly.
 */
function sameShape(expected: readonly ExpectedColumn[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((e, i) => e.column.toLowerCase() === actual[i]!.toLowerCase());
}

export interface CollapsedColumns {
  /** Names the statement produced more than once. */
  names: string[];
  /** How many columns never reached the grid. */
  lost: number;
}

/**
 * Columns the statement produced that never reached the grid.
 *
 * Rows arrive from the drivers as objects keyed by column name, so a join whose
 * tables share a column name loses all but one of them: `SELECT *` over four
 * tables that each have `id` yields one `id`, holding the *last* table's value.
 * Nothing errors. The grid shows a row that reads as one record but mixes
 * values from different tables, with columns silently missing.
 *
 * This does not fix that — the fix is for the drivers to return rows
 * positionally — but a grid that is quietly wrong is worse than one that says
 * so, so the caller can warn.
 *
 * Returns null unless the expansion is trustworthy: every FROM table resolved,
 * and every column that did arrive was one the statement was expected to
 * produce. Otherwise the shortfall is more likely a stale cache than a
 * collapse, and claiming lost columns would be its own false alarm.
 */
export function collapsedColumnsFor(options: AttributeOptions): CollapsedColumns | null {
  const { sql, resultColumns, tables } = options;
  if (!sql?.trim() || resultColumns.length === 0 || !tables?.length) return null;

  const entries = fromClauseEntries(sql);
  const resolved: ResolvedEntry[] = [];
  for (const entry of entries) {
    const table = resolveTable(entry.name, tables);
    if (!table) return null; // an unknown table — the expansion would be short anyway
    resolved.push({ entry, table });
  }
  if (resolved.length < 2) return null; // a single table cannot collide with itself

  const byQualifier = new Map<string, ResolvedEntry>();
  for (const r of resolved) {
    if (r.entry.alias) byQualifier.set(r.entry.alias.toLowerCase(), r);
    byQualifier.set(r.entry.name.toLowerCase(), r);
    byQualifier.set(bareName(r.entry.name), r);
  }

  const expected = alignSelectList(sql, resolved, byQualifier);
  if (!expected || expected.length <= resultColumns.length) return null;

  const counts = new Map<string, number>();
  for (const e of expected) {
    const k = e.column.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Everything that arrived must be something the statement was going to
  // produce, or this is drift rather than a collapse.
  const actual = new Set(resultColumns.map((c) => c.toLowerCase()));
  for (const name of actual) if (!counts.has(name)) return null;
  // And the distinct names must line up exactly with what did arrive.
  if (counts.size !== actual.size) return null;

  const names: string[] = [];
  let lost = 0;
  for (const [name, count] of counts) {
    if (count > 1) {
      names.push(name);
      lost += count - 1;
    }
  }
  return lost > 0 ? { names, lost } : null;
}

/**
 * The distinct tables an attribution touched, in first-appearance order.
 *
 * The UI groups by this, so a stable order matters: it is the order the columns
 * appear in the grid, not the order the schema cache happens to hold.
 */
export function tablesInOrigins(origins: readonly ColumnOrigin[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of origins) {
    if (!o.table) continue;
    const key = o.table.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o.table);
  }
  return out;
}

export interface RowKeyValue {
  column: string;
  index: number;
  value: unknown;
}

/**
 * The primary-key columns of `table` as they appear in this result, or null.
 *
 * This is what makes "open this row" possible from a joined grid: with the key
 * present, the row can be re-fetched from its own table as a single-table
 * query, which is editable through the path that already exists. Without it
 * there is no safe way back to the row, and the caller offers nothing.
 *
 * Only columns attributed to `table` are considered. Matching the key by name
 * across the whole result would happily take `customers.id` as the key for
 * `orders` in a join where both are called `id` — the exact confusion this
 * module exists to remove.
 */
export function rowKeyFor(
  table: TableSchema,
  origins: readonly ColumnOrigin[],
  row: readonly unknown[]
): RowKeyValue[] | null {
  const keyNames = table.primaryKey?.columns ?? [];
  if (keyNames.length === 0) return null;

  const mine = origins.filter(
    (o) => o.table && o.table.toLowerCase() === table.name.toLowerCase()
  );
  if (mine.length === 0) return null;

  const out: RowKeyValue[] = [];
  for (const name of keyNames) {
    const hit = mine.find((o) => o.column.toLowerCase() === name.toLowerCase());
    if (!hit) return null;
    const value = row[hit.index];
    // A NULL key is an outer join that did not match — there is no row to open.
    if (value === null || value === undefined) return null;
    out.push({ column: name, index: hit.index, value });
  }
  return out;
}
