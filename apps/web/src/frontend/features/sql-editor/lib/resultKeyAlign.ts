/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Key-align two result grids so matching keys share a row index (friendlier
 * than ORDER BY index compare). Used by SQL Editor side-by-side Compare.
 */

import {
  type CellDiffKind,
  type GridDiffSummary,
  type ResultGridLike,
  type ResultPairDiff,
  emptySummary,
  resultValuesEqual,
} from './resultDataDiff';
import { keyColumnsForGrid } from './resultRowDiff';

/**
 * `unresolved`: the row is on one side only, but the other side's result was
 * cut short (a later page, or truncated at Rows/page), so it may well exist
 * there too. Calling it an add or a delete would be a guess — and a wrong
 * "add" is an INSERT of a row the destination already has.
 */
export type AlignRowOp = 'match' | 'update' | 'insert' | 'delete' | 'unresolved';

export interface KeyAlignedGrids {
  keyNames: string[];
  /** Display rows (gaps are all-null placeholder rows). */
  leftRows: unknown[][];
  rightRows: unknown[][];
  /** True when that side has no real row at this aligned index. */
  leftGap: boolean[];
  rightGap: boolean[];
  rowOps: AlignRowOp[];
  /**
   * Display key label per aligned row (`col=val, …`) — same shape as
   * `ClassifiedRowDiff.keyLabel` so Sync checkboxes can filter migrate ops.
   */
  rowKeyLabels: (string | null)[];
  matchCount: number;
  updateCount: number;
  insertCount: number;
  deleteCount: number;
  /** One-sided rows the other side's truncated result cannot rule out. */
  unresolvedCount: number;
  /** Duplicate key values skipped on left/right (only first kept for align). */
  duplicateKeys: number;
}

function mark(
  summary: GridDiffSummary,
  rowIdx: number,
  colIdx: number,
  kind: CellDiffKind
): void {
  const key = `${rowIdx}:${colIdx}`;
  if (summary.cells.has(key)) return;
  summary.cells.set(key, kind);
  if (kind === 'modified') summary.modified += 1;
  else if (kind === 'missing') summary.missing += 1;
  else summary.extra += 1;
}

function nullRow(width: number): unknown[] {
  return Array.from({ length: width }, () => null);
}

function rowKeyParts(
  row: unknown[],
  keys: ReturnType<typeof keyColumnsForGrid>
): string | null {
  const parts: string[] = [];
  for (const k of keys) {
    if (k.resultIndex < 0) return null;
    const v = row[k.resultIndex];
    if (v === null || v === undefined) return null;
    parts.push(`${k.name.toLowerCase()}=${String(v)}`);
  }
  return parts.join('|');
}

/** Build a human key label matching classifyRowsByKey / migrate progress. */
function keyLabelForRow(
  row: unknown[],
  keys: ReturnType<typeof keyColumnsForGrid>
): string | null {
  const labels: string[] = [];
  for (const k of keys) {
    if (k.resultIndex < 0) return null;
    const v = row[k.resultIndex];
    if (v === null || v === undefined) return null;
    const asText = typeof v === 'bigint' ? v.toString() : String(v);
    labels.push(`${k.name}=${asText}`);
  }
  return labels.join(', ');
}

/**
 * Reorder left/right so shared keys line up. Order: matches & updates (left
 * encounter order), then left-only (delete), then right-only (insert).
 * Returns null when keys are missing from either grid.
 *
 * Duplicate key values: first occurrence wins (later rows skipped); count in
 * `duplicateKeys` so the UI can warn when comparing by a non-unique name.
 */
