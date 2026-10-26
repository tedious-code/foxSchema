/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Key-based row classification for data migrate (source → destination).
 * Visual compare uses resultKeyAlign for key-aligned cell tinting.
 */

import { resultValuesEqual, type ResultGridLike } from './resultDataDiff';
import { normalizeResultKey } from '@/features/sql-editor/lib/resultValueKey';
import { DATA_MIGRATE_MAX_OPS } from '@foxschema/shared';
import type { PeekKeyColumn } from './rowDml';

/** The route refuses more than this (`DATA_MIGRATE_MAX_OPS`, shared with the server). */
export const DATA_MIGRATE_ROW_CAP = DATA_MIGRATE_MAX_OPS;

export type RowDiffOp = 'insert' | 'update' | 'delete';

export type { ResultGridLike };

export interface ClassifiedRowDiff {
  op: RowDiffOp;
  /** Composite key string for display / progress. */
  keyLabel: string;
  /** Source row (insert/update) — undefined for delete. */
  sourceRow?: unknown[];
  /** Destination row (update/delete) — undefined for insert. */
  destRow?: unknown[];
}

export interface RowDiffClassification {
  inserts: ClassifiedRowDiff[];
  updates: ClassifiedRowDiff[];
  deletes: ClassifiedRowDiff[];
  skippedNullKeys: number;
  /** Duplicate key values seen in source or dest (unsafe for migrate). */
  duplicateKeys: number;
  /** Total ops before cap. */
  totalOps: number;
  /**
   * One-sided rows left out because the other side's grid is incomplete: a
   * source-only row may be on a later destination page (so not an insert),
   * and a destination-only row on a later source page (so not a delete).
   */
  unresolved: number;
}

function colIndexMap(columns: string[]): Map<string, number> {
  const map = new Map<string, number>();
  columns.forEach((c, i) => {
    const k = c.toLowerCase();
    if (!map.has(k)) map.set(k, i);
  });
  return map;
}

/** Resolve key columns against a grid's column list. */
export function keyColumnsForGrid(
  keyNames: string[],
  columns: string[]
): PeekKeyColumn[] {
  const idx = colIndexMap(columns);
  return keyNames.map((name) => ({
    name,
    resultIndex: idx.get(name.toLowerCase()) ?? -1,
  }));
}

/**
 * Stable map key for composite PK matching. JSON-array encoding avoids
 * collisions when a key value contains `|` / `=` (naive `a=x|b=y` join could
 * treat distinct composite keys as the same row and UPDATE/DELETE the wrong one).
 *
 * Values go through {@link normalizeResultKey}: strings stay exact (so VARCHAR
 * `'1.50'` ≠ `'1.5'`), while number / boolean / object keys still fold driver
 * representation differences. Using cell-comparison normalisation here used to
 * collapse decimal-looking text keys and emit an UPDATE against the wrong row.
 */
function rowKey(
  row: unknown[],
  keys: PeekKeyColumn[]
): { ok: true; key: string; label: string } | { ok: false } {
  const wire: [string, string][] = [];
  const labels: string[] = [];
  for (const k of keys) {
    if (k.resultIndex < 0) return { ok: false };
    const v = row[k.resultIndex];
    // normalizeResultKey returns null for SQL NULL, which is never a usable
    // key — a NULL cannot identify a row to UPDATE or DELETE.
    const asText = normalizeResultKey(v);
    if (asText === null) return { ok: false };
    wire.push([k.name.toLowerCase(), asText]);
    labels.push(`${k.name}=${asText}`);
  }
  return { ok: true, key: JSON.stringify(wire), label: labels.join(', ') };
}

function nonKeyColumnsDiffer(
  sourceRow: unknown[],
  destRow: unknown[],
  sourceCols: string[],
  destCols: string[],
  keyNamesLower: Set<string>,
  ignoreLower: Set<string>
): boolean {
  const destIdx = colIndexMap(destCols);
  for (let i = 0; i < sourceCols.length; i++) {
    const name = sourceCols[i]!;
    const lower = name.toLowerCase();
    if (keyNamesLower.has(lower) || ignoreLower.has(lower)) continue;
    const di = destIdx.get(lower);
    if (di === undefined) continue;
    if (!resultValuesEqual(sourceRow[i], destRow[di])) return true;
  }
  return false;
}

