/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRowsByKey,
  DATA_MIGRATE_ROW_CAP,
  diffKeyLabelsForOps,
  filterOpsByKeyLabels,
  migrateGridsAreComplete,
  migrateKeysSafeForMutatingOps,
  selectMigrateOps,
} from '@/features/sql-editor/lib/resultRowDiff';

describe('classifyRowsByKey', () => {
  const cols = ['id', 'name', 'city'];

  it('classifies insert, update, and delete by key', () => {
    const source = {
      columns: cols,
      rows: [
        [1, 'Alice', 'Denver'],
        [2, 'Shared', 'Austin'],
        [3, 'New', 'Boston'],
      ],
    };
    const dest = {
      columns: cols,
      rows: [
        [1, 'Bob', 'Denver'],
        [2, 'Shared', 'Austin'],
        [4, 'OnlyDest', 'X'],
      ],
    };
    const c = classifyRowsByKey({ source, dest, keyNames: ['id'] });
    expect(c.inserts).toHaveLength(1);
    expect(c.inserts[0]!.keyLabel).toMatch(/id=3/);
    expect(c.updates).toHaveLength(1);
    expect(c.updates[0]!.keyLabel).toMatch(/id=1/);
    expect(c.deletes).toHaveLength(1);
    expect(c.deletes[0]!.keyLabel).toMatch(/id=4/);
    expect(c.totalOps).toBe(3);
  });

  it('skips null keys', () => {
    const source = { columns: cols, rows: [[null, 'a', 'b']] };
    const dest = { columns: cols, rows: [] };
    const c = classifyRowsByKey({ source, dest, keyNames: ['id'] });
    expect(c.inserts).toHaveLength(0);
    expect(c.skippedNullKeys).toBe(1);
  });

  it('matches composite keys', () => {
    const source = {
      columns: ['a', 'b', 'v'],
      rows: [
        [1, 'x', 10],
        [1, 'y', 20],
      ],
    };
    const dest = {
      columns: ['a', 'b', 'v'],
      rows: [[1, 'x', 11]],
    };
    const c = classifyRowsByKey({ source, dest, keyNames: ['a', 'b'] });
    expect(c.updates).toHaveLength(1);
    expect(c.inserts).toHaveLength(1);
    expect(c.deletes).toHaveLength(0);
  });

  it('does not collide when key values contain delimiter characters', () => {
    const source = {
      columns: ['a', 'b', 'v'],
      rows: [['foo|b=bar', 'baz', 1]],
    };
    const dest = {
      columns: ['a', 'b', 'v'],
      rows: [['foo', 'bar|b=baz', 2]],
    };
    const c = classifyRowsByKey({ source, dest, keyNames: ['a', 'b'] });
    expect(c.updates).toHaveLength(0);
    expect(c.inserts).toHaveLength(1);
    expect(c.deletes).toHaveLength(1);
  });

  it('counts duplicate keys instead of silently keeping the first row', () => {
    const source = {
      columns: ['id', 'name'],
      rows: [
        [1, 'first'],
        [1, 'second'],
      ],
    };
    const dest = { columns: ['id', 'name'], rows: [[1, 'dest']] };
    const c = classifyRowsByKey({ source, dest, keyNames: ['id'] });
    expect(c.duplicateKeys).toBe(1);
    expect(c.updates).toHaveLength(1);
    expect(c.updates[0]!.sourceRow).toEqual([1, 'first']);
  });

  it('does not treat differing trigger columns as updates when ignored', () => {
    const columns = ['id', 'name', 'createdAt', 'updatedBy'];
    const source = {
      columns,
      rows: [[1, 'Alice', '2020-01-01', 'src-user']],
    };
    const dest = {
      columns,
      rows: [[1, 'Alice', '2024-06-01', 'dest-user']],
    };
    const without = classifyRowsByKey({ source, dest, keyNames: ['id'] });
    expect(without.updates).toHaveLength(1);

    const withIgnore = classifyRowsByKey({
      source,
      dest,
      keyNames: ['id'],
      ignoreColumns: ['createdAt', 'updatedBy'],
    });
    expect(withIgnore.updates).toHaveLength(0);
    expect(withIgnore.totalOps).toBe(0);
  });
});