export function alignResultGridsByKey(
  left: ResultGridLike,
  right: ResultGridLike,
  keyNames: string[],
  opts?: {
    ignoreColumns?: string[];
    /**
     * False when that side holds only part of its result (not on page 1, a
     * next page exists, or rows were truncated). Rows found only on the
     * *other* side are then `unresolved` instead of insert/delete.
     */
    leftComplete?: boolean;
    rightComplete?: boolean;
    /**
     * For a side read in key order and cut short (a compare run): the key of
     * its last row. A row found only on the other side whose key sorts at or
     * before it cannot be further down, so it is classified after all. Only
     * numeric keys are compared: engines sort text by their own collation, and
     * guessing that order would classify a row the other side does have.
     */
    leftWindowEnd?: unknown[];
    rightWindowEnd?: unknown[];
  }
): KeyAlignedGrids | null {
  if (keyNames.length === 0) return null;
  const leftKeys = keyColumnsForGrid(keyNames, left.columns);
  const rightKeys = keyColumnsForGrid(keyNames, right.columns);
  if (
    leftKeys.some((k) => k.resultIndex < 0) ||
    rightKeys.some((k) => k.resultIndex < 0)
  ) {
    return null;
  }

  const ignoreLower = new Set((opts?.ignoreColumns ?? []).map((c) => c.toLowerCase()));
  const keyLower = new Set(keyNames.map((k) => k.toLowerCase()));

  const leftMap = new Map<string, unknown[]>();
  const leftOrder: string[] = [];
  let duplicateKeys = 0;
  for (const row of left.rows) {
    const k = rowKeyParts(row, leftKeys);
    if (k == null) continue;
    if (!leftMap.has(k)) {
      leftMap.set(k, row);
      leftOrder.push(k);
    } else {
      duplicateKeys += 1;
    }
  }
  const rightMap = new Map<string, unknown[]>();
  const rightOrder: string[] = [];
  for (const row of right.rows) {
    const k = rowKeyParts(row, rightKeys);
    if (k == null) continue;
    if (!rightMap.has(k)) {
      rightMap.set(k, row);
      rightOrder.push(k);
    } else {
      duplicateKeys += 1;
    }
  }

  const leftRows: unknown[][] = [];
  const rightRows: unknown[][] = [];
  const leftGap: boolean[] = [];
  const rightGap: boolean[] = [];
  const rowOps: AlignRowOp[] = [];
  const rowKeyLabels: (string | null)[] = [];
  let matchCount = 0;
  let updateCount = 0;
  let insertCount = 0;
  let deleteCount = 0;
  let unresolvedCount = 0;
  const leftComplete = opts?.leftComplete ?? true;
  const rightComplete = opts?.rightComplete ?? true;

  const seenRight = new Set<string>();

  for (const k of leftOrder) {
    const lRow = leftMap.get(k)!;
    const rRow = rightMap.get(k);
    if (rRow) {
      seenRight.add(k);
      const changed = nonKeyDiffer(
        lRow,
        rRow,
        left.columns,
        right.columns,
        keyLower,
        ignoreLower
      );
      leftRows.push(lRow);
      rightRows.push(rRow);
      leftGap.push(false);
      rightGap.push(false);
      rowKeyLabels.push(keyLabelForRow(lRow, leftKeys));
      if (changed) {
        rowOps.push('update');
        updateCount += 1;
      } else {
        rowOps.push('match');
        matchCount += 1;
      }
    } else {
      leftRows.push(lRow);
      rightRows.push(nullRow(right.columns.length));
      leftGap.push(false);
      rightGap.push(true);
      rowKeyLabels.push(keyLabelForRow(lRow, leftKeys));
      if (rightComplete || withinWindow(lRow, leftKeys, opts?.rightWindowEnd)) {
        rowOps.push('delete');
        deleteCount += 1;
      } else {
        rowOps.push('unresolved');
        unresolvedCount += 1;
      }
    }
  }

  for (const k of rightOrder) {
    if (seenRight.has(k) || leftMap.has(k)) continue;
    const rRow = rightMap.get(k)!;
    leftRows.push(nullRow(left.columns.length));
    rightRows.push(rRow);
    leftGap.push(true);
    rightGap.push(false);
    rowKeyLabels.push(keyLabelForRow(rRow, rightKeys));
    if (leftComplete || withinWindow(rRow, rightKeys, opts?.leftWindowEnd)) {
      rowOps.push('insert');
      insertCount += 1;
    } else {
      rowOps.push('unresolved');
      unresolvedCount += 1;
    }
  }

  return {
    keyNames,
    leftRows,
    rightRows,
    leftGap,
    rightGap,
    rowOps,
    rowKeyLabels,
    matchCount,
    updateCount,
    insertCount,
    deleteCount,
    unresolvedCount,
    duplicateKeys,
  };
}

