/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Top-level ORDER BY parsing and uniqueness checks for Last Id paging.
 * OFFSET remains the fallback when the order key is not unique.
 */
import type { IndexInfo, PrimaryKeyInfo } from '@foxschema/sql';

export interface OrderByTerm {
  /** Unquoted identifier; last segment if `schema.col` / `alias.col`. */
  column: string;
  descending: boolean;
}

export interface ParsedOrderBy {
  terms: OrderByTerm[];
}

/**
 * One identifier part: `"quoted"`, `` `backticked` ``, `[bracketed]`, or bare.
 *
 * Returns the unquoted text, or null if `part` is not a well-formed
 * identifier. A quoted part is taken literally, so `"a.b"` is one name.
 */
function unquotePart(t: string): string | null {
  // Deliberately not trimmed: the caller trims the whole term once, so a space
  // surviving here sits *inside* the identifier — `db . orders`. The regex this
  // replaced rejected that, and this is a lint fix, not a parser change.
  if (t.length === 0) return null;
  const pairs: Record<string, string> = { '"': '"', '`': '`', '[': ']' };
  const close = pairs[t[0]!];
  if (close) {
    if (t.length < 3 || t[t.length - 1] !== close) return null;
    const inner = t.slice(1, -1);
    // A delimiter inside would mean the caller split in the wrong place.
    return inner.length > 0 && !inner.includes(close) ? inner : null;
  }
  return /^[A-Za-z_][\w$]*$/.test(t) ? t : null;
}

/**
 * The column an ORDER BY term names, with quoting removed.
 *
 * Split rather than matched with one regex: the qualified form is four
 * delimiter styles crossed with an optional second part, and writing that as a
 * single pattern nests a quantifier inside an optional group — which is what
 * `security/detect-unsafe-regex` objects to, and it is right to. Scanning for
 * the one separating dot is linear and says what it means.
 *
 * Returns the last part, so `db.orders` and `orders` both yield `orders`.
 */
function unquoteIdent(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0) return null;

  // Find the dot that separates qualifier from column, skipping any that sit
  // inside a quoted part.
  const pairs: Record<string, string> = { '"': '"', '`': '`', '[': ']' };
  let split = -1;
  for (let i = 0; i < t.length; i++) {
    const close = pairs[t[i]!];
    if (close) {
      const end = t.indexOf(close, i + 1);
      if (end === -1) return null; // unterminated
      i = end;
      continue;
    }
    if (t[i] === '.') {
      if (split !== -1) return null; // more parts than this understands
      split = i;
    }
  }

  if (split === -1) return unquotePart(t);
  // Both sides must be well formed; a bad qualifier means the whole term is.
  const qualifier = unquotePart(t.slice(0, split));
  const column = unquotePart(t.slice(split + 1));
  return qualifier && column ? column : null;
}

/**
 * True when `sql` has a top-level `ORDER BY` (paren depth 0), ignoring
 * strings and comments. Same rules as the page wrap.
 */
export function findTopLevelOrderByIndex(sql: string): number {
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
      const before = i === 0 ? ' ' : sql[i - 1]!;
      if (!/[A-Za-z0-9_]/.test(before) && /^order\s+by\b/i.test(sql.slice(i))) return i;
    }
    i++;
  }
  return -1;
}

/** Parse top-level ORDER BY into simple column terms. Expressions / ordinals → null. */
export function parseTopLevelOrderBy(sql: string): ParsedOrderBy | null {
  const at = findTopLevelOrderByIndex(sql);
  if (at < 0) return null;
  const afterKw = sql.slice(at).replace(/^order\s+by\s+/i, '');
  const terms: OrderByTerm[] = [];
  let buf = '';
  let depth = 0;
  let i = 0;
  const flush = (): boolean => {
    const raw = buf.trim().replace(/,+\s*$/, '');
    buf = '';
    if (!raw) return true;
    const desc = /\s+desc\s*$/i.test(raw);
    const asc = /\s+asc\s*$/i.test(raw);
    const ident = raw.replace(/\s+(asc|desc)\s*$/i, '').trim();
    if (/^\d+$/.test(ident)) return false;
    const column = unquoteIdent(ident);
    if (!column) return false;
    terms.push({ column, descending: desc && !asc ? true : desc });
    return true;
  };
  while (i < afterKw.length) {
    const ch = afterKw[i]!;
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === ',') {
      if (!flush()) return null;
      i++;
      continue;
    }
    if (depth === 0 && ch === ';') break;
    buf += ch;
    i++;
  }
  if (!flush()) return null;
  if (terms.length === 0) return null;
  return { terms };
}

export function uniqueKeysFromTable(table: {
  primaryKey?: PrimaryKeyInfo;
  columns: readonly { name: string; primaryKey?: boolean; nullable?: boolean }[];
  indices: readonly IndexInfo[];
}): string[][] {
  const keys: string[][] = [];
  const pk =
    table.primaryKey?.columns?.filter(Boolean) ??
    table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pk.length > 0) keys.push(pk);
  const columns = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  for (const idx of table.indices) {
    // A partial unique index is unique only inside its predicate, while a
    // nullable unique index can admit repeated NULLs. Neither proves that an
    // unfiltered result is globally unique enough for keyset paging.
    if (
      !idx.unique ||
      !idx.columns?.length ||
      Boolean(idx.filter?.trim()) ||
      !idx.columns.every((name) => columns.get(name.toLowerCase())?.nullable === false)
    ) {
      continue;
    }
    keys.push(idx.columns);
  }
  return keys;
}

/**
 * A unique key covers ORDER BY when the key columns are a prefix of the order
 * list (same names, same order, case-insensitive). ORDER BY extra columns after
 * a unique prefix is still unique.
 */
export function uniqueKeyCoversOrder(
  uniqueKeys: readonly string[][],
  orderColumns: readonly string[]
): boolean {
  if (orderColumns.length === 0) return false;
  const order = orderColumns.map((c) => c.toLowerCase());
  for (const key of uniqueKeys) {
    if (key.length === 0 || key.length > order.length) continue;
    const ok = key.every((col, i) => col.toLowerCase() === order[i]);
    if (ok) return true;
  }
  return false;
}

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Reject names the wrap would otherwise quote from a hostile client. */
export function isSafeSeekColumn(name: string): boolean {
  return SAFE_IDENT.test(name) && name.length <= 128;
}
