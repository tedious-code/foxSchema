/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Give every unaliased SELECT expression a name, so the grid can show it.
 *
 * The grid builds its columns from the keys of each row object, so two result
 * columns arriving under one key collapse into one and a column disappears
 * with no error. What the drivers actually return for `SELECT 1, 2`:
 *
 *   Postgres    `?column?` for *every* unaliased expression → 1 key, 1 column
 *   SQL Server  `''` (unnamed)                              → 1 key, 1 column
 *   MySQL       the expression text                         → collides on ties
 *   Db2         positional `1`, `2`                          → fine
 *   Oracle      de-duplicates (`1+1`, `1+1_1`)               → fine
 *
 * Naming the expressions in the SQL fixes it at the source and, unlike reading
 * driver metadata, gives the user a header they can recognise.
 *
 * Deliberately conservative: it rewrites only what it can parse with
 * confidence, and returns the statement untouched otherwise. A grid column is
 * not worth breaking someone's query over.
 */

/** Result of a rewrite attempt. `changed` is false when nothing was needed. */
export interface AliasedSelect {
  sql: string;
  changed: boolean;
  /** Aliases that were added, in order — for tests and for explaining the diff. */
  added: string[];
}

/**
 * Written as separate anchored alternatives rather than one pattern with
 * nested quantifiers: this runs on whatever the user has typed so far, and an
 * ambiguous regex there is a denial of service, not a style nit.
 */
const LEADING_MODIFIERS = [
  /^(?:all|distinct|distinctrow|unique)\b/i,
  /^top\b/i,
];

/** One identifier part: bare, or wrapped in the engines' three quote styles. */
const IDENT_PART = /^(?:[A-Za-z_][\w$#]*|"[^"]+"|`[^`]+`|\[[^\]]+\])$/;

/**
 * A plain column reference (`id`, `t.id`, `"s"."t"."c"`), which every engine
 * already names sensibly — nothing to add.
 *
 * Split-then-check rather than one regex: the pattern for a dotted chain needs
 * a quantified group inside a quantified group, which is exactly the shape that
 * backtracks exponentially.
 */
function isPlainRef(text: string): boolean {
  const parts = text.split('.');
  if (parts.length > 4) return false;
  return parts.every((part) => IDENT_PART.test(part.trim()));
}

/** Words that can end an expression without being an implicit alias. */
const NOT_AN_ALIAS = new Set([
  'and', 'or', 'not', 'is', 'null', 'end', 'else', 'then', 'when', 'case',
  'like', 'in', 'between', 'asc', 'desc', 'nulls', 'first', 'last', 'escape',
]);

/**
 * Walk `sql` from `start`, returning the index just past the top-level SELECT
 * list, or -1 when the shape is not one we are confident about.
 *
 * "Top level" means depth 0: a FROM inside a subquery or a function call must
 * not end the outer list.
 */
function findSelectListEnd(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // Doubled quote is an escape, not a terminator.
          if (sql[i + 1] === quote) i += 2;
          else break;
        } else i++;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      // More closes than opens: we are inside something we did not start.
      if (depth < 0) return i;
    } else if (depth === 0 && c === ';') {
      // The statement's own terminator — the editor sends it. Read as part of
      // the last item, `SELECT 100 AS seed;` gained `; AS col_1` after it.
      return i;
    } else if (depth === 0 && /\s/.test(c)) {
      const rest = sql.slice(i + 1);
      if (/^from\b/i.test(rest)) return i;
      // A SELECT with no FROM (Postgres/MySQL/SQL Server) still ends somewhere.
      if (/^(?:into|where|group\b|having|order\b|limit|fetch|union|except|intersect|for\b|option\b)\b/i.test(rest)) {
        return i;
      }
    }
    i++;
  }
  return depth === 0 ? sql.length : -1;
}

/** Split a SELECT list on its top-level commas. */
function splitTopLevel(list: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < list.length) {
        if (list[i] === quote) {
          if (list[i + 1] === quote) i += 2;
          else break;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const end = list.indexOf(']', i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(last, i));
      last = i + 1;
    }
  }
  out.push(list.slice(last));
  return depth === 0 ? out : null;
}

