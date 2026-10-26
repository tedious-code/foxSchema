/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { AlignRowOp, KeyAlignedGrids } from './resultKeyAlign';
import {
  compareFilterCounts,
  comparePage,
  filteredRowIndexes,
  lastRowKey,
  pageOfNextDifference,
  sliceAligned,
} from './compareView';

const aligned = (ops: AlignRowOp[]): KeyAlignedGrids => ({
  keyNames: ['id'],
  leftRows: ops.map((_, i) => [i]),
  rightRows: ops.map((_, i) => [i]),
  leftGap: ops.map((op) => op === 'insert'),
  rightGap: ops.map((op) => op === 'delete'),
  rowOps: ops,
  rowKeyLabels: ops.map((_, i) => `id=${i}`),
  matchCount: 0,
  updateCount: 0,
  insertCount: 0,
  deleteCount: 0,
  unresolvedCount: 0,
  duplicateKeys: 0,
});

describe('compare view', () => {
  it('counts each filter over the whole window', () => {
    expect(compareFilterCounts(aligned(['match', 'update', 'delete', 'insert', 'unresolved', 'match']))).toEqual({
      all: 6,
      changed: 1,
      source: 1,
      target: 1,
      unresolved: 1,
      matching: 2,
    });
  });

  it('pages the filtered rows, clamping the page into range', () => {
    const rows = filteredRowIndexes(aligned(['match', 'update', 'match', 'update', 'update']), 'changed');
    expect(rows).toEqual([1, 3, 4]);
    expect(comparePage(rows, 0, 2)).toEqual({ rows: [1, 3], page: 0, pageCount: 2 });
    expect(comparePage(rows, 9, 2)).toEqual({ rows: [4], page: 1, pageCount: 2 });
    expect(comparePage([], 0, 100)).toEqual({ rows: [], page: 0, pageCount: 1 });
  });

  it('steps to the page holding the next or previous difference, skipping pages of matches', () => {
    const ops: AlignRowOp[] = ['update', ...Array<AlignRowOp>(9).fill('match'), 'insert', 'match'];
    const a = aligned(ops);
    const rows = filteredRowIndexes(a, 'all');
    expect(pageOfNextDifference(a, rows, 0, 3, 1)).toBe(3); // row 10, page 3
    expect(pageOfNextDifference(a, rows, 3, 3, 1)).toBeNull();
    expect(pageOfNextDifference(a, rows, 3, 3, -1)).toBe(0);
  });

  it('slices the aligned pair to the page, keeping the key labels the Sync boxes use', () => {
    const view = sliceAligned(aligned(['match', 'update', 'delete']), [2, 1]);
    expect(view.rowOps).toEqual(['delete', 'update']);
    expect(view.rowKeyLabels).toEqual(['id=2', 'id=1']);
    expect(view.rightGap).toEqual([true, false]);
  });

  it('reads the last row’s key, case-insensitively, or nothing when a key column is missing', () => {
    const result = { columns: ['ID', 'name'], rows: [[1, 'a'], [7, 'b']] };
    expect(lastRowKey(result, ['id'])).toEqual([7]);
    expect(lastRowKey(result, ['missing'])).toBeUndefined();
    expect(lastRowKey({ columns: ['id'], rows: [] }, ['id'])).toBeUndefined();
  });
});
