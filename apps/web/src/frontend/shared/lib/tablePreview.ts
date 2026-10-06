/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Queries behind data peek (schema Cmd/Ctrl-click, or FK click in editor results).
 *
 * Everything here goes through the `sql` template engine, so a drill-down value
 * taken from a grid cell is bound, never pasted into the statement — the value
 * may be any string a row happens to contain.
 *
 * No LIMIT is added: `/sql/execute` already wraps a SELECT with the dialect's
 * paging syntax (see sql-page-wrap.ts), which also gives the peek Next/Prev.
 */

import { sqlTag as sql, renderSqlQuery } from './sql-splitter';
import { qualifiedNameParts as tableNameParts, splitSelectItems } from '@foxschema/ui-shared';
import type { ForeignKeyInfo, TableSchema } from './types';

export interface PreviewQuery {
  sql: string;
  params: unknown[];
}

/**
 * Split `schema.table` into identifier parts, honouring quoted segments.
 *
 * One implementation, in @foxschema/sql, so the frontend and the server split a
 * qualified name the same way.
 */
export { tableNameParts };

/** `SELECT * FROM <table>` — the row cap and paging come from the server. */
export function buildTablePreview(tableName: string, dialect: string): PreviewQuery {
  const parts = tableNameParts(tableName);
  const { text, params } = renderSqlQuery(sql`SELECT * FROM ${sql.id(...parts)}`, dialect);
  return { sql: text, params };
}

/**
 * Parent relation for an FK drill: prefer catalog schema so a cross-schema
 * (or cross-database) FK does not resolve a bare name in the wrong place.
 * Already-qualified `referencedTable` values are left alone.
 */
export function fkDrillTableName(fk: Pick<ForeignKeyInfo, 'referencedTable' | 'referencedSchema'>): string {
  const table = (fk.referencedTable ?? '').trim();
  if (!table) return '';
  if (tableNameParts(table).length > 1) return table;
  const schema = (fk.referencedSchema ?? '').trim();
  return schema ? `${schema}.${table}` : table;
}

/**
 * `SELECT * FROM <parent> WHERE <refCol> = <value> …` for one FK.
 * Returns null when the FK has no usable parent columns (the catalog omitted
 * them and no parent PK was resolvable) — the caller should not offer a link.
 */
export function buildForeignKeyDrilldown(
  fk: ForeignKeyInfo,
  values: unknown[],
  dialect: string
): PreviewQuery | null {
  const refCols = fk.referencedColumns ?? [];
  if (refCols.length === 0 || refCols.length !== values.length) return null;
  if (values.some((v) => v === null || v === undefined)) return null;

  const parts = tableNameParts(fkDrillTableName(fk));
  if (parts.length === 0) return null;

  let query = sql`SELECT * FROM ${sql.id(...parts)} WHERE `;
  refCols.forEach((col, i) => {
    const clause = i === 0 ? sql`` : sql` AND `;
    query = sql`${query}${clause}${sql.id(col)} = ${values[i]}`;
  });
  const { text, params } = renderSqlQuery(query, dialect);
  return { sql: text, params };
}

/**
 * `SELECT * FROM <table> WHERE <key> = <value> …` for one known row.
 *
 * The way back from a joined grid to a row of one of its base tables. The
 * result is a single-table SELECT, which is what makes it editable through the
 * ordinary path — the join itself never becomes writable.
 *
 * Values are bound, never interpolated: they come from grid cells and may hold
 * anything the row happens to contain.
 */
export function buildRowLookup(
  tableName: string,
  keys: readonly { column: string; value: unknown }[],
  dialect: string
): PreviewQuery | null {
  if (keys.length === 0) return null;
  const parts = tableNameParts(tableName);
  if (parts.length === 0) return null;
  if (keys.some((k) => k.value === null || k.value === undefined)) return null;

  let query = sql`SELECT * FROM ${sql.id(...parts)} WHERE `;
  keys.forEach((k, i) => {
    const clause = i === 0 ? sql`` : sql` AND `;
    query = sql`${query}${clause}${sql.id(k.column)} = ${k.value}`;
  });
  const { text, params } = renderSqlQuery(query, dialect);
  return { sql: text, params };
}

