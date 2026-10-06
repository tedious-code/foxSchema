/**
 * Helpers to inject columns into a SELECT list (Schema click / column picker).
 */
import { extractTableAliases } from '@/shared/lib/sql-splitter';
import { escapeRegExp } from '@foxschema/ui-shared';

/** Find the SELECT … FROM span for the first SELECT in `sql` (heuristic). */
export function findSelectListRange(
  sql: string
): { selectKeywordStart: number; listStart: number; listEnd: number; fromStart: number } | null {
  const re = /\bselect\b/i;
  const m = re.exec(sql);
  if (!m) return null;
  const selectKeywordStart = m.index;
  const afterSelect = selectKeywordStart + m[0].length;
  // Skip DISTINCT / ALL / TOP n
  let i = afterSelect;
  const head = sql.slice(i);
  const skip = /^\s+(?:distinct|all)\b/i.exec(head);
  if (skip) i += skip[0].length;
  // Two passes, not `\d+(\s+percent)?\b`: a `+` nested inside an optional group
  // is the star-height-2 shape `security/detect-unsafe-regex` rejects, and this
  // runs on every keystroke against editor text.
  const top = /^\s+top\s+\d+\b/i.exec(sql.slice(i));
  if (top) {
    i += top[0].length;
    const percent = /^\s+percent\b/i.exec(sql.slice(i));
    if (percent) i += percent[0].length;
  }
  const listStart = i;
  const fromRe = /\bfrom\b/i;
  const fromMatch = fromRe.exec(sql.slice(listStart));
  if (!fromMatch) return null;
  const fromStart = listStart + fromMatch.index;
  return { selectKeywordStart, listStart, listEnd: fromStart, fromStart };
}

/** Split a SELECT list on top-level commas (ignore commas inside () / quotes). */
export function parseSelectListItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    const prev = i > 0 ? list[i - 1]! : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      const part = list.slice(start, i).trim();
      if (part) items.push(part);
      start = i + 1;
    }
  }
  const last = list.slice(start).trim();
  if (last) items.push(last);
  return items;
}

function replaceSelectList(sql: string, nextListInner: string): string {
  const range = findSelectListRange(sql);
  if (!range) {
    return `SELECT ${nextListInner.trim() || '*'}\nFROM `;
  }
  const inner = nextListInner.trim();
  const nextList = inner ? ` ${inner} ` : ' ';
  return sql.slice(0, range.listStart) + nextList + sql.slice(range.listEnd);
}

/**
 * Insert `columnExpr` into the SELECT list (before FROM). Replaces a lone `*`
 * when that is the only item; otherwise appends with a comma.
 */
export function insertIntoSelectList(sql: string, columnExpr: string): string {
  const range = findSelectListRange(sql);
  if (!range) {
    return `SELECT ${columnExpr}\nFROM `;
  }
  const list = sql.slice(range.listStart, range.listEnd).trim();
  let nextList: string;
  if (!list || list === '*') {
    nextList = ` ${columnExpr} `;
  } else {
    const items = parseSelectListItems(list);
    if (items.some((it) => it.toLowerCase() === columnExpr.toLowerCase())) {
      return sql; // already present
    }
    const needsComma = !/,\s*$/.test(list);
    nextList = ` ${list}${needsComma ? ',' : ''} ${columnExpr} `;
  }
  return sql.slice(0, range.listStart) + nextList + sql.slice(range.listEnd);
}

/** Replace the SELECT list with `*`. */
export function setSelectListToStar(sql: string): string {
  return replaceSelectList(sql, '*');
}

/** Clear every SELECT item (leaves `SELECT  FROM …`). */
export function clearSelectList(sql: string): string {
  return replaceSelectList(sql, '');
}

/** Remove one expression from the SELECT list (case-insensitive match). */
export function removeFromSelectList(sql: string, columnExpr: string): string {
  const range = findSelectListRange(sql);
  if (!range) return sql;
  const list = sql.slice(range.listStart, range.listEnd).trim();
  if (!list) return sql;
  if (list === '*') return sql;
  const target = columnExpr.toLowerCase();
  const next = parseSelectListItems(list).filter((it) => it.toLowerCase() !== target);
  if (next.length === parseSelectListItems(list).length) return sql;
  return replaceSelectList(sql, next.join(', '));
}

