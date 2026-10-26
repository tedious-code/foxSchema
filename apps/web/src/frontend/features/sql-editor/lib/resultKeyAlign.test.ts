/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { alignResultGridsByKey, compareKeyAlignedGrids } from '@/features/sql-editor/lib/resultKeyAlign';
import { cellDiffKey } from '@/features/sql-editor/lib/resultDataDiff';

describe('alignResultGridsByKey', () => {
  it('lines up matching keys and pads inserts/deletes', () => {
    const left = {
      columns: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'Shared'],
        [4, 'OnlyLeft'],
      ],
    };
    const right = {
      columns: ['id', 'name'],
      rows: [
        [2, 'Shared'],
        [1, 'Bob'],
        [3, 'OnlyRight'],
      ],
    };
    const aligned = alignResultGridsByKey(left, right, ['id']);
    expect(aligned).not.toBeNull();
    expect(aligned!.rowOps).toEqual(['update', 'match', 'delete', 'insert']);
    expect(aligned!.rowKeyLabels).toEqual(['id=1', 'id=2', 'id=4', 'id=3']);
    expect(aligned!.leftRows.map((r) => r[0])).toEqual([1, 2, 4, null]);
    expect(aligned!.rightRows.map((r) => r[0])).toEqual([1, 2, null, 3]);
    expect(aligned!.updateCount).toBe(1);
    expect(aligned!.matchCount).toBe(1);
    expect(aligned!.deleteCount).toBe(1);
    expect(aligned!.insertCount).toBe(1);
  });

  it('aligns by name-only key so unequal counts share one row index', () => {
    const left = {
      columns: ['ATTRIBUTENAME'],
      rows: [['Users.Web'], ['Orders.Web'], ['OnlySource'], ['Products.Web']],
    };
    const right = {
      columns: ['ATTRIBUTENAME'],
      rows: [['Orders.Web'], ['Users.Web'], ['OnlyDest'], ['Products.Web']],
    };
    const aligned = alignResultGridsByKey(left, right, ['ATTRIBUTENAME']);
    expect(aligned).not.toBeNull();
    // Both panes same length after pad
    expect(aligned!.leftRows).toHaveLength(aligned!.rightRows.length);
    expect(aligned!.leftRows.length).toBe(5); // 3 match + 1 delete + 1 insert
    expect(aligned!.deleteCount).toBe(1);
    expect(aligned!.insertCount).toBe(1);
    expect(aligned!.matchCount).toBe(3);
    const deleteIdx = aligned!.rowOps.indexOf('delete');
    const insertIdx = aligned!.rowOps.indexOf('insert');
    expect(aligned!.leftRows[deleteIdx]![0]).toBe('OnlySource');
    expect(aligned!.rightGap[deleteIdx]).toBe(true);
    expect(aligned!.rightRows[insertIdx]![0]).toBe('OnlyDest');
    expect(aligned!.leftGap[insertIdx]).toBe(true);
  });

  it('counts duplicate key values when comparing by non-unique name', () => {
    const left = {
      columns: ['name'],
      rows: [['dup'], ['dup'], ['unique']],
    };
    const right = {
      columns: ['name'],
      rows: [['dup'], ['unique']],
    };
    const aligned = alignResultGridsByKey(left, right, ['name']);
    expect(aligned!.duplicateKeys).toBe(1);
    expect(aligned!.matchCount).toBe(2);
  });

  it('ignores trigger columns when deciding update vs match', () => {
    const left = {
      columns: ['id', 'name', 'updatedBy'],
      rows: [[1, 'Alice', 'a']],
    };
    const right = {
      columns: ['id', 'name', 'updatedBy'],
      rows: [[1, 'Alice', 'b']],
    };
    const aligned = alignResultGridsByKey(left, right, ['id'], {
      ignoreColumns: ['updatedBy'],
    });
    expect(aligned!.rowOps).toEqual(['match']);
  });

  it('returns null when a key column is missing', () => {
    const left = { columns: ['id'], rows: [[1]] };
    const right = { columns: ['name'], rows: [['x']] };
    expect(alignResultGridsByKey(left, right, ['id'])).toBeNull();
  });
});