/**
 * How a foreign key is named, both as a map key and on screen.
 *
 * Spelled in three places before this — twice in Peek Insight and once in the
 * store — and the store's copy joined with `', '` where the others used `','`.
 * The two Peek copies had to stay byte-identical or the count written under one
 * key was never found under the other, showing "not checked" for every key.
 */
export function fkKey(fk: Pick<ForeignKeyInfo, 'name' | 'columns'>): string {
  return fk.name || (fk.columns ?? []).join(',');
}

/**
 * Child rows whose foreign key points at a parent row that is not there.
 *
 * Deliberately not part of the table-insight probe. That probe is catalog-only
 * — `pg_stats`, `TABLE_ROWS`, a page count — and answers in constant time
 * whatever the table's size. Counting orphans is a scan of the child against
 * the parent, so it is offered as something the reader asks for, once, rather
 * than something a 2.4M-row table pays for because a tab was opened.
 *
 * `NOT EXISTS`, not `NOT IN`: a single NULL in the parent's key column makes
 * `NOT IN` return no rows at all, which would report a table with orphans as
 * clean. The two forms are not interchangeable and this is the direction that
 * gets the answer right.
 *
 * Rows with a NULL foreign key are excluded. A NULL FK is an absent
 * relationship, not a broken one — counting it would call every optional
 * reference an orphan.
 *
 * Returns null when the catalog gave no usable column pair, so the caller can
 * leave the affordance off rather than offer a check that cannot run.
 */
function orphanQuery(
  shape: 'count' | 'rows',
  childTable: string,
  fk: ForeignKeyInfo,
  dialect: string
): PreviewQuery | null {
  const childCols = fk.columns ?? [];
  const refCols = fk.referencedColumns ?? [];
  if (childCols.length === 0 || childCols.length !== refCols.length) return null;

  const childParts = tableNameParts(childTable);
  const parentParts = tableNameParts(fkDrillTableName(fk));
  if (childParts.length === 0 || parentParts.length === 0) return null;

  // Aliases keep the two sides apart when a table references itself.
  // No `AS` before a table alias: Oracle rejects it (ORA-00933), while a bare
  // correlation name is valid on every engine this ships against. One spelling
  // beats a dialect branch for a difference this small.
  const select = shape === 'count' ? sql`COUNT(*) AS fox_orphans` : sql`fox_c.*`;
  let query = sql`SELECT ${select} FROM ${sql.id(...childParts)} fox_c WHERE `;
  childCols.forEach((col, i) => {
    const joiner = i === 0 ? sql`` : sql` AND `;
    query = sql`${query}${joiner}fox_c.${sql.id(col)} IS NOT NULL`;
  });
  query = sql`${query} AND NOT EXISTS (SELECT 1 FROM ${sql.id(...parentParts)} fox_p WHERE `;
  refCols.forEach((refCol, i) => {
    const joiner = i === 0 ? sql`` : sql` AND `;
    query = sql`${query}${joiner}fox_p.${sql.id(refCol)} = fox_c.${sql.id(childCols[i]!)}`;
  });
  query = sql`${query})`;

  const { text, params } = renderSqlQuery(query, dialect);
  return { sql: text, params };
}

/** How many child rows point at a parent row that does not exist. */
export function buildOrphanCount(
  childTable: string,
  fk: ForeignKeyInfo,
  dialect: string
): PreviewQuery | null {
  return orphanQuery('count', childTable, fk, dialect);
}

/** The orphan rows themselves — what "Peek orphans" opens. */
export function buildOrphanPeek(
  childTable: string,
  fk: ForeignKeyInfo,
  dialect: string
): PreviewQuery | null {
  return orphanQuery('rows', childTable, fk, dialect);
}

