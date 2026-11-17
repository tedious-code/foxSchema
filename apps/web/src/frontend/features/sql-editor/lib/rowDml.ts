/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build bound UPDATE / INSERT / DELETE for Data Peek single-table CRUD.
 * Requires a resolvable primary key (or unique index) present in the result columns.
 */

import { sqlTag as sql, renderSqlQuery, identityInsertFor } from '@/shared/lib/sql-splitter';
import { tableNameParts } from '@/shared/lib/tablePreview';
import { dialectFeatures } from '@/shared/lib/dialect-features';
import type { TableSchema } from '@/shared/lib/types';
import { describeSqlType } from '@/features/sql-editor/lib/peekRowValidation';

export type PeekWriteKind = 'update' | 'insert' | 'delete';

export interface PeekKeyColumn {
  name: string;
  /** Index in the result `columns` array, or -1 if not present in the grid. */
  resultIndex: number;
}

export interface PeekWritePlan {
  kind: PeekWriteKind;
  sql: string;
  params: unknown[];
  /** Human-readable preview (same as sql for bound statements). */
  displaySql: string;
}

export interface PeekEditability {
  editable: boolean;
  reason?: string;
  keyColumns: PeekKeyColumn[];
  /** Column names from the table that appear in the result set. */
  editableColumns: string[];
  /** Identity / autoincrement columns — skipped on INSERT unless user fills them. */
  identityColumns: Set<string>;
}

/**
 * Column types whose grid cells are display-only hex (`0x…`), not round-trippable
 * bind values. Clone/edit would INSERT/UPDATE the ASCII hex string (or a
 * truncated `0xabcd…` prefix) and corrupt the binary.
 *
 * Uses the same catalog classifier as the row form (`describeSqlType`) so the
 * two paths cannot drift.
 */
export function columnTypeIsBinary(type: string | undefined | null): boolean {
  return describeSqlType(String(type ?? '')).kind === 'binary';
}

/**
 * Format a JS value as a SQL literal for inlining in SQL Editor promotion or Copy INSERT.
 * Single quotes are doubled (''), numbers are bare, booleans are TRUE/FALSE, nulls/undefined are NULL.
 */
export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return `'${json.replace(/'/g, "''")}'`;
    } catch {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

function resultIndexMap(columns: string[]): Map<string, number> {
  const map = new Map<string, number>();
  columns.forEach((c, i) => map.set(c.toLowerCase(), i));
  return map;
}

/** First column name that repeats once case is folded, else null. */
export function firstCaseFoldedDuplicate(columns: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const column of columns) {
    const folded = column.toLowerCase();
    if (seen.has(folded)) return column;
    seen.add(folded);
  }
  return null;
}

function isPartialUniqueIndex(index: { filter?: string }): boolean {
  return Boolean(index.filter && index.filter.trim());
}

/**
 * Resolve PK columns for a table that appear in the current result columns.
 * Falls back to a non-partial unique index with non-nullable columns when no PK
 * is declared (partial / filtered unique indexes are not safe row identifiers).
 */
export function resolvePeekKeyColumns(
  table: TableSchema | undefined,
  resultColumns: string[]
): PeekKeyColumn[] {
  if (!table) return [];
  const idx = resultIndexMap(resultColumns);
  const pkNames =
    table.primaryKey?.columns?.length
      ? table.primaryKey.columns
      : table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pkNames.length) {
    return pkNames.map((name) => ({
      name,
      resultIndex: idx.get(name.toLowerCase()) ?? -1,
    }));
  }
  const colByName = new Map(table.columns.map((c) => [c.name.toLowerCase(), c]));
  const unique = table.indices.find((i) => {
    if (!i.unique || i.columns.length === 0 || isPartialUniqueIndex(i)) return false;
    // Nullable unique columns can hold multiple NULLs on most engines — not a
    // safe single-row identity for UPDATE/DELETE.
    return i.columns.every((name) => colByName.get(name.toLowerCase())?.nullable === false);
  });
  if (unique) {
    return unique.columns.map((name) => ({
      name,
      resultIndex: idx.get(name.toLowerCase()) ?? -1,
    }));
  }
  return [];
}