/** True when the item already ends in an alias, explicit or implicit. */
function hasAlias(item: string): boolean {
  const trimmed = item.trim();
  if (/\bas\s+(?:[A-Za-z_][\w$#]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*$/i.test(trimmed)) return true;
  // Implicit alias: `expr name`, but only when the tail is a bare word that is
  // not part of the expression's own syntax (`… END`, `… IS NULL`).
  const implicit = trimmed.match(/(?:^|[\s)])([A-Za-z_][\w$#]*)\s*$/);
  if (!implicit) return false;
  const word = implicit[1]!.toLowerCase();
  if (NOT_AN_ALIAS.has(word)) return false;
  // `count(*)` ends with `)`, not a word — so a trailing word here means the
  // expression is `something alias`, unless the whole item is one plain ref.
  return !isPlainRef(trimmed);
}

/**
 * A single quoted string or number, and nothing else.
 *
 * Scanned rather than matched: every regex for a quoted body with doubled
 * quotes is either ambiguous (`(?:[^']|'')*`) or trips the ReDoS detector even
 * when unrolled, and this runs on half-typed SQL from the editor.
 */
function isLoneLiteral(text: string): boolean {
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: fully anchored, and the optional group starts with a literal '.' that \d+ cannot match, so there is no ambiguity to backtrack over
  if (/^\d+(?:\.\d+)?$/.test(text)) return true;
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) return false;
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== "'") continue;
    // An interior quote is legal only as a doubled pair.
    if (text[i + 1] !== "'") return false;
    i++;
  }
  return true;
}

/** A readable alias stem for an expression, e.g. `count(*)` → `count`. */
function stemFor(item: string, index: number): string {
  const fn = item.trim().match(/^([A-Za-z_][\w$#]*)\s*\(/);
  if (fn) return fn[1]!.toLowerCase();
  if (/^\s*case\b/i.test(item)) return 'case';
  // Only a lone literal earns the name "literal" — `1 + 1` is an expression,
  // and calling it a literal would misdescribe the column in the header.
  if (isLoneLiteral(item.trim())) return 'literal';
  return `col_${index + 1}`;
}

/**
 * Add `AS <name>` to every SELECT item that would otherwise reach the grid
 * unnamed. Returns the statement unchanged when it is not a plain SELECT, when
 * the list cannot be parsed confidently, or when nothing needs a name.
 */
export function autoAliasSelectColumns(sql: string): AliasedSelect {
  const unchanged: AliasedSelect = { sql, changed: false, added: [] };
  const lead = sql.match(/^\s*select\b/i);
  if (!lead) return unchanged;

  let cursor = lead[0].length;
  // Skip DISTINCT / TOP n / ALL before the list proper.
  for (;;) {
    const rest = sql.slice(cursor).replace(/^\s+/, '');
    const skipped = sql.length - rest.length - cursor;
    const mod = LEADING_MODIFIERS.map((re) => rest.match(re)).find(Boolean);
    if (!mod) break;
    cursor += skipped + mod[0].length;
    // `TOP n` / `TOP n PERCENT` — consume the count separately so the pattern
    // above stays a simple keyword match.
    if (/^top$/i.test(mod[0])) {
      const count = sql.slice(cursor).match(/^\s+\d+/);
      if (count) cursor += count[0].length;
      const percent = sql.slice(cursor).match(/^\s+percent\b/i);
      if (percent) cursor += percent[0].length;
    }
  }

  const end = findSelectListEnd(sql, cursor);
  if (end < 0) return unchanged;
  const list = sql.slice(cursor, end);
  const items = splitTopLevel(list);
  if (!items || items.length === 0) return unchanged;

  // Names already spoken for, so a generated one never shadows a real column.
  const taken = new Set<string>();
  for (const item of items) {
    const explicit = item.trim().match(/\bas\s+([A-Za-z_][\w$#]*)\s*$/i);
    if (explicit) taken.add(explicit[1]!.toLowerCase());
  }

  const added: string[] = [];
  const rewritten = items.map((item, i) => {
    const trimmed = item.trim();
    if (!trimmed) return item;
    // `*` and `t.*` expand to real columns the engine names itself.
    if (/\*\s*$/.test(trimmed)) return item;
    if (isPlainRef(trimmed)) return item;
    if (hasAlias(trimmed)) return item;

    let name = stemFor(trimmed, i);
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    taken.add(name);
    added.push(name);
    // Keep the author's own spacing; append rather than reformat.
    return `${item.replace(/\s+$/, '')} AS ${name}`;
  });

  if (added.length === 0) return unchanged;
  return { sql: sql.slice(0, cursor) + rewritten.join(',') + sql.slice(end), changed: true, added };
}