export interface FkColumnLink {
  /** Index into the result's `columns` that carries the child value. */
  columnIndex: number;
  fk: ForeignKeyInfo;
  /** All column indexes of this FK, in the parent's column order. */
  valueIndexes: number[];
}

/**
 * Map result columns to the foreign keys they participate in, so the grid can
 * render those cells as drill-through links. Column names are matched
 * case-insensitively — Oracle and Db2 fold them to upper case.
 */
export function foreignKeyLinksFor(
  table: TableSchema | undefined,
  resultColumns: string[]
): FkColumnLink[] {
  if (!table?.foreignKeys?.length) return [];
  const indexOf = (name: string) =>
    resultColumns.findIndex((c) => c.toLowerCase() === name.toLowerCase());

  const links: FkColumnLink[] = [];
  for (const fk of table.foreignKeys) {
    const cols = fk.columns ?? [];
    if (cols.length === 0) continue;
    const valueIndexes = cols.map(indexOf);
    // Every column of a composite FK must be present, or the WHERE would be
    // built from a partial key and match the wrong parent rows.
    if (valueIndexes.some((i) => i < 0)) continue;
    links.push({ columnIndex: valueIndexes[0]!, fk, valueIndexes });
  }
  return links;
}

/** One foreign key pointing *at* a table, and the child table that holds it. */
export interface InboundForeignKey {
  /** The child table whose rows reference the parent. */
  table: string;
  fk: ForeignKeyInfo;
}

/**
 * Foreign keys pointing at `targetTable`, with the child table that owns each.
 *
 * The mirror of {@link foreignKeyLinksFor}: that answers "which parent does this
 * row point at", this answers "who points at this row". `findInboundForeignKeyTables`
 * in the blueprint lib returns names only, which is enough to warn before a
 * rename but not enough to build a query — a drill needs the FK's columns.
 *
 * Matching is case-insensitive and tolerates a bare name on either side, the
 * same way {@link findCachedTable} does: catalogs disagree about whether they
 * qualify `referencedTable`, and Oracle and Db2 fold names to upper case.
 */
export function inboundForeignKeysFor(
  tables: TableSchema[] | undefined,
  targetTable: string,
  targetSchema?: string
): InboundForeignKey[] {
  if (!tables?.length || !targetTable.trim()) return [];
  const bareOf = (n: string) => {
    const l = n.trim().toLowerCase();
    return l.includes('.') ? l.slice(l.lastIndexOf('.') + 1) : l;
  };
  const wantedBare = bareOf(targetTable);
  const wantedQual = targetTable.trim().toLowerCase();
  const wantedParts = tableNameParts(targetTable);
  const wantedSchema =
    (wantedParts.length > 1 ? wantedParts[wantedParts.length - 2] : targetSchema)
      ?.trim()
      .toLowerCase() ?? '';

  const found: InboundForeignKey[] = [];
  for (const t of tables) {
    // A self-referencing FK is a real relation (manager_id → employees), so it
    // is kept; only the table's own identity is used to label it.
    for (const fk of t.foreignKeys ?? []) {
      const ref = (fk.referencedTable ?? '').trim().toLowerCase();
      if (!ref) continue;
      if (ref !== wantedQual && bareOf(ref) !== wantedBare) continue;
      const refParts = tableNameParts(ref);
      const refSchema =
        (refParts.length > 1 ? refParts[refParts.length - 2] : fk.referencedSchema)
          ?.trim()
          .toLowerCase() ?? '';
      if (wantedSchema && refSchema && wantedSchema !== refSchema) continue;
      if ((fk.columns ?? []).length === 0) continue;
      found.push({ table: t.name, fk });
    }
  }
  return found.sort(
    (a, b) => a.table.localeCompare(b.table) || fkKey(a.fk).localeCompare(fkKey(b.fk))
  );
}

/**
 * `SELECT * FROM <child> WHERE <childCol> = <parentValue> …` — the rows that
 * reference one parent row.
 *
 * `values` are the parent's values for `fk.referencedColumns`, in that order,
 * and the WHERE is built on the child's own `fk.columns`. Getting those two
 * backwards would silently query the wrong side, so the lengths of both lists
 * are checked against `values` rather than assumed equal.
 */