describe('migrateGridsAreComplete', () => {
  it('requires page 1 with no remaining pages on both sides', () => {
    expect(
      migrateGridsAreComplete({
        sourcePageIndex: 0,
        destPageIndex: 0,
        sourceHasMore: false,
        destHasMore: false,
      })
    ).toBe(true);
    // Dest on page 2 while source stays on page 1 → Delete would drop dest keys
    // that still exist later in the source.
    expect(
      migrateGridsAreComplete({
        sourcePageIndex: 0,
        destPageIndex: 1,
        sourceHasMore: false,
        destHasMore: false,
      })
    ).toBe(false);
    expect(
      migrateGridsAreComplete({
        sourcePageIndex: 0,
        destPageIndex: 0,
        sourceHasMore: true,
        destHasMore: false,
      })
    ).toBe(false);
  });
});

describe('migrateKeysSafeForMutatingOps', () => {
  it('allows Add-only migrate with a business/name key', () => {
    expect(
      migrateKeysSafeForMutatingOps({
        keyNames: ['ATTRIBUTENAME'],
        uniqueKeyNames: [],
        editable: false,
        ops: [{ op: 'insert' }],
      })
    ).toEqual({ ok: true });
  });

  it('blocks Edit/Delete when the SELECT has no unique key', () => {
    const blocked = migrateKeysSafeForMutatingOps({
      keyNames: ['ATTRIBUTENAME'],
      uniqueKeyNames: [],
      editable: false,
      ops: [{ op: 'update' }, { op: 'delete' }],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.title).toMatch(/unique key/i);
    }
  });

  it('blocks Edit/Delete when the unique key is unchecked', () => {
    const blocked = migrateKeysSafeForMutatingOps({
      keyNames: ['ATTRIBUTENAME'],
      uniqueKeyNames: ['ID'],
      editable: true,
      ops: [{ op: 'delete' }],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.body).toMatch(/ID/);
    }
  });

  it('allows Edit/Delete when the unique key columns are selected', () => {
    expect(
      migrateKeysSafeForMutatingOps({
        keyNames: ['ID', 'ATTRIBUTENAME'],
        uniqueKeyNames: ['ID'],
        editable: true,
        ops: [{ op: 'update' }],
      })
    ).toEqual({ ok: true });
  });
});

describe('selectMigrateOps', () => {
  it('respects checkboxes and caps at the shared limit (2,000)', () => {
    const inserts = Array.from({ length: 1200 }, (_, i) => ({
      op: 'insert' as const,
      keyLabel: `id=${i}`,
      sourceRow: [i],
    }));
    const updates = Array.from({ length: 900 }, (_, i) => ({
      op: 'update' as const,
      keyLabel: `id=${i + 5000}`,
      sourceRow: [i],
      destRow: [i],
    }));
    const classification = {
      inserts,
      updates,
      deletes: [],
      skippedNullKeys: 0,
      duplicateKeys: 0,
      totalOps: 2100,
      unresolved: 0,
    };
    const selected = selectMigrateOps(
      classification,
      { insert: true, update: true, delete: false },
      DATA_MIGRATE_ROW_CAP
    );
    expect(DATA_MIGRATE_ROW_CAP).toBe(2000);
    expect(selected.uncappedCount).toBe(2100);
    expect(selected.truncated).toBe(true);
    expect(selected.ops).toHaveLength(DATA_MIGRATE_ROW_CAP);
    expect(selected.ops.every((o) => o.op === 'insert' || o.op === 'update')).toBe(
      true
    );
  });
});

