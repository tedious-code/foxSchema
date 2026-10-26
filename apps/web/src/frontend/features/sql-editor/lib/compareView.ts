/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The compare view's filters and pages, over a key-aligned pair already in
 * memory. A compare run holds at most two windows of COMPARE_WINDOW_ROWS, so
 * paging is done here, never by asking the databases again.
 */
import type { AlignRowOp, KeyAlignedGrids } from './resultKeyAlign';

/** Rows per side a compare run reads: a fixed window, not a setting. */
export const COMPARE_WINDOW_ROWS = 2000;

export const COMPARE_PAGE_SIZES = [50, 100, 200, 500] as const;
export const DEFAULT_COMPARE_PAGE_SIZE = 100;

/**
 * What a filter keeps, in migrate's words: a source-only row is one migrate
 * adds to the target, a target-only row one it deletes.
 */
export type CompareFilter = 'all' | 'changed' | 'source' | 'target' | 'unresolved' | 'matching';

const KEEPS: Record<CompareFilter, (op: AlignRowOp) => boolean> = {
  all: () => true,
  changed: (op) => op === 'update',
  source: (op) => op === 'delete',
  target: (op) => op === 'insert',
  unresolved: (op) => op === 'unresolved',
  matching: (op) => op === 'match',
};

const isDifference = (op: AlignRowOp): boolean => op === 'update' || op === 'insert' || op === 'delete';

/** How many rows each filter keeps, over the whole window. */
export function compareFilterCounts(aligned: Pick<KeyAlignedGrids, 'rowOps'>): Record<CompareFilter, number> {
  const counts = { all: 0, changed: 0, source: 0, target: 0, unresolved: 0, matching: 0 };
  for (const op of aligned.rowOps) {
    for (const f of Object.keys(KEEPS) as CompareFilter[]) if (KEEPS[f](op)) counts[f] += 1;
  }
  return counts;
}

/** Aligned row indexes the filter keeps, in aligned order. */
export function filteredRowIndexes(aligned: Pick<KeyAlignedGrids, 'rowOps'>, filter: CompareFilter): number[] {
  const keep = KEEPS[filter];
  const out: number[] = [];
  aligned.rowOps.forEach((op, i) => {
    if (keep(op)) out.push(i);
  });
  return out;
}

export interface ComparePage {
  /** Aligned row indexes on this page. */
  rows: number[];
  /** Zero-based, clamped into range. */
  page: number;
  pageCount: number;
}

export function comparePage(rows: readonly number[], page: number, size: number): ComparePage {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pageCount - 1);
  return { rows: rows.slice(p * size, p * size + size), page: p, pageCount };
}

/**
 * The page holding the next (or previous) difference beyond this page, among
 * the filtered rows; null when there is none that way.
 */
export function pageOfNextDifference(
  aligned: Pick<KeyAlignedGrids, 'rowOps'>,
  rows: readonly number[],
  page: number,
  size: number,
  direction: 1 | -1
): number | null {
  if (direction === 1) {
    for (let pos = (page + 1) * size; pos < rows.length; pos++) {
      if (isDifference(aligned.rowOps[rows[pos]!]!)) return Math.floor(pos / size);
    }
    return null;
  }
  for (let pos = page * size - 1; pos >= 0; pos--) {
    if (isDifference(aligned.rowOps[rows[pos]!]!)) return Math.floor(pos / size);
  }
  return null;
}

/**
 * The aligned pair cut down to `rows`, for display: tints, Sync checkboxes and
 * the grids all read it by its own row index. Counts stay the whole window's.
 */
export function sliceAligned(aligned: KeyAlignedGrids, rows: readonly number[]): KeyAlignedGrids {
  const pick = <T,>(xs: T[]) => rows.map((i) => xs[i]!);
  return {
    ...aligned,
    leftRows: pick(aligned.leftRows),
    rightRows: pick(aligned.rightRows),
    leftGap: pick(aligned.leftGap),
    rightGap: pick(aligned.rightGap),
    rowOps: pick(aligned.rowOps),
    rowKeyLabels: pick(aligned.rowKeyLabels),
  };
}

/** The key values of a result's last row, or undefined when a key column is missing. */
export function lastRowKey(
  result: { columns: string[]; rows: unknown[][] },
  keyNames: readonly string[]
): unknown[] | undefined {
  const last = result.rows[result.rows.length - 1];
  if (!last) return undefined;
  const lower = result.columns.map((c) => c.toLowerCase());
  const idx = keyNames.map((k) => lower.indexOf(k.toLowerCase()));
  if (idx.some((i) => i < 0)) return undefined;
  return idx.map((i) => last[i]);
}