export function buildInboundDrilldown(
  child: InboundForeignKey,
  values: unknown[],
  dialect: string
): PreviewQuery | null {
  const childCols = child.fk.columns ?? [];
  const refCols = child.fk.referencedColumns ?? [];
  if (childCols.length === 0 || childCols.length !== values.length) return null;
  // A catalog that omitted the parent side still names the child columns, but
  // then there is no way to know which parent value belongs to which of them.
  if (refCols.length !== childCols.length) return null;
  if (values.some((v) => v === null || v === undefined)) return null;

  const parts = tableNameParts(child.table);
  if (parts.length === 0) return null;

  let query = sql`SELECT * FROM ${sql.id(...parts)} WHERE `;
  childCols.forEach((col, i) => {
    const clause = i === 0 ? sql`` : sql` AND `;
    query = sql`${query}${clause}${sql.id(col)} = ${values[i]}`;
  });
  const { text, params } = renderSqlQuery(query, dialect);
  return { sql: text, params };
}

/** Resolve a table name (qualified or bare) against the schema cache. */
export function findCachedTable(
  tables: TableSchema[] | undefined,
  name: string
): TableSchema | undefined {
  if (!tables?.length || !name.trim()) return undefined;
  const wanted = name.toLowerCase();
  const bare = wanted.includes('.') ? wanted.slice(wanted.lastIndexOf('.') + 1) : wanted;
  return (
    tables.find((t) => t.name.toLowerCase() === wanted) ??
    tables.find((t) => {
      const n = t.name.toLowerCase();
      return (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n) === bare;
    })
  );
}

/**
 * Resolve a table for query-result row edits. Unlike {@link findCachedTable},
 * a schema-qualified SQL name must not fall back to a bare cache entry from a
 * different schema (that would UPDATE/DELETE the wrong table).
 *
 * Bare SQL names still match bare or qualified cache entries. Qualified SQL
 * names match an exact cache name, or a bare cache entry when `connectionSchema`
 * equals the SQL schema (the usual Postgres/SQL Server cache shape).
 */
export function findCachedTableForEdit(
  tables: TableSchema[] | undefined,
  name: string,
  connectionSchema?: string
): TableSchema | undefined {
  if (!tables?.length || !name.trim()) return undefined;
  const parts = tableNameParts(name);
  if (parts.length === 0) return undefined;
  const wanted = name.toLowerCase();
  const exact = tables.find((t) => t.name.toLowerCase() === wanted);
  if (exact) return exact;

  if (parts.length === 1) {
    const bare = parts[0]!.toLowerCase();
    return tables.find((t) => {
      const n = t.name.toLowerCase();
      return (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n) === bare;
    });
  }

  const sqlSchema = parts[parts.length - 2]!.toLowerCase();
  const sqlBare = parts[parts.length - 1]!.toLowerCase();
  const conn = connectionSchema?.trim().toLowerCase();
  if (!conn || conn !== sqlSchema) return undefined;
  return tables.find((t) => t.name.toLowerCase() === sqlBare);
}

/**
 * Tables referenced in a statement (FROM/JOIN/UPDATE/INTO only).
 * Uses a stricter scan than {@link extractTableAliases} so
 * `SELECT a, b FROM t` is not mistaken for a comma-FROM list.
 */
