/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data peek's pure operations. None of this needed a store to test — it just
 * lived inside one, which is why the limit clamp and the run-generation guard
 * had no coverage despite both existing to stop a specific bug.
 */
import { describe, expect, it } from 'vitest';
import {
  DATA_PEEK_ROWS,
  MAX_DATA_PEEK_LIMIT,
  clampDataPeekLimit,
  createDataPeekEntry,
  dataPeekDrillKey,
  isCurrentDataPeekRun,
  moveDataPeekEntry,
  newDataPeekEntryId,
  nextDataPeekRunGeneration,
  patchDataPeekEntry,
  removeDataPeekSubtree,
  type DataPeekEntry,
} from './sqlEditorDataPeek';

function entry(id: string, extra: Partial<DataPeekEntry> = {}): DataPeekEntry {
  return {
    id,
    title: id,
    tableName: id,
    baseSql: 'SELECT 1',
    baseParams: [],
    whereClause: '',
    orderByClause: '',
    limit: DATA_PEEK_ROWS,
    pageIndex: 0,
    sql: 'SELECT 1',
    params: [],
    status: 'ready',
    ...extra,
  };
}

describe('clampDataPeekLimit', () => {
  /**
   * The limit box is free text, so this is the function that decides what
   * "", "abc", "-5", "0", "2.7" and "999999" mean. It had no test.
   */
  it('keeps a sensible value unchanged', () => {
    expect(clampDataPeekLimit(50)).toBe(50);
    expect(clampDataPeekLimit(1)).toBe(1);
    expect(clampDataPeekLimit(MAX_DATA_PEEK_LIMIT)).toBe(MAX_DATA_PEEK_LIMIT);
  });

  it('floors at one row rather than zero', () => {
    // A zero limit renders an empty grid, which reads as "no rows" — a wrong
    // answer about the data — rather than as a bad limit.
    expect(clampDataPeekLimit(0)).toBe(1);
    expect(clampDataPeekLimit(-10)).toBe(1);
  });

  it('caps at the maximum so one panel cannot lock the tab', () => {
    expect(clampDataPeekLimit(50_000)).toBe(MAX_DATA_PEEK_LIMIT);
  });

  it('truncates fractions rather than rounding up past the cap', () => {
    expect(clampDataPeekLimit(2.7)).toBe(2);
    expect(clampDataPeekLimit(MAX_DATA_PEEK_LIMIT + 0.9)).toBe(MAX_DATA_PEEK_LIMIT);
  });

  it('treats non-numbers as one row', () => {
    expect(clampDataPeekLimit(Number.NaN)).toBe(1);
    expect(clampDataPeekLimit(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampDataPeekLimit(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe('createDataPeekEntry', () => {
  it('starts loading, unfiltered, on page zero at the default size', () => {
    const e = createDataPeekEntry({
      title: 'public.users',
      tableName: 'public.users',
      baseSql: 'SELECT * FROM users',
      baseParams: [],
      sql: 'SELECT * FROM users LIMIT 50',
      params: [],
    });
    expect(e).toMatchObject({
      title: 'public.users',
      tableName: 'public.users',
      whereClause: '',
      orderByClause: '',
      limit: DATA_PEEK_ROWS,
      pageIndex: 0,
      status: 'loading',
    });
  });

  it('omits parentId and drillKey for a root peek rather than setting them undefined', () => {
    // `removeDataPeekSubtree` walks `parentId`, so a key that exists-but-is-
    // undefined is a different thing from an absent one when entries are
    // serialised or compared.
    const e = createDataPeekEntry({
      title: 't',
      tableName: 't',
      baseSql: 'SELECT 1',
      baseParams: [],
      sql: 'SELECT 1',
      params: [],
    });
    expect('parentId' in e).toBe(false);
    expect('drillKey' in e).toBe(false);
  });

  it('carries parentId and drillKey for a drill', () => {
    const e = createDataPeekEntry({
      title: 'orders · id = 7',
      tableName: 'orders',
      baseSql: 'SELECT 1',
      baseParams: [],
      sql: 'SELECT 1',
      params: [],
      parentId: 'root',
      drillKey: 'root|orders|id',
    });
    expect(e.parentId).toBe('root');
    expect(e.drillKey).toBe('root|orders|id');
  });

  it('gives each panel its own id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newDataPeekEntryId()));
    expect(ids.size).toBe(50);
  });
});

describe('dataPeekDrillKey', () => {
  it('is stable for the same parent, table and columns', () => {
    expect(dataPeekDrillKey('p1', 'orders', ['customer_id'])).toBe(
      dataPeekDrillKey('p1', 'orders', ['customer_id'])
    );
  });

  it('separates different FK columns from the same parent', () => {
    // Re-clicking one FK replaces its panel; a different FK opens a sibling.
    expect(dataPeekDrillKey('p1', 'users', ['created_by'])).not.toBe(
      dataPeekDrillKey('p1', 'users', ['updated_by'])
    );
  });

  it('separates the same FK reached from different parents', () => {
    expect(dataPeekDrillKey('p1', 'users', ['id'])).not.toBe(
      dataPeekDrillKey('p2', 'users', ['id'])
    );
  });

  it('treats missing columns as none rather than throwing', () => {
    expect(dataPeekDrillKey('p1', 'users', undefined)).toBe('p1|users|');
  });
});

describe('patchDataPeekEntry', () => {
  const entries = [entry('a'), entry('b'), entry('c')];

  it('replaces only the matching entry', () => {
    const next = patchDataPeekEntry(entries, 'b', { status: 'error', error: 'nope' });
    expect(next.map((e) => e.status)).toEqual(['ready', 'error', 'ready']);
    expect(next[1]!.error).toBe('nope');
  });

  it('keeps the fields the patch does not mention', () => {
    const next = patchDataPeekEntry(entries, 'b', { pageIndex: 3 });
    expect(next[1]).toMatchObject({ id: 'b', title: 'b', baseSql: 'SELECT 1', pageIndex: 3 });
  });

  it('derives the patch from the current entry when given a function', () => {
    const next = patchDataPeekEntry([entry('a', { runGeneration: 4 })], 'a', (e) => ({
      runGeneration: nextDataPeekRunGeneration(e),
    }));
    expect(next[0]!.runGeneration).toBe(5);
  });

  it('is a no-op for an id that is not there', () => {
    expect(patchDataPeekEntry(entries, 'zz', { status: 'error' })).toEqual(entries);
  });

  it('does not mutate the input', () => {
    const before = structuredClone(entries);
    patchDataPeekEntry(entries, 'a', { status: 'error' });
    expect(entries).toEqual(before);
  });
});

describe('run generations', () => {
  /**
   * The bug this guards: clear a WHERE while the filtered query is still
   * running, and the late response lands on the now-unfiltered panel, showing
   * filtered rows under no filter.
   */
  it('starts from zero and increases', () => {
    expect(nextDataPeekRunGeneration(entry('a'))).toBe(1);
    expect(nextDataPeekRunGeneration(entry('a', { runGeneration: 7 }))).toBe(8);
  });

  it('accepts a result whose generation still matches', () => {
    expect(isCurrentDataPeekRun(entry('a', { runGeneration: 3 }), 3)).toBe(true);
  });

  it('rejects a result from a superseded run', () => {
    expect(isCurrentDataPeekRun(entry('a', { runGeneration: 4 }), 3)).toBe(false);
  });

  it('treats an entry that has never run as generation zero', () => {
    expect(isCurrentDataPeekRun(entry('a'), 0)).toBe(true);
    expect(isCurrentDataPeekRun(entry('a'), undefined)).toBe(true);
    expect(isCurrentDataPeekRun(entry('a'), 1)).toBe(false);
  });

  it('rejects a result for a panel that has since been closed', () => {
    expect(isCurrentDataPeekRun(undefined, 0)).toBe(false);
  });
});

describe('removeDataPeekSubtree', () => {
  it('drops the entry and every drill beneath it, at any depth', () => {
    const entries = [
      entry('root'),
      entry('a', { parentId: 'root' }),
      entry('b', { parentId: 'a' }),
      entry('c', { parentId: 'b' }),
      entry('sibling'),
    ];
    expect(removeDataPeekSubtree(entries, 'a').map((e) => e.id)).toEqual(['root', 'sibling']);
  });

  it('leaves other branches alone', () => {
    const entries = [
      entry('root'),
      entry('left', { parentId: 'root' }),
      entry('right', { parentId: 'root' }),
      entry('right-child', { parentId: 'right' }),
    ];
    expect(removeDataPeekSubtree(entries, 'left').map((e) => e.id)).toEqual([
      'root',
      'right',
      'right-child',
    ]);
  });

  it('removes everything when given the root', () => {
    const entries = [entry('root'), entry('a', { parentId: 'root' })];
    expect(removeDataPeekSubtree(entries, 'root')).toEqual([]);
  });

  it('terminates on a parent cycle instead of looping forever', () => {
    // Not reachable through the UI, but the walk is a fixed-point loop and a
    // cycle would hang the tab rather than fail visibly.
    const entries = [entry('a', { parentId: 'b' }), entry('b', { parentId: 'a' })];
    expect(removeDataPeekSubtree(entries, 'a')).toEqual([]);
  });
});

describe('moveDataPeekEntry', () => {
  const entries = [entry('a'), entry('b'), entry('c')];
  const ids = (list: DataPeekEntry[]) => list.map((e) => e.id);

  it('moves an entry forward', () => {
    expect(ids(moveDataPeekEntry(entries, 0, 2))).toEqual(['b', 'c', 'a']);
  });

  it('moves an entry backward', () => {
    expect(ids(moveDataPeekEntry(entries, 2, 0))).toEqual(['c', 'a', 'b']);
  });

  it('returns the same array reference for a no-op, so callers can skip the update', () => {
    // `reorderDataPeekEntries` compares by identity to avoid a pointless render.
    expect(moveDataPeekEntry(entries, 1, 1)).toBe(entries);
  });

  it('returns the same array reference for an out-of-range index', () => {
    expect(moveDataPeekEntry(entries, -1, 0)).toBe(entries);
    expect(moveDataPeekEntry(entries, 0, 9)).toBe(entries);
    expect(moveDataPeekEntry(entries, 9, 0)).toBe(entries);
  });

  it('does not mutate the input', () => {
    const before = ids(entries);
    moveDataPeekEntry(entries, 0, 2);
    expect(ids(entries)).toEqual(before);
  });
});