/** Reject null/undefined key values so WHERE never uses IS NULL (multi-row risk). */
export function assertPeekKeyValuesPresent(
  row: unknown[],
  keyColumns: PeekKeyColumn[]
): string | null {
  for (const k of keyColumns) {
    const val = row[k.resultIndex];
    if (val === null || val === undefined) {
      return `Key column "${k.name}" is NULL — cannot safely UPDATE/DELETE a single row.`;
    }
  }
  return null;
}

/**
 * Baseline row for a Data Peek UPDATE.
 * Prefer the snapshot taken when the editor opened — a filter/order refresh can
 * reshuffle `liveRows` so `rowIndex` no longer points at the edited key.
 */
export function originalRowForPeekEdit(
  editor: { originalRow?: unknown[] | null; rowIndex: number | null },
  liveRows: unknown[][]
): unknown[] | undefined {
  if (editor.originalRow) return editor.originalRow;
  if (editor.rowIndex == null) return undefined;
  return liveRows[editor.rowIndex];
}

export function assessPeekEditability(opts: {
  dialect: string;
  table: TableSchema | undefined;
  resultColumns: string[];
}): PeekEditability {
  const { dialect, table, resultColumns } = opts;
  // Was a local Set of dialect names here. It is the same question the other
  // screens ask, so it comes from the one table now — which also means an
  // engine nobody has added is read-only rather than silently editable.
  const rowEditing = dialectFeatures(dialect).rowEditing;
  if (!rowEditing.supported) {
    return {
      editable: false,
      reason: rowEditing.reason,
      keyColumns: [],
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  if (!table) {
    return {
      editable: false,
      reason: 'Load the schema for this connection to enable row editing.',
      keyColumns: [],
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  if (table.objectType !== 'TABLE' && table.objectType !== 'MQT') {
    return {
      editable: false,
      reason: `${table.objectType} objects are not editable in the data grid.`,
      keyColumns: [],
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  // Column lookup folds case, so two result columns that differ only by case
  // (Postgres and Db2 both allow `"ID"` alongside `"id"`) collapse onto one
  // index and the last one wins. A key column could then read its value from
  // the wrong column and the WHERE clause would match a different row — a
  // silent wrong-row UPDATE/DELETE. Refuse instead of guessing.
  const duplicate = firstCaseFoldedDuplicate(resultColumns);
  if (duplicate) {
    return {
      editable: false,
      reason: `Result has two columns named "${duplicate}" (differing only by case) — row editing cannot tell them apart.`,
      keyColumns: [],
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  const keyColumns = resolvePeekKeyColumns(table, resultColumns);
  if (keyColumns.length === 0) {
    return {
      editable: false,
      reason: 'No primary key or non-partial unique index found — cannot safely UPDATE/DELETE.',
      keyColumns: [],
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  if (keyColumns.some((k) => k.resultIndex < 0)) {
    return {
      editable: false,
      reason: 'Primary key columns are missing from this result set.',
      keyColumns,
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  const colSet = new Set(resultColumns.map((c) => c.toLowerCase()));
  const editableColumns = table.columns
    .map((c) => c.name)
    .filter((name) => colSet.has(name.toLowerCase()));
  // `/sql/execute` serializes BYTEA/BLOB as `0x…` hex for the grid (and truncates
  // long values). Feeding that string back through Clone / Edit would store
  // ASCII hex — or a truncated prefix — instead of the original bytes.
  const binaryInResult = table.columns.find(
    (c) => colSet.has(c.name.toLowerCase()) && columnTypeIsBinary(c.type)
  );
  if (binaryInResult) {
    return {
      editable: false,
      reason: `Column "${binaryInResult.name}" is binary — grid cells are display-only hex and cannot safely round-trip on Clone / Edit.`,
      keyColumns,
      editableColumns: [],
      identityColumns: new Set(),
    };
  }
  const identityColumns = new Set(
    table.columns.filter((c) => c.identity || c.identityGeneration).map((c) => c.name)
  );
  return {
    editable: true,
    keyColumns,
    editableColumns,
    identityColumns,
  };
}

function rowToRecord(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    out[c] = row[i] ?? null;
  });
  return out;
}

/** Build UPDATE … SET … WHERE pk = … for one dirty row. */
export function buildPeekUpdate(opts: {
  tableName: string;
  dialect: string;
  columns: string[];
  originalRow: unknown[];
  draftRow: unknown[];
  keyColumns: PeekKeyColumn[];
  /**
   * When set, only these columns may appear in SET (still skips unchanged
   * values and key columns). Used when the edit form lets the user pick which
   * fields to update.
   */
  onlyColumns?: Iterable<string>;
}): PeekWritePlan | { error: string } {
  const { tableName, dialect, columns, originalRow, draftRow, keyColumns, onlyColumns } = opts;
  const parts = tableNameParts(tableName);
  if (!parts.length) return { error: 'Invalid table name.' };
  const keyErr = assertPeekKeyValuesPresent(originalRow, keyColumns);
  if (keyErr) return { error: keyErr };

  const keyLower = new Set(keyColumns.map((k) => k.name.toLowerCase()));
  const onlyLower =
    onlyColumns == null
      ? null
      : new Set([...onlyColumns].map((c) => c.toLowerCase()));
  const setCols: string[] = [];
  const setVals: unknown[] = [];
  for (let i = 0; i < columns.length; i++) {
    const name = columns[i]!;
    if (keyLower.has(name.toLowerCase())) continue;
    if (onlyLower && !onlyLower.has(name.toLowerCase())) continue;
    if (valuesEqual(originalRow[i], draftRow[i])) continue;
    setCols.push(name);
    setVals.push(draftRow[i] ?? null);
  }
  if (setCols.length === 0) {
    return {
      error: onlyLower
        ? 'No selected columns changed — pick columns to update, or discard.'
        : 'No changes to save.',
    };
  }

  let query = sql`UPDATE ${sql.id(...parts)} SET `;
  setCols.forEach((col, i) => {
    const sep = i === 0 ? sql`` : sql`, `;
    query = sql`${query}${sep}${sql.id(col)} = ${setVals[i]}`;
  });
  query = sql`${query} WHERE `;
  keyColumns.forEach((k, i) => {
    const sep = i === 0 ? sql`` : sql` AND `;
    const val = originalRow[k.resultIndex];
    query = sql`${query}${sep}${sql.id(k.name)} = ${val}`;
  });

  const rendered = renderSqlQuery(query, dialect);
  return {
    kind: 'update',
    sql: rendered.text,
    params: rendered.params,
    displaySql: rendered.text,
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

/** Build INSERT for a new or cloned row (object keyed by column name). */
export function buildPeekInsert(opts: {
  tableName: string;
  dialect: string;
  values: Record<string, unknown>;
  /** Skip empty identity columns so the engine can generate them. */
  identityColumns?: Set<string>;
  /**
   * `identityGeneration` of the identity column being written explicitly
   * ('ALWAYS' / 'BY DEFAULT'). Set only when the caller intends to preserve
   * source ids; decides whether the statement needs an overriding clause.
   */
  writeIdentityGeneration?: string;
}): PeekWritePlan | { error: string } {
  const { tableName, dialect, values, identityColumns, writeIdentityGeneration } = opts;
  const parts = tableNameParts(tableName);
  if (!parts.length) return { error: 'Invalid table name.' };

  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (identityColumns?.has(k) && (v === '' || v === null || v === undefined)) continue;
    row[k] = v === '' ? null : v;
  }
  if (Object.keys(row).length === 0) return { error: 'Nothing to insert.' };

  // Postgres refuses an explicit value for a GENERATED ALWAYS identity column
  // unless the statement says so (SQLSTATE 428C9). Db2 is *not* in this group
  // despite the similar error: it has no overriding clause at all (SQL0798N,
  // and SQL0104N if you try one), so its support entry is `unsupported`. The
  // clause comes from a fixed capability table, never from user input.
  const support = writeIdentityGeneration
    ? identityInsertFor(dialect, writeIdentityGeneration)
    : undefined;
  const between = support?.kind === 'overriding' ? support.clause : undefined;

  const rendered = renderSqlQuery(
    sql`INSERT INTO ${sql.id(...parts)} ${sql.values([row], undefined, between)}`,
    dialect
  );

  const cols = Object.keys(row);
  const betweenPart = between ? ` ${between}` : '';
  const renderedTable = renderSqlQuery(sql`${sql.id(...parts)}`, dialect).text;
  const colFragments = cols.map((c) => sql.id(c));
  let colsQuery = sql`(${colFragments[0]}`;
  for (let i = 1; i < colFragments.length; i++) {
    colsQuery = sql`${colsQuery}, ${colFragments[i]}`;
  }
  colsQuery = sql`${colsQuery})`;
  const renderedCols = renderSqlQuery(colsQuery, dialect).text;
  const renderedVals = cols.map((c) => formatSqlLiteral(row[c])).join(', ');
  const displaySql = `INSERT INTO ${renderedTable} ${renderedCols}${betweenPart} VALUES (${renderedVals});`;

  return {
    kind: 'insert',
    sql: rendered.text,
    params: rendered.params,
    displaySql,
  };
}

/** Build DELETE WHERE pk = … for one row. */
export function buildPeekDelete(opts: {
  tableName: string;
  dialect: string;
  columns: string[];
  row: unknown[];
  keyColumns: PeekKeyColumn[];
}): PeekWritePlan | { error: string } {
  const { tableName, dialect, row, keyColumns } = opts;
  const parts = tableNameParts(tableName);
  if (!parts.length) return { error: 'Invalid table name.' };
  if (keyColumns.length === 0) return { error: 'No key columns for DELETE.' };
  const keyErr = assertPeekKeyValuesPresent(row, keyColumns);
  if (keyErr) return { error: keyErr };

  let query = sql`DELETE FROM ${sql.id(...parts)} WHERE `;
  keyColumns.forEach((k, i) => {
    if (i > 0) query = sql`${query} AND `;
    query = sql`${query}${sql.id(k.name)} = ${row[k.resultIndex]}`;
  });

  const rendered = renderSqlQuery(query, dialect);
  return {
    kind: 'delete',
    sql: rendered.text,
    params: rendered.params,
    displaySql: rendered.text,
  };
}

export function peekRowToDraft(
  columns: string[],
  row: unknown[] | null,
  opts?: { clearKeys?: string[]; clearIdentity?: Set<string> }
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    const name = columns[i]!;
    if (opts?.clearKeys?.some((k) => k.toLowerCase() === name.toLowerCase())) {
      draft[name] = '';
      continue;
    }
    if (opts?.clearIdentity?.has(name)) {
      draft[name] = '';
      continue;
    }
    const v = row?.[i];
    draft[name] = v == null ? '' : String(v);
  }
  return draft;
}

export function draftToRowValues(
  columns: string[],
  draft: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const raw = draft[c];
    if (raw === undefined) continue;
    out[c] = raw === '' ? null : raw;
  }
  return out;
}

export function draftToArray(
  columns: string[],
  draft: Record<string, string>,
  original?: unknown[]
): unknown[] {
  return columns.map((c, i) => {
    if (!(c in draft)) return original?.[i] ?? null;
    const raw = draft[c]!;
    if (raw === '') return null;
    const orig = original?.[i];
    if (typeof orig === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      const trimmed = raw.trim();
      const asNumber = Number(trimmed);
      // Integers beyond Number.MAX_SAFE_INTEGER round silently in JS. Keep the
      // digit string so the driver binds the value the user typed (SQLite /
      // MySQL INTEGER/BIGINT columns often arrive as numbers for small values,
      // then get corrupted here if the user edits them past 2^53−1).
      if (/^[+-]?\d+$/.test(trimmed) && !Number.isSafeInteger(asNumber)) {
        return trimmed;
      }
      return asNumber;
    }
    if (typeof orig === 'bigint') {
      try {
        return BigInt(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  });
}

export { rowToRecord };