export function tableNamesFromSql(sql: string): string[] {
  if (!sql.trim()) return [];
  const ident =
    '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*)';
  const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${ident})`, 'gi');
  const names: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const cleaned = stripSqlIdent(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(cleaned);
  }
  return names;
}

function stripSqlIdent(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === '`' && b === '`') || (a === '[' && b === ']')) {
      return s.slice(1, -1).replace(/""/g, '"');
    }
  }
  return s;
}

/**
 * Tables referenced in a statement, matched against the schema cache — used to
 * offer FK links on editor result grids.
 */
export function tablesFromSql(
  sql: string,
  tables: TableSchema[] | undefined
): TableSchema[] {
  if (!sql.trim() || !tables?.length) return [];
  const out: TableSchema[] = [];
  const seen = new Set<string>();
  for (const name of tableNamesFromSql(sql)) {
    const table = findCachedTable(tables, name);
    if (!table) continue;
    const key = table.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(table);
  }
  return out;
}

export type ResultEditTable =
  | { ok: true; table: TableSchema }
  | { ok: false; reason: string };

/**
 * True when the FROM clause lists more than one table (JOIN or comma-FROM),
 * including a self-join of the same table under two aliases.
 */
export function fromClauseIsMultiTable(sql: string): boolean {
  const m = sql.match(
    /\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|\bUNION\b|\bEXCEPT\b|\bINTERSECT\b|\bWINDOW\b|\bFETCH\b|;|$)/i
  );
  if (!m) return false;
  const fromBody = m[1] ?? '';
  if (/\bJOIN\b/i.test(fromBody)) return true;
  // Comma-separated table list: FROM a, b  (SELECT list commas are outside FROM).
  // The repeated group must consume a literal `.` each iteration and `[\w$]`
  // never matches `.`, so the two cannot overlap — there is no ambiguous split
  // for the engine to explore. Measured linear on `,` + `a.`xN up to n=8,000.
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: repeated group is `.`-delimited, no overlap
  return /,\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/.test(
    fromBody
  );
}

/**
 * True when the statement combines result sets (UNION / EXCEPT / INTERSECT).
 * Those grids must stay read-only — rows may not exist in the FROM table.
 */
export function sqlHasSetOperation(sql: string): boolean {
  return /\b(UNION|EXCEPT|INTERSECT)\b/i.test(sql);
}

/**
 * Drop a leading WITH [RECURSIVE] cte_list so callers can inspect the main
 * SELECT. Returns null when the CTE list is malformed.
 */
export function stripLeadingWithClause(sql: string, cteNames?: Set<string>): string | null {
  const t = sql.trim();
  // `\s+` followed by an optional group that starts with the literal word
  // RECURSIVE — the two cannot match the same character, so the `?` group adds
  // no ambiguity. Measured linear on `WITH` + N spaces up to n=8,000.
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: optional group starts with a literal
  const withHead = t.match(/^WITH\s+(RECURSIVE\s+)?/i);
  if (!withHead) return t;
  let i = withHead[0].length;
  const ident = /^(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)/;
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i]!)) i++;
    const name = t.slice(i).match(ident);
    if (!name) return null;
    cteNames?.add(stripSqlIdent(name[0]).toLowerCase());
    i += name[0].length;
    while (i < t.length && /\s/.test(t[i]!)) i++;
    // Optional column list: name (a, b) AS (...)
    if (t[i] === '(') {
      let depth = 0;
      for (; i < t.length; i++) {
        const ch = t[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      while (i < t.length && /\s/.test(t[i]!)) i++;
    }
    if (!/^AS\b/i.test(t.slice(i))) return null;
    i += 2;
    while (i < t.length && /\s/.test(t[i]!)) i++;
    if (t[i] !== '(') return null;
    let depth = 0;
    for (; i < t.length; i++) {
      const ch = t[i]!;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < t.length && /\s/.test(t[i]!)) i++;
    if (t[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  const rest = t.slice(i).trim();
  return /^(SELECT)\b/i.test(rest) ? rest : null;
}

/**
 * Tables referenced by the main query, excluding references to its leading CTEs.
 * CTE bodies are ignored because their source tables do not imply that each
 * outer result row maps directly to one cached base-table row.
 */
export function outerTableNamesFromSql(sql: string): string[] {
  const cteNames = new Set<string>();
  const main = stripLeadingWithClause(sql, cteNames);
  if (!main) return [];
  const candidates = tableNamesFromSql(main);
  const names = candidates.filter(
    (name) => name.includes('.') || !cteNames.has(name.toLowerCase())
  );
  return names;
}

/** Outer SELECT list text (between SELECT and FROM), or null. */
export function outermostSelectList(sql: string): string | null {
  const main = stripLeadingWithClause(sql.trim());
  if (!main) return null;
  const m = main.match(/^\s*SELECT\b([\s\S]*?)\bFROM\b/i);
  return m ? (m[1] ?? '').trim() : null;
}

/**
 * SELECT lists safe for PK-keyed UPDATE/DELETE: `*`, `alias.*`, or simple
 * column refs (optional qualifier). Rejects expressions and renames like
 * `email AS id` that would bind WHERE to the wrong values.
 */
export function selectListSafeForResultEdit(sql: string): boolean {
  const list = outermostSelectList(sql);
  if (list == null || !list) return false;
  // DISTINCT / ALL prefixes are fine; strip them before inspecting items.
  const body = list.replace(/^(DISTINCT|ALL)\s+/i, '').trim();
  if (!body) return false;
  for (const raw of splitSelectItems(body)) {
    const item = raw.trim();
    if (!item) return false;
    if (/^(\*|[A-Za-z_][\w$]*\s*\.\s*\*|"[^"]+"\s*\.\s*\*|`[^`]+`\s*\.\s*\*|\[[^\]]+\]\s*\.\s*\*)$/.test(item)) {
      continue;
    }
    // optional qualifier.column [AS sameName]
    // Anchored at both ends, and each alternative is pinned to a distinct
    // opening delimiter (", `, [, or an identifier start), so at most one
    // branch can match at any position. The optional groups are never
    // repeated. Measured linear on `a`xN + ' AS ' + `b`xN up to n=8,000.
    const col =
      // eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored, alternatives disjoint by delimiter
      /^(?:((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*\.\s*))?("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))(?:\s+(?:AS\s+)?("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*)))?$/i.exec(
        item
      );
    if (!col) return false;
    const base = (col[3] ?? col[4] ?? col[5] ?? col[6] ?? '').toLowerCase();
    const aliasRaw = col[7];
    if (!base) return false;
    if (aliasRaw) {
      const alias = (col[8] ?? col[9] ?? col[10] ?? col[11] ?? '').toLowerCase();
      if (!alias || alias !== base) return false;
    }
  }
  return true;
}