describe('filterOpsByKeyLabels / diffKeyLabelsForOps', () => {
  const ALL = { insert: true, update: true, delete: true };
  const classification = classifyRowsByKey({
    source: {
      columns: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'Shared'],
        [3, 'New'],
      ],
    },
    dest: {
      columns: ['id', 'name'],
      rows: [
        [1, 'Bob'],
        [2, 'Shared'],
        [4, 'OnlyDest'],
      ],
    },
    keyNames: ['id'],
  });

  it('lists every differing key label', () => {
    expect(diffKeyLabelsForOps(classification, ALL)).toHaveLength(3);
  });

  it('defaults to all selected; uncheck drops from migrate plans', () => {
    const byOp = selectMigrateOps(classification, {
      insert: true,
      update: true,
      delete: true,
    });
    expect(filterOpsByKeyLabels(byOp.ops, new Set(diffKeyLabelsForOps(classification, ALL))).uncappedCount).toBe(3);
    const updateLabel = classification.updates[0]!.keyLabel;
    const without = filterOpsByKeyLabels(
      byOp.ops,
      new Set(diffKeyLabelsForOps(classification, ALL).filter((l) => l !== updateLabel))
    );
    expect(without.uncappedCount).toBe(2);
  });

  it('Sync all restores every differing label', () => {
    const byOp = selectMigrateOps(classification, {
      insert: true,
      update: true,
      delete: true,
    });
    expect(filterOpsByKeyLabels(byOp.ops, new Set()).uncappedCount).toBe(0);
    expect(
      filterOpsByKeyLabels(byOp.ops, new Set(diffKeyLabelsForOps(classification, ALL))).uncappedCount
    ).toBe(3);
  });

  it('diffKeyLabelsForOps follows enabled Add/Edit/Delete', () => {
    expect(diffKeyLabelsForOps(classification, { insert: false, update: false, delete: false })).toEqual(
      []
    );
    expect(diffKeyLabelsForOps(classification, { insert: true, update: false, delete: false })).toEqual(
      classification.inserts.map((o) => o.keyLabel)
    );
    expect(
      diffKeyLabelsForOps(classification, { insert: true, update: true, delete: true }).sort()
    ).toEqual([...classification.inserts, ...classification.updates, ...classification.deletes]
        .map((o) => o.keyLabel)
        .sort());
  });
});

describe('classifyRowsByKey on a partial grid', () => {
  // The screenshot that found this: two customers tables, 200 rows per page.
  // The source is missing six rows, so its page 1 reaches id 206 while the
  // destination's stops at 200 — and ids 201..206 showed as "6 add", an
  // INSERT of rows the destination already has.
  const cols = ['id', 'name'];
  const rows = (ids: number[]) => ids.map((id) => [id, `c${id}`]);

  it('does not offer an insert for a row the incomplete destination may hold further down', () => {
    const result = classifyRowsByKey({
      source: { columns: cols, rows: rows([1, 2, 3, 4]) },
      dest: { columns: cols, rows: rows([1, 2]) },
      keyNames: ['id'],
      destComplete: false,
    });
    expect(result.inserts).toEqual([]);
    expect(result.unresolved).toBe(2);
  });

  it('does not offer a delete for a row the incomplete source may hold further down', () => {
    const result = classifyRowsByKey({
      source: { columns: cols, rows: rows([1]) },
      dest: { columns: cols, rows: rows([1, 2, 3]) },
      keyNames: ['id'],
      sourceComplete: false,
    });
    expect(result.deletes).toEqual([]);
    expect(result.unresolved).toBe(2);
  });

  it('still classifies edits, since both copies are loaded', () => {
    const result = classifyRowsByKey({
      source: { columns: cols, rows: [[1, 'new']] },
      dest: { columns: cols, rows: [[1, 'old'], [2, 'x']] },
      keyNames: ['id'],
      sourceComplete: false,
      destComplete: false,
    });
    expect(result.updates.map((u) => u.keyLabel)).toEqual(['id=1']);
    expect(result.unresolved).toBe(1);
  });

  it('classifies everything when both grids are complete', () => {
    const result = classifyRowsByKey({
      source: { columns: cols, rows: rows([1, 2]) },
      dest: { columns: cols, rows: rows([2, 3]) },
      keyNames: ['id'],
    });
    expect(result.inserts).toHaveLength(1);
    expect(result.deletes).toHaveLength(1);
    expect(result.unresolved).toBe(0);
  });
});