/**
 * Classify rows for migrating **source → dest** by key columns.
 * - insert: key in source only
 * - update: key in both, non-key values differ
 * - delete: key in dest only
 *
 * `ignoreColumns` are excluded from update detection (trigger/audit fields).
 */
export function classifyRowsByKey(opts: {
  source: ResultGridLike;
  dest: ResultGridLike;
  keyNames: string[];
  ignoreColumns?: string[];
  /** False when that grid holds only part of its result; see `unresolved`. */
  sourceComplete?: boolean;
  destComplete?: boolean;
}): RowDiffClassification {
  const {
    source,
    dest,
    keyNames,
    ignoreColumns = [],
    sourceComplete = true,
    destComplete = true,
  } = opts;
  const sourceKeys = keyColumnsForGrid(keyNames, source.columns);
  const destKeys = keyColumnsForGrid(keyNames, dest.columns);
  const keyNamesLower = new Set(keyNames.map((k) => k.toLowerCase()));
  const ignoreLower = new Set(ignoreColumns.map((k) => k.toLowerCase()));

  if (
    sourceKeys.length === 0 ||
    sourceKeys.some((k) => k.resultIndex < 0) ||
    destKeys.some((k) => k.resultIndex < 0)
  ) {
    return {
      inserts: [],
      updates: [],
      deletes: [],
      skippedNullKeys: 0,
      duplicateKeys: 0,
      totalOps: 0,
      unresolved: 0,
    };
  }

  const sourceMap = new Map<string, { row: unknown[]; label: string }>();
  const destMap = new Map<string, { row: unknown[]; label: string }>();
  let skippedNullKeys = 0;
  let duplicateKeys = 0;

  for (const row of source.rows) {
    const k = rowKey(row, sourceKeys);
    if (!k.ok) {
      skippedNullKeys += 1;
      continue;
    }
    if (sourceMap.has(k.key)) {
      duplicateKeys += 1;
      continue;
    }
    sourceMap.set(k.key, { row, label: k.label });
  }
  for (const row of dest.rows) {
    const k = rowKey(row, destKeys);
    if (!k.ok) {
      skippedNullKeys += 1;
      continue;
    }
    if (destMap.has(k.key)) {
      duplicateKeys += 1;
      continue;
    }
    destMap.set(k.key, { row, label: k.label });
  }

  const inserts: ClassifiedRowDiff[] = [];
  const updates: ClassifiedRowDiff[] = [];
  const deletes: ClassifiedRowDiff[] = [];
  let unresolved = 0;

  for (const [key, src] of sourceMap) {
    const dst = destMap.get(key);
    if (!dst) {
      if (destComplete) inserts.push({ op: 'insert', keyLabel: src.label, sourceRow: src.row });
      else unresolved += 1;
      continue;
    }
    if (
      nonKeyColumnsDiffer(
        src.row,
        dst.row,
        source.columns,
        dest.columns,
        keyNamesLower,
        ignoreLower
      )
    ) {
      updates.push({
        op: 'update',
        keyLabel: src.label,
        sourceRow: src.row,
        destRow: dst.row,
      });
    }
  }
  for (const [key, dst] of destMap) {
    if (sourceMap.has(key)) continue;
    if (sourceComplete) deletes.push({ op: 'delete', keyLabel: dst.label, destRow: dst.row });
    else unresolved += 1;
  }

  return {
    inserts,
    updates,
    deletes,
    skippedNullKeys,
    duplicateKeys,
    totalOps: inserts.length + updates.length + deletes.length,
    unresolved,
  };
}