/** True when the SELECT list is exactly `*`. */
export function selectListIsStar(sql: string): boolean {
  const range = findSelectListRange(sql);
  if (!range) return false;
  return sql.slice(range.listStart, range.listEnd).trim() === '*';
}

/** Normalized SELECT items currently in the first SELECT list. */
export function currentSelectListItems(sql: string): string[] {
  const range = findSelectListRange(sql);
  if (!range) return [];
  const list = sql.slice(range.listStart, range.listEnd).trim();
  if (!list || list === '*') return list === '*' ? ['*'] : [];
  return parseSelectListItems(list);
}

/** Keywords that must never be used as a generated table alias. */
const ALIAS_BLACKLIST = new Set([
  'select',
  'from',
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'on',
  'and',
  'or',
  'group',
  'order',
  'by',
  'having',
  'limit',
  'offset',
  'union',
  'except',
  'intersect',
  'as',
  'with',
  'into',
  'set',
  'update',
  'delete',
  'insert',
  'values',
  'table',
  'view',
]);

/** Split `order_items` / `OrderItems` / `order-items` into lowercase parts. */
export function splitTableIdentParts(tableName: string): string[] {
  const bare = tableName.includes('.')
    ? tableName.slice(tableName.lastIndexOf('.') + 1)
    : tableName;
  const cleaned = bare.replace(/[^A-Za-z0-9]+/g, '_');
  const snake = cleaned.split(/_+/).filter(Boolean);
  const parts: string[] = [];
  for (const chunk of snake) {
    // Camel / Pascal: OrderItems → Order, Items ; alreadyLower stays one part.
    const camel = chunk.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    for (const p of camel) {
      const low = p.toLowerCase();
      if (low) parts.push(low);
    }
  }
  // Drop noisy schema prefixes/suffixes that shouldn't drive the alias.
  return parts.filter((p) => !['tbl', 'table', 'view', 'dim', 'fact', 'tmp', 'temp'].includes(p));
}

/** First letter + following distinct consonants (orders → ords, customers → cstm). */
function consonantSketch(word: string): string {
  if (!word) return '';
  const chars = word.toLowerCase().split('');
  let out = chars[0] ?? '';
  for (let i = 1; i < chars.length && out.length < 4; i++) {
    const ch = chars[i]!;
    if ('aeiou'.includes(ch)) continue;
    if (out.includes(ch)) continue;
    out += ch;
  }
  return out;
}

/**
 * Suggest a short, readable alias for `tableName` that does not collide with
 * existing aliases/tables in `sql` (or an optional precomputed set).
 *
 * Strategy (first free candidate wins):
 * 1. Multi-part names → initials (`order_items` / `OrderItems` → `oi`)
 * 2. Single word → 3-letter stem, consonant sketch, then grow 2…n letters
 * 3. Numeric suffix only after those readable forms are exhausted
 */
export function suggestTableAlias(tableName: string, sqlOrTaken: string | Set<string>): string {
  const parts = splitTableIdentParts(tableName);
  const word = parts.join('') || 't';
  const taken =
    typeof sqlOrTaken === 'string'
      ? new Set(Object.keys(extractTableAliases(sqlOrTaken)))
      : sqlOrTaken;

  const candidates: string[] = [];
  const push = (c: string) => {
    const v = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!v || !/^[a-z]/.test(v)) return;
    if (!candidates.includes(v)) candidates.push(v);
  };

  if (parts.length >= 2) {
    const initials = parts.map((p) => p[0]!).join('');
    push(initials);
    // Initials + last-part vowel-stripped tail: order_items → oit / oitems
    push(initials + (parts[parts.length - 1] ?? '').slice(1, 3));
    push(parts.map((p) => p.slice(0, 2)).join('').slice(0, 4));
  }

  // Single-word (and fallback) progressive stems — prefer 3 letters over 1.
  push(word.slice(0, 3));
  push(consonantSketch(word));
  push(word.slice(0, 2));
  push(word.slice(0, 4));
  push(word.slice(0, 1));
  for (let n = 5; n <= Math.min(word.length, 6); n++) push(word.slice(0, n));

  for (const base of candidates) {
    if (ALIAS_BLACKLIST.has(base) || taken.has(base)) continue;
    return base;
  }

  const seed = candidates.find((c) => !ALIAS_BLACKLIST.has(c)) ?? 't';
  for (let n = 2; n < 100; n++) {
    const candidate = `${seed}${n}`;
    if (!taken.has(candidate) && !ALIAS_BLACKLIST.has(candidate)) return candidate;
  }
  return `${seed}_${Date.now().toString(36).slice(-3)}`;
}