describe('compareKeyAlignedGrids', () => {
  it('tints only differing cells on updates; full rows for insert/delete', () => {
    const left = {
      columns: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'Keep'],
      ],
    };
    const right = {
      columns: ['id', 'name'],
      rows: [
        [1, 'Bob'],
        [3, 'New'],
      ],
    };
    const aligned = alignResultGridsByKey(left, right, ['id'])!;
    const diff = compareKeyAlignedGrids(left, right, aligned);
    // update on row 0 (id=1): name modified
    expect(diff.baseline.cells.get(cellDiffKey(0, 1))).toBe('modified');
    expect(diff.other.cells.get(cellDiffKey(0, 1))).toBe('modified');
    // match id=2 then delete? left has 2, right doesn't → delete; right has 3 → insert
    const deleteIdx = aligned.rowOps.indexOf('delete');
    const insertIdx = aligned.rowOps.indexOf('insert');
    expect(diff.baseline.cells.get(cellDiffKey(deleteIdx, 0))).toBe('missing');
    expect(diff.other.cells.get(cellDiffKey(deleteIdx, 0))).toBe('missing'); // sync highlight
    expect(diff.other.cells.get(cellDiffKey(insertIdx, 0))).toBe('extra');
    expect(diff.baseline.cells.get(cellDiffKey(insertIdx, 0))).toBe('extra'); // sync highlight
  });

  it('tints both grids when comparing by name-only (key column is the only column)', () => {
    const left = {
      columns: ['ATTRIBUTENAME'],
      rows: [['A'], ['B'], ['OnlyLeft']],
    };
    const right = {
      columns: ['ATTRIBUTENAME'],
      rows: [['B'], ['A'], ['OnlyRight']],
    };
    const aligned = alignResultGridsByKey(left, right, ['ATTRIBUTENAME'])!;
    const diff = compareKeyAlignedGrids(left, right, aligned);
    expect(aligned.leftRows).toHaveLength(4);
    const deleteIdx = aligned.rowOps.indexOf('delete');
    const insertIdx = aligned.rowOps.indexOf('insert');
    expect(diff.baseline.cells.get(cellDiffKey(deleteIdx, 0))).toBe('missing');
    expect(diff.other.cells.get(cellDiffKey(deleteIdx, 0))).toBe('missing');
    expect(diff.other.cells.get(cellDiffKey(insertIdx, 0))).toBe('extra');
    expect(diff.baseline.cells.get(cellDiffKey(insertIdx, 0))).toBe('extra');
  });
});

describe('alignResultGridsByKey on a partial grid', () => {
  const cols = ['id', 'v'];

  it('marks one-sided rows unresolved when the other side is cut off, and does not tint them', () => {
    const left = { columns: cols, rows: [[1, 'a'], [2, 'b'], [3, 'c']] };
    const right = { columns: cols, rows: [[1, 'a'], [9, 'z']] };
    const aligned = alignResultGridsByKey(left, right, ['id'], {
      leftComplete: false,
      rightComplete: false,
    })!;
    expect(aligned.rowOps).toEqual(['match', 'unresolved', 'unresolved', 'unresolved']);
    expect(aligned.unresolvedCount).toBe(3);
    expect(aligned.deleteCount + aligned.insertCount).toBe(0);
    const diff = compareKeyAlignedGrids(left, right, aligned);
    expect(diff.totalDiffCells).toBe(0);
  });

  it('only the side facing an incomplete grid becomes unresolved', () => {
    const aligned = alignResultGridsByKey(
      { columns: cols, rows: [[1, 'a'], [2, 'b']] },
      { columns: cols, rows: [[3, 'c']] },
      ['id'],
      { rightComplete: false },
    )!;
    // left-only rows face the incomplete right → unresolved; right-only rows
    // face the complete left → still a real insert.
    expect(aligned.rowOps).toEqual(['unresolved', 'unresolved', 'insert']);
  });
});

describe('alignResultGridsByKey in a compare run (both sides read in key order, cut at a window)', () => {
  const grid = (ids: (number | string)[]) => ({ columns: ['id', 'v'], rows: ids.map((id) => [id, 'x']) });

  it('classifies a one-sided row at or before the cut-short side’s last key, and only past it leaves it unresolved', () => {
    // Target has more rows than the window: it was cut at id 50.
    const aligned = alignResultGridsByKey(grid([10, 20, 40, 60, 70]), grid([10, 30, 40, 50]), ['id'], {
      rightComplete: false,
      rightWindowEnd: [50],
    })!;
    const opOf = (id: number) => aligned.rowOps[aligned.rowKeyLabels.indexOf(`id=${id}`)];
    expect(opOf(20)).toBe('delete'); // 20 < 50: the target would have shown it
    expect(opOf(60)).toBe('unresolved'); // past 50: it may be further down
    expect(opOf(70)).toBe('unresolved');
    expect(opOf(30)).toBe('insert'); // the source is complete
    expect(aligned).toMatchObject({ deleteCount: 1, insertCount: 2, unresolvedCount: 2, matchCount: 2 });
  });

  it('compares numbers by value (2 before 10), including bigints sent as text', () => {
    const aligned = alignResultGridsByKey(
      grid(['2', '9007199254740993']),
      grid(['10']),
      ['id'],
      { rightComplete: false, rightWindowEnd: ['9007199254740992'] }
    )!;
    expect(aligned.rowOps[aligned.rowKeyLabels.indexOf('id=2')]).toBe('delete');
    expect(aligned.rowOps[aligned.rowKeyLabels.indexOf('id=9007199254740993')]).toBe('unresolved');
  });

  it('leaves text keys unresolved: the engine’s collation decides their order, not JavaScript', () => {
    const aligned = alignResultGridsByKey(grid(['a', 'b']), grid(['c']), ['id'], {
      rightComplete: false,
      rightWindowEnd: ['z'],
    })!;
    expect(aligned.unresolvedCount).toBe(2);
    expect(aligned.deleteCount).toBe(0);
  });
});