/** True when FROM opens a subquery — result rows are not base-table rows. */
export function fromClauseIsSubquery(sql: string): boolean {
  const main = stripLeadingWithClause(sql.trim()) ?? sql.trim();
  return /\bFROM\s*\(/i.test(main);
}

/**
 * Resolve the single base table for editing a query-result grid.
 * Only plain SELECT / WITH … SELECT against one table is editable — joins,
 * set operations, DML, and code-cell outputs stay read-only.
 *
 * @param connectionSchema Schema of the live connection — required to allow
 *   `schema.table` SQL when the cache stores a bare table name from that schema.
 */
export function singleTableForResultEdit(
  sql: string,
  tables: TableSchema[] | undefined,
  connectionSchema?: string
): ResultEditTable {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { ok: false, reason: 'No statement to edit against.' };
  }
  // Drop a leading block comment so `/* … */ SELECT …` still qualifies.
  const head = trimmed.replace(/^\/\*[\s\S]*?\*\//, '').trim();
  if (!/^(WITH|SELECT)\b/i.test(head)) {
    return { ok: false, reason: 'Only SELECT result grids can be edited.' };
  }
  if (sqlHasSetOperation(trimmed)) {
    return {
      ok: false,
      reason: 'UNION / EXCEPT / INTERSECT results are read-only.',
    };
  }
  if (fromClauseIsSubquery(trimmed)) {
    return { ok: false, reason: 'Subquery FROM results are read-only.' };
  }
  if (fromClauseIsMultiTable(trimmed)) {
    return { ok: false, reason: 'Join / multi-table results are read-only.' };
  }
  if (!selectListSafeForResultEdit(trimmed)) {
    return {
      ok: false,
      reason: 'Computed or renamed columns make this result read-only.',
    };
  }
  const names = outerTableNamesFromSql(trimmed);
  if (names.length === 0) {
    return { ok: false, reason: 'No base table in this query.' };
  }
  if (names.length > 1) {
    return { ok: false, reason: 'Join / multi-table results are read-only.' };
  }
  const table = findCachedTableForEdit(tables, names[0]!, connectionSchema);
  if (!table) {
    return {
      ok: false,
      reason: 'Load the schema for this connection to enable row editing.',
    };
  }
  return { ok: true, table };
}

/**
 * FK links for a result set given the statement SQL + schema tables.
 * First table that claims a column wins when joins share FK column names.
 */
export function foreignKeyLinksForSql(
  sql: string,
  tables: TableSchema[] | undefined,
  resultColumns: string[]
): FkColumnLink[] {
  const matched = tablesFromSql(sql, tables);
  if (matched.length === 0) return [];
  const links: FkColumnLink[] = [];
  const claimed = new Set<number>();
  for (const table of matched) {
    for (const link of foreignKeyLinksFor(table, resultColumns)) {
      if (claimed.has(link.columnIndex)) continue;
      claimed.add(link.columnIndex);
      links.push(link);
    }
  }
  return links;
}

/**
 * Free-text WHERE / ORDER BY for Data Peek. Rejects multi-statement and
 * comment tricks so a filter box can't smuggle a second command.
 */
export function isSafePeekClause(clause: string): boolean {
  const t = clause.trim();
  if (!t) return true;
  if (/[;]/.test(t)) return false;
  if (/--/.test(t)) return false;
  if (/\/\*|\*\//.test(t)) return false;
  return true;
}

export interface PeekFilterClauses {
  /** Predicate only — no leading WHERE. ANDed onto the base query. */
  where?: string;
  /** Sort list only — no leading ORDER BY. */
  orderBy?: string;
}

/**
 * Human label for an FK drill base filter (`ID = 33`), or null when the peek
 * is already an unfiltered table preview (no bound base params).
 */
export function peekBaseFilterLabel(
  title: string,
  tableName: string,
  baseParams: unknown[]
): string | null {
  if (!baseParams.length) return null;
  const prefix = `${tableName} · `;
  if (title.startsWith(prefix)) {
    const rest = title.slice(prefix.length).trim();
    return rest || 'filtered';
  }
  const sep = title.indexOf(' · ');
  if (sep >= 0) {
    const rest = title.slice(sep + 3).trim();
    return rest || 'filtered';
  }
  return 'filtered';
}

/**
 * Layer optional user filters onto a peek base query (`SELECT * FROM …`
 * or a bound FK drill). Params stay those of the base; the filter text is
 * not parameterized (same trust model as typing SQL in the editor).
 */
export function composePeekSql(
  baseSql: string,
  baseParams: unknown[],
  filters: PeekFilterClauses = {}
): PreviewQuery | { error: string } {
  const where = (filters.where ?? '').trim();
  const orderBy = (filters.orderBy ?? '').trim();
  if (!isSafePeekClause(where)) {
    return { error: 'WHERE must be a single predicate (no ; or comments)' };
  }
  if (!isSafePeekClause(orderBy)) {
    return { error: 'ORDER BY must be a sort list (no ; or comments)' };
  }

  let sql = baseSql.trim().replace(/;+\s*$/, '');
  if (where) {
    // Simple detection is enough: peek bases are SELECT * FROM … [WHERE …].
    if (/\bWHERE\b/i.test(sql)) {
      sql = `${sql} AND (${where})`;
    } else {
      sql = `${sql} WHERE (${where})`;
    }
  }
  if (orderBy) {
    if (/\bORDER\s+BY\b/i.test(sql)) {
      return { error: 'Base peek already has ORDER BY — clear it before adding one' };
    }
    sql = `${sql} ORDER BY ${orderBy}`;
  }
  return { sql, params: baseParams };
}