/** Short alias already assigned to this table in `sql`, if any. */
export function existingShortAliasForTable(sql: string, tableIdent: string): string | null {
  const bare = tableIdent.includes('.')
    ? tableIdent.slice(tableIdent.lastIndexOf('.') + 1)
    : tableIdent;
  const bareKey = bare.toLowerCase();
  const fullKey = tableIdent.toLowerCase();
  for (const [alias, table] of Object.entries(extractTableAliases(sql))) {
    const t = table.toLowerCase();
    if (t !== bareKey && t !== fullKey && !t.endsWith(`.${bareKey}`)) continue;
    // Skip the synthetic keys extractTableAliases always adds for the table name itself.
    if (alias === t || alias === bareKey || alias === fullKey) continue;
    return alias;
  }
  return null;
}

/**
 * Shortest alias in `sql` for each table in FROM/JOIN, looked up by either the
 * name as written or its bare part.
 *
 * Both keys matter: the FROM clause may be schema-qualified (`Carter.ORDER ord`)
 * while the schema cache only knows the bare name (`ORDER`). Keying on the
 * qualified string alone makes a bare lookup miss, and the caller then falls
 * back to the table name — which is both the wrong prefix and, for a reserved
 * word like `ORDER`, invalid SQL.
 */
export function shortAliasesByTable(sql: string): Map<string, string> {
  const byTable = new Map<string, string>();
  const put = (key: string, alias: string) => {
    const prev = byTable.get(key);
    if (!prev || alias.length < prev.length) byTable.set(key, alias);
  };
  for (const [alias, table] of Object.entries(extractTableAliases(sql))) {
    const full = table.toLowerCase();
    put(full, alias);
    if (full.includes('.')) put(full.slice(full.lastIndexOf('.') + 1), alias);
  }
  return byTable;
}

/**
 * Add a short alias after a bare table in FROM/JOIN and rewrite `table.` →
 * `alias.` in the SELECT list. No-op when a short alias already exists.
 */
export function ensureTableHasAlias(
  sql: string,
  tableIdent: string,
  alias?: string
): { sql: string; alias: string; changed: boolean } {
  const bare = tableIdent.includes('.')
    ? tableIdent.slice(tableIdent.lastIndexOf('.') + 1)
    : tableIdent;
  const existing = existingShortAliasForTable(sql, tableIdent);
  if (existing) return { sql, alias: existing, changed: false };

  const nextAlias = alias || suggestTableAlias(bare, sql);
  const tableAlt = [tableIdent, bare].filter((v, i, a) => a.indexOf(v) === i);
  const tablePat = tableAlt.map((t) => escapeRegExp(t)).join('|');

  // FROM|JOIN table  →  FROM|JOIN table alias  (when not already followed by an alias)
  const fromRe = new RegExp(
    `(\\b(?:FROM|JOIN)\\s+)(${tablePat})(\\s*)(?=(?:WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|FOR\\s+UPDATE|,|;|$|\\)|\\n))`,
    'i'
  );
  let next: string;
  if (fromRe.test(sql)) {
    next = sql.replace(fromRe, `$1$2 ${nextAlias}$3`);
  } else {
    // Comma form: `, table` at end of FROM item
    const commaRe = new RegExp(
      `(,\\s*)(${tablePat})(\\s*)(?=(?:WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|FOR\\s+UPDATE|,|;|$|\\)|\\n))`,
      'i'
    );
    if (!commaRe.test(sql)) {
      return { sql, alias: bare, changed: false };
    }
    next = sql.replace(commaRe, `$1$2 ${nextAlias}$3`);
  }

  // Rewrite SELECT qualifiers table.col → alias.col
  const qualRe = new RegExp(`\\b(${tablePat})\\.`, 'gi');
  next = next.replace(qualRe, `${nextAlias}.`);

  return { sql: next, alias: nextAlias, changed: next !== sql };
}