/** Filter by enabled ops and apply the 500-row cap (stable order: insert, update, delete). */
export function selectMigrateOps(
  classification: RowDiffClassification,
  enabled: { insert: boolean; update: boolean; delete: boolean },
  cap = DATA_MIGRATE_ROW_CAP
): { ops: ClassifiedRowDiff[]; truncated: boolean; uncappedCount: number } {
  const all: ClassifiedRowDiff[] = [];
  if (enabled.insert) all.push(...classification.inserts);
  if (enabled.update) all.push(...classification.updates);
  if (enabled.delete) all.push(...classification.deletes);
  const uncappedCount = all.length;
  if (all.length <= cap) return { ops: all, truncated: false, uncappedCount };
  return { ops: all.slice(0, cap), truncated: true, uncappedCount };
}

/** Differing key labels for the currently enabled ops only (Sync column follows Ops). */
export function diffKeyLabelsForOps(
  classification: RowDiffClassification,
  enabled: { insert: boolean; update: boolean; delete: boolean }
): string[] {
  const labels: string[] = [];
  if (enabled.insert) {
    for (const o of classification.inserts) labels.push(o.keyLabel);
  }
  if (enabled.update) {
    for (const o of classification.updates) labels.push(o.keyLabel);
  }
  if (enabled.delete) {
    for (const o of classification.deletes) labels.push(o.keyLabel);
  }
  return labels;
}

/**
 * Keep only ops whose keyLabel is in `selected` (row Sync checkboxes).
 * Cap still applies after filtering.
 */
export function filterOpsByKeyLabels(
  ops: ClassifiedRowDiff[],
  selected: ReadonlySet<string>,
  cap = DATA_MIGRATE_ROW_CAP
): { ops: ClassifiedRowDiff[]; truncated: boolean; uncappedCount: number } {
  const filtered = ops.filter((o) => selected.has(o.keyLabel));
  const uncappedCount = filtered.length;
  if (filtered.length <= cap) return { ops: filtered, truncated: false, uncappedCount };
  return { ops: filtered.slice(0, cap), truncated: true, uncappedCount };
}

/**
 * Data migrate classifies only the rows currently loaded in each grid.
 * If either side is on a later page or still has more pages / truncated
 * rows, "missing from this page" is not "missing from the table" — Delete
 * would destroy real destination rows that exist later in the source.
 */
export function migrateGridsAreComplete(opts: {
  sourcePageIndex: number;
  destPageIndex: number;
  sourceHasMore: boolean;
  destHasMore: boolean;
}): boolean {
  return (
    opts.sourcePageIndex === 0 &&
    opts.destPageIndex === 0 &&
    !opts.sourceHasMore &&
    !opts.destHasMore
  );
}

/**
 * UPDATE/DELETE become `WHERE key = ?` with no LIMIT. Business/name Keys are
 * useful for Sync alignment (and Add-only migrate), but a non-unique column
 * can match many destination rows outside the compare window — including
 * rows the user never saw. Mutating ops therefore require the schema unique
 * key set (PK / non-partial unique index) to be present and selected.
 */
export function migrateKeysSafeForMutatingOps(opts: {
  keyNames: string[];
  /** PK / unique index column names present in the result. */
  uniqueKeyNames: string[];
  editable: boolean;
  ops: Array<{ op: 'insert' | 'update' | 'delete' }>;
}): { ok: true } | { ok: false; title: string; body: string } {
  const mutating = opts.ops.some((o) => o.op === 'update' || o.op === 'delete');
  if (!mutating) return { ok: true };
  if (!opts.editable || opts.uniqueKeyNames.length === 0) {
    return {
      ok: false,
      title: 'Edit/Delete need a unique key in the SELECT',
      body:
        'Name/business Keys are fine for Sync alignment and Add-only migrate, but ' +
        'UPDATE/DELETE on a non-unique column can change every matching row on the destination. ' +
        'Include the primary key (or a non-partial unique index) in the SELECT and check those Keys.',
    };
  }
  const selected = new Set(opts.keyNames.map((k) => k.toLowerCase()));
  const missing = opts.uniqueKeyNames.filter((k) => !selected.has(k.toLowerCase()));
  if (missing.length > 0) {
    return {
      ok: false,
      title: 'Edit/Delete require the unique key columns',
      body:
        `Check Keys for: ${missing.join(', ')}. Unchecking the PK and migrating by a name ` +
        'column can UPDATE/DELETE multiple destination rows.',
    };
  }
  return { ok: true };
}