const DIGITS = /^\d+$/;

/** An integer or decimal in text (a bigint arrives as text): `-12`, `3.5`. */
function isNumericText(text: string): boolean {
  const unsigned = text.startsWith('-') ? text.slice(1) : text;
  const [whole, fraction, extra] = unsigned.split('.');
  return extra === undefined && DIGITS.test(whole ?? '') && (fraction === undefined || DIGITS.test(fraction));
}

/** a < b → negative, a > b → positive; null when either is not a number. */
function compareNumeric(a: unknown, b: unknown): number | null {
  const as = typeof a === 'bigint' ? a.toString() : typeof a === 'number' && Number.isFinite(a) ? String(a) : a;
  const bs = typeof b === 'bigint' ? b.toString() : typeof b === 'number' && Number.isFinite(b) ? String(b) : b;
  if (typeof as !== 'string' || typeof bs !== 'string' || !isNumericText(as) || !isNumericText(bs)) return null;
  if (!as.includes('.') && !bs.includes('.')) {
    const x = BigInt(as);
    const y = BigInt(bs);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return Number(as) - Number(bs);
}

/**
 * True when `row`'s key sorts at or before `windowEnd`, compared column by
 * column the way ORDER BY does. False when there is no window end or any key
 * part is not a number: the row stays unresolved.
 */
function withinWindow(
  row: unknown[],
  keys: ReturnType<typeof keyColumnsForGrid>,
  windowEnd: unknown[] | undefined
): boolean {
  if (!windowEnd || windowEnd.length !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const cmp = compareNumeric(row[keys[i]!.resultIndex], windowEnd[i]);
    if (cmp === null) return false;
    if (cmp !== 0) return cmp < 0;
  }
  return true;
}

function nonKeyDiffer(
  leftRow: unknown[],
  rightRow: unknown[],
  leftCols: string[],
  rightCols: string[],
  keyLower: Set<string>,
  ignoreLower: Set<string>
): boolean {
  const rightIdx = new Map<string, number>();
  rightCols.forEach((c, i) => {
    const k = c.toLowerCase();
    if (!rightIdx.has(k)) rightIdx.set(k, i);
  });
  for (let i = 0; i < leftCols.length; i++) {
    const name = leftCols[i]!;
    const lower = name.toLowerCase();
    if (keyLower.has(lower) || ignoreLower.has(lower)) continue;
    const ri = rightIdx.get(lower);
    if (ri === undefined) continue;
    if (!resultValuesEqual(leftRow[i], rightRow[ri])) return true;
  }
  return false;
}

/**
 * Build cell tint maps for a key-aligned pair (display indexes).
 * Insert/delete tint **both** grids at the aligned row so synced scroll shows
 * matching rose/emerald bands (gap side included).
 */
export function compareKeyAlignedGrids(
  left: ResultGridLike,
  right: ResultGridLike,
  aligned: KeyAlignedGrids,
  opts?: { ignoreColumns?: string[] }
): ResultPairDiff {
  const baseSum = emptySummary();
  const otherSum = emptySummary();
  const ignore = new Set((opts?.ignoreColumns ?? []).map((c) => c.toLowerCase()));

  const leftByName = new Map<string, number>();
  left.columns.forEach((c, i) => {
    const k = c.toLowerCase();
    if (!leftByName.has(k)) leftByName.set(k, i);
  });
  const rightByName = new Map<string, number>();
  right.columns.forEach((c, i) => {
    const k = c.toLowerCase();
    if (!rightByName.has(k)) rightByName.set(k, i);
  });

  for (const [k, idx] of leftByName) {
    if (ignore.has(k)) continue;
    if (!rightByName.has(k)) baseSum.missingColumns.push(left.columns[idx]!);
  }
  for (const [k, idx] of rightByName) {
    if (ignore.has(k)) continue;
    if (!leftByName.has(k)) otherSum.extraColumns.push(right.columns[idx]!);
  }
  otherSum.missingColumns = [...baseSum.missingColumns];
  baseSum.extraColumns = [...otherSum.extraColumns];

  const shared: { leftIdx: number; rightIdx: number }[] = [];
  for (const [k, leftIdx] of leftByName) {
    if (ignore.has(k)) continue;
    const rightIdx = rightByName.get(k);
    if (rightIdx === undefined) continue;
    shared.push({ leftIdx, rightIdx });
  }

  // When every column is a key (e.g. compare by ATTRIBUTENAME only), shared
  // still lists those key columns — we tint them for insert/delete so the row
  // lights up even though values "match" the key itself.
  const tintCols =
    shared.length > 0
      ? shared
      : [
          ...[...leftByName.entries()]
            .filter(([k]) => !ignore.has(k))
            .map(([, leftIdx]) => ({
              leftIdx,
              rightIdx: -1,
            })),
        ];

  for (let r = 0; r < aligned.rowOps.length; r++) {
    const op = aligned.rowOps[r]!;
    // Unresolved rows are not a difference anyone has shown; leave them plain.
    if (op === 'match' || op === 'unresolved') continue;

    if (op === 'delete') {
      // Source-only: rose on both panes at this aligned index (gap on dest).
      for (const { leftIdx, rightIdx } of shared) {
        mark(baseSum, r, leftIdx, 'missing');
        mark(otherSum, r, rightIdx, 'missing');
      }
      for (const [k, leftIdx] of leftByName) {
        if (ignore.has(k) || rightByName.has(k)) continue;
        mark(baseSum, r, leftIdx, 'missing');
      }
      for (const [k, rightIdx] of rightByName) {
        if (ignore.has(k) || leftByName.has(k)) continue;
        mark(otherSum, r, rightIdx, 'missing');
      }
      // Key-only grids: still tint the key cell(s).
      if (shared.length === 0) {
        for (const { leftIdx } of tintCols) {
          if (leftIdx >= 0) mark(baseSum, r, leftIdx, 'missing');
        }
        for (const [, rightIdx] of rightByName) {
          mark(otherSum, r, rightIdx, 'missing');
        }
      }
      continue;
    }

    if (op === 'insert') {
      // Dest-only: emerald on both panes (gap on source).
      for (const { leftIdx, rightIdx } of shared) {
        mark(otherSum, r, rightIdx, 'extra');
        mark(baseSum, r, leftIdx, 'extra');
      }
      for (const [k, rightIdx] of rightByName) {
        if (ignore.has(k) || leftByName.has(k)) continue;
        mark(otherSum, r, rightIdx, 'extra');
      }
      for (const [k, leftIdx] of leftByName) {
        if (ignore.has(k) || rightByName.has(k)) continue;
        mark(baseSum, r, leftIdx, 'extra');
      }
      if (shared.length === 0) {
        for (const [, rightIdx] of rightByName) {
          mark(otherSum, r, rightIdx, 'extra');
        }
        for (const [, leftIdx] of leftByName) {
          mark(baseSum, r, leftIdx, 'extra');
        }
      }
      continue;
    }

    // update — tint only cells that actually differ (non-key values)
    const lRow = aligned.leftRows[r]!;
    const rRow = aligned.rightRows[r]!;
    for (const { leftIdx, rightIdx } of shared) {
      const colName = left.columns[leftIdx]!;
      if (ignore.has(colName.toLowerCase())) continue;
      // Key columns themselves are identity — only non-key values drive amber.
      if (aligned.keyNames.some((n) => n.toLowerCase() === colName.toLowerCase())) {
        continue;
      }
      if (resultValuesEqual(lRow[leftIdx], rRow[rightIdx])) continue;
      mark(baseSum, r, leftIdx, 'modified');
      mark(otherSum, r, rightIdx, 'modified');
    }
    for (const [k, rightIdx] of rightByName) {
      if (ignore.has(k) || leftByName.has(k)) continue;
      mark(otherSum, r, rightIdx, 'extra');
    }
    for (const [k, leftIdx] of leftByName) {
      if (ignore.has(k) || rightByName.has(k)) continue;
      mark(baseSum, r, leftIdx, 'missing');
    }
  }

  return {
    baseline: baseSum,
    other: otherSum,
    totalDiffCells: baseSum.cells.size + otherSum.cells.size,
  };
}
