/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — what a version's graph node says about a trigger change.
 *
 * The classifier reduces a version's child deltas to the kinds worth putting on
 * a node badge. `change-kinds.test.ts` drives that through columns; these are
 * the trigger cases, plus the boundary that keeps routine containers out of
 * their own child list.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeSchema } from './canonical';
import { changeKindsByOwner, classifyChildChange, type ChildChange } from './change-kinds';
import { diffAgainstIndex, hashObjects, type Digest } from './weave';
import type { TableSchema } from '@foxschema/sql';

const digest: Digest = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

function shipments(triggers: TableSchema['triggers']): TableSchema {
  return {
    name: 'shipments',
    objectType: 'TABLE',
    columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
    indices: [],
    foreignKeys: [],
    primaryKey: { columns: ['id'] },
    triggers,
  };
}

const TRG: NonNullable<TableSchema['triggers']> = [
  { name: 'trg_touch', timing: 'BEFORE', event: 'INSERT', definition: 'BEGIN END' },
];

/** Child deltas between two schemas, in the shape the classifier consumes. */
function childChanges(before: TableSchema[], after: TableSchema[]): ChildChange[] {
  const previous = hashObjects(canonicalizeSchema(before), digest);
  const current = hashObjects(canonicalizeSchema(after), digest);
  const bodyByKey = new Map([...previous, ...current].map((o) => [`${o.key}:${o.hash}`, o.body]));
  return diffAgainstIndex(
    new Map(previous.map((o) => [o.key, o.hash])),
    current
  ).map((change) => ({
    objectKey: change.key,
    operation: change.operation,
    body: change.hash ? bodyByKey.get(`${change.key}:${change.hash}`) : undefined,
    previousBody: change.previousHash
      ? bodyByKey.get(`${change.key}:${change.previousHash}`)
      : undefined,
  }));
}

describe('classifyChildChange — triggers', () => {
  it.each(['ADD', 'MODIFY', 'DELETE'] as const)('reports a %s trigger as a trigger change', (operation) => {
    // A dropped trigger is as much news as an added one; the badge must not
    // depend on which direction it moved.
    expect(
      classifyChildChange({ objectKey: 'trigger:SHIPMENTS.TRG_TOUCH', operation })
    ).toBe('trigger');
  });

  it('does not read a trigger body as a column type', () => {
    // Only columns get the type/column split. A trigger whose body happens to
    // carry a dataType-shaped field must still classify as a trigger.
    expect(
      classifyChildChange({
        objectKey: 'trigger:SHIPMENTS.TRG_TOUCH',
        operation: 'MODIFY',
        previousBody: { dataType: 'varchar(255)' },
        body: { dataType: 'varchar(10)' },
      })
    ).toBe('trigger');
  });
});

describe('changeKindsByOwner — triggers badge their table', () => {
  it('puts an added trigger on the table that owns it', () => {
    const kinds = changeKindsByOwner(childChanges([shipments([])], [shipments(TRG)]));
    expect(kinds.get('SHIPMENTS')).toEqual(['trigger']);
  });

  it('puts a dropped trigger on the table that owned it', () => {
    const kinds = changeKindsByOwner(childChanges([shipments(TRG)], [shipments([])]));
    expect(kinds.get('SHIPMENTS')).toEqual(['trigger']);
  });

  it('shows both kinds when a version adds a column and changes a trigger', () => {
    const before = shipments(TRG);
    const after: TableSchema = {
      ...shipments([{ ...TRG[0]!, event: 'UPDATE' }]),
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'note', type: 'text', nullable: true, primaryKey: false },
      ],
    };
    expect(changeKindsByOwner(childChanges([before], [after])).get('SHIPMENTS')).toEqual([
      'column',
      'trigger',
    ]);
  });

  it('adds no owner for a version that only changed a routine body', () => {
    // Routine containers are not children of anything, so they produce no
    // badge. The node itself still carries the version's status.
    const routine = (definition: string): TableSchema => ({
      name: 'sp_restock',
      objectType: 'PROCEDURE',
      definition,
      columns: [],
      indices: [],
      foreignKeys: [],
    });
    const changes = childChanges([routine('BEGIN END')], [routine('BEGIN DELETE FROM shipments; END')]);
    expect(changes.map((c) => [c.objectKey, c.operation])).toEqual([
      ['procedure:SP_RESTOCK', 'MODIFY'],
    ]);
    expect(changeKindsByOwner(changes).size).toBe(0);
  });
});