/**
 * Ensure every table referenced in FROM has a short alias (e.g. `orders` →
 * `orders o`). Used when opening the column picker or accepting a table.
 */
export function ensureAllFromTablesAliased(sql: string): string {
  const names = new Set<string>();
  for (const table of Object.values(extractTableAliases(sql))) {
    names.add(table);
  }
  let next = sql;
  for (const table of names) {
    if (existingShortAliasForTable(next, table)) continue;
    next = ensureTableHasAlias(next, table).sql;
  }
  return next;
}

/**
 * Ensure `tableIdent alias` appears in the FROM clause. Creates
 * `SELECT * FROM table alias` when needed. If the table is already bare in
 * FROM, adds a short alias (does not duplicate the table).
 */
export function addTableWithAliasToFrom(
  sql: string,
  tableIdent: string,
  alias?: string
): { sql: string; alias: string; added: boolean } {
  const bare = tableIdent.includes('.')
    ? tableIdent.slice(tableIdent.lastIndexOf('.') + 1)
    : tableIdent;
  const existing = existingShortAliasForTable(sql, tableIdent);
  if (existing) return { sql, alias: existing, added: false };

  const aliases = extractTableAliases(sql);
  // Table already in FROM without a short alias — attach one in place.
  if (aliases[bare.toLowerCase()] || aliases[tableIdent.toLowerCase()]) {
    const ensured = ensureTableHasAlias(sql, tableIdent, alias);
    return { sql: ensured.sql, alias: ensured.alias, added: ensured.changed };
  }

  const nextAlias = alias || suggestTableAlias(bare, sql);
  const fragment = `${tableIdent} ${nextAlias}`;
  const trimmed = sql.trim();
  if (!trimmed) {
    return { sql: `SELECT *\nFROM ${fragment}`, alias: nextAlias, added: true };
  }

  const range = findSelectListRange(sql);
  if (!range) {
    return {
      sql: `SELECT *\nFROM ${fragment}\n\n${sql}`,
      alias: nextAlias,
      added: true,
    };
  }

  // Find end of FROM clause item list (before WHERE/GROUP/ORDER/…).
  const afterFromKw = range.fromStart + 4; // "FROM"
  const rest = sql.slice(afterFromKw);
  const stop =
    /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|FOR\s+UPDATE|;)\b/i.exec(
      rest
    );
  const fromClauseEnd = stop ? afterFromKw + stop.index : sql.length;
  const fromBody = sql.slice(afterFromKw, fromClauseEnd).trim();

  const joiner = fromBody ? ', ' : ' ';
  const nextSql =
    sql.slice(0, fromClauseEnd).replace(/\s*$/, '') +
    `${joiner}${fragment}` +
    sql.slice(fromClauseEnd);
  return { sql: nextSql, alias: nextAlias, added: true };
}

/** True when the caret is in a FROM / JOIN table position (not WHERE/SELECT list). */
export function isInFromTablePosition(sqlBeforeCursor: string): boolean {
  const re = /\b(FROM|JOIN)\b/gi;
  let last = -1;
  let lastLen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlBeforeCursor)) !== null) {
    last = m.index;
    lastLen = m[0].length;
  }
  if (last < 0) return false;
  const afterKw = sqlBeforeCursor.slice(last + lastLen);
  // Still in FROM/JOIN list if we haven't hit a following clause keyword.
  return !/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|FOR\s+UPDATE|SELECT|UPDATE|DELETE|INSERT|SET)\b/i.test(
    afterKw
  );
}

/** True when the word at offset is SELECT or FROM (case-insensitive). */
export function isSelectOrFromKeyword(sql: string, offset: number): 'select' | 'from' | null {
  if (offset < 0 || offset > sql.length) return null;
  // Expand to word bounds
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z_]/.test(sql[start - 1]!)) start -= 1;
  while (end < sql.length && /[A-Za-z_]/.test(sql[end]!)) end += 1;
  const word = sql.slice(start, end).toLowerCase();
  if (word === 'select' || word === 'from') return word;
  return null;
}
