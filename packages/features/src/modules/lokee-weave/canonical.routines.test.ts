/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — canonicalisation and change classification for the object
 * kinds that are not tables: triggers, procedures and functions.
 *
 * `weave.test.ts` drives the same machinery through tables and columns. These
 * cases pin the parts that only routines and triggers reach: the routine
 * container body (parameters, function kind, definition), the child-trigger
 * address, and which of ADD / MODIFY / DELETE each edit produces.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeObject, canonicalizeSchema } from './canonical';
import { diffAgainstIndex, hashObjects, weave, type Digest, type LatestIndex } from './weave';
import type { TableSchema } from '@foxschema/sql';

/** Content-sensitive and deterministic; real callers pass sha256. */
const digest: Digest = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

function fn(over: Partial<TableSchema> = {}): TableSchema {
  return {
    name: 'fn_ship_cost',
    objectType: 'FUNCTION',
    definition: 'CREATE FUNCTION fn_ship_cost(p_weight decimal(8,2)) RETURNS decimal(8,2)\n  RETURN p_weight * 2;',
    columns: [],
    indices: [],
    foreignKeys: [],
    parameters: [{ name: 'p_weight', type: 'decimal(8,2)', mode: 'IN' }],
    functionKind: 'scalar',
    ...over,
  };
}

function proc(over: Partial<TableSchema> = {}): TableSchema {
  return {
    name: 'sp_restock',
    objectType: 'PROCEDURE',
    definition: 'CREATE PROCEDURE sp_restock(IN p_qty INT)\nBEGIN\n  UPDATE shipments SET qty = p_qty;\nEND',
    columns: [],
    indices: [],
    foreignKeys: [],
    parameters: [{ name: 'p_qty', type: 'int', mode: 'IN' }],
    ...over,
  };
}

/** A table that owns one trigger — the shape every dialect reports. */
function shipments(over: { trigger?: TableSchema['triggers']; columns?: TableSchema['columns'] } = {}): TableSchema {
  return {
    name: 'shipments',
    objectType: 'TABLE',
    columns: over.columns ?? [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'qty', type: 'integer', nullable: true, primaryKey: false },
    ],
    indices: [],
    foreignKeys: [],
    primaryKey: { columns: ['id'] },
    triggers:
      over.trigger ??
      [
        {
          name: 'trg_shipments_touch',
          timing: 'BEFORE',
          event: 'INSERT',
          definition: 'BEGIN\n  SET NEW.qty = NEW.qty;\nEND',
        },
      ],
  };
}

/** Latest-state index for a schema, as the store would hold it. */
function indexOf(tables: TableSchema[]): LatestIndex {
  return new Map(hashObjects(canonicalizeSchema(tables), digest).map((o) => [o.key, o.hash]));
}

/** Keys and operations of the delta between two schemas. */
function delta(before: TableSchema[], after: TableSchema[]): Array<[string, string]> {
  const changes = diffAgainstIndex(indexOf(before), hashObjects(canonicalizeSchema(after), digest));
  return changes.map((c) => [c.key, c.operation]);
}

describe('canonicalizeObject — routine containers', () => {
  it('gives a function its own address and keeps its signature in the body', () => {
    // The parameter list is part of what a function *is*: a revert has to be
    // able to name the overload it drops.
    const objects = canonicalizeObject(fn());
    expect(objects).toHaveLength(1);
    const object = objects[0]!;
    expect(object.key).toBe('function:FN_SHIP_COST');
    expect(object.type).toBe('function');
    expect(object.body).toMatchObject({
      name: 'fn_ship_cost',
      objectType: 'FUNCTION',
      functionKind: 'scalar',
      parameters: [{ name: 'p_weight', type: 'decimal(8,2)', mode: 'IN' }],
    });
  });

  it('keeps the native-cased name while the address is folded', () => {
    const object = canonicalizeObject(fn({ name: 'Fn_Ship_Cost' }))[0]!;
    expect(object.key).toBe('function:FN_SHIP_COST');
    expect(object.body.name).toBe('Fn_Ship_Cost');
  });

  it('gives a procedure its own address and no function kind', () => {
    const object = canonicalizeObject(proc())[0]!;
    expect(object.key).toBe('procedure:SP_RESTOCK');
    expect(object.type).toBe('procedure');
    expect(object.body).toMatchObject({
      name: 'sp_restock',
      parameters: [{ name: 'p_qty', type: 'int', mode: 'IN' }],
      functionKind: null,
    });
  });

  it('keeps the raw routine text out of the hashed body but available to the inspector', () => {
    const object = canonicalizeObject(proc())[0]!;
    // The body is whitespace-collapsed and semicolon-stripped; sourceText is not.
    expect(object.body.definition).toBe(
      'CREATE PROCEDURE sp_restock(IN p_qty INT) BEGIN UPDATE shipments SET qty = p_qty; END'
    );
    expect(object.sourceText).toContain('\n');
  });

  it('addresses a table-owned trigger under its table, with timing and event', () => {
    const trigger = canonicalizeObject(shipments()).find((o) => o.type === 'trigger')!;
    expect(trigger.key).toBe('trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH');
    expect(trigger.body).toMatchObject({
      name: 'trg_shipments_touch',
      table: 'shipments',
      timing: 'BEFORE',
      event: 'INSERT',
    });
  });

  it('addresses a standalone trigger container by its own name', () => {
    // Db2 reports a trigger as a container when its table lives outside the
    // compared schema.
    const object = canonicalizeObject({
      name: 'trg_orphan',
      objectType: 'TRIGGER',
      definition: 'BEGIN END',
      columns: [],
      indices: [],
      foreignKeys: [],
    })[0]!;
    expect(object.key).toBe('trigger:TRG_ORPHAN');
    expect(object.type).toBe('trigger');
  });

  it('keeps a table container free of the triggers it owns', () => {
    // A trigger edit must not rewrite the table's hash, or every delta would
    // carry both objects.
    const container = canonicalizeObject(shipments()).find((o) => o.type === 'table')!;
    expect(Object.keys(container.body)).not.toContain('triggers');
  });
});

describe('routine and trigger deltas — create, alter, drop', () => {
  it('reports a first capture of each kind as ADD, typed', () => {
    const capture = weave(canonicalizeSchema([shipments(), proc(), fn()]), new Map(), digest);
    const byKey = new Map(capture.changes.map((c) => [c.key, c]));
    for (const key of [
      'function:FN_SHIP_COST',
      'procedure:SP_RESTOCK',
      'trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH',
    ]) {
      expect(byKey.get(key)?.operation, key).toBe('ADD');
      expect(byKey.get(key)?.previousHash, key).toBeUndefined();
    }
    expect(byKey.get('function:FN_SHIP_COST')?.type).toBe('function');
    expect(byKey.get('procedure:SP_RESTOCK')?.type).toBe('procedure');
    expect(byKey.get('trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH')?.type).toBe('trigger');
  });

  it('reports a changed procedure body as a single MODIFY', () => {
    expect(
      delta([proc()], [proc({ definition: 'CREATE PROCEDURE sp_restock(IN p_qty INT)\nBEGIN\n  DELETE FROM shipments;\nEND' })])
    ).toEqual([['procedure:SP_RESTOCK', 'MODIFY']]);
  });

  it('reports a changed function signature as MODIFY', () => {
    // Same name, one extra parameter: the address is unchanged, so the
    // signature has to be inside the hashed body for this to register at all.
    expect(
      delta(
        [fn()],
        [
          fn({
            parameters: [
              { name: 'p_weight', type: 'decimal(8,2)', mode: 'IN' },
              { name: 'p_zone', type: 'int', mode: 'IN' },
            ],
          }),
        ]
      )
    ).toEqual([['function:FN_SHIP_COST', 'MODIFY']]);
  });

  it('reports a scalar function becoming table-valued as MODIFY', () => {
    expect(delta([fn()], [fn({ functionKind: 'table' })])).toEqual([
      ['function:FN_SHIP_COST', 'MODIFY'],
    ]);
  });

  it('reports a retimed or re-evented trigger as MODIFY, and leaves its table alone', () => {
    expect(
      delta(
        [shipments()],
        [
          shipments({
            trigger: [
              {
                name: 'trg_shipments_touch',
                timing: 'AFTER',
                event: 'INSERT OR UPDATE',
                definition: 'BEGIN\n  SET NEW.qty = NEW.qty;\nEND',
              },
            ],
          }),
        ]
      )
    ).toEqual([['trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH', 'MODIFY']]);
  });

  it('reports a changed trigger body as MODIFY', () => {
    expect(
      delta(
        [shipments()],
        [
          shipments({
            trigger: [
              {
                name: 'trg_shipments_touch',
                timing: 'BEFORE',
                event: 'INSERT',
                definition: 'BEGIN\n  SET NEW.qty = 0;\nEND',
              },
            ],
          }),
        ]
      )
    ).toEqual([['trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH', 'MODIFY']]);
  });

  it('does not mint a version for a re-indented routine or trigger', () => {
    // Servers re-format stored SQL, so raw text would report a change nobody
    // made. Only the whitespace-collapsed body is hashed.
    const reformatted = [
      fn({
        definition:
          'CREATE   FUNCTION fn_ship_cost(p_weight decimal(8,2))\n\n\tRETURNS decimal(8,2)\n\tRETURN p_weight * 2;;',
      }),
      shipments({
        trigger: [
          {
            name: 'trg_shipments_touch',
            timing: 'BEFORE',
            event: 'INSERT',
            definition: 'BEGIN      SET NEW.qty = NEW.qty;   END  ',
          },
        ],
      }),
    ];
    expect(delta([fn(), shipments()], reformatted)).toEqual([]);
  });

  it('reports a dropped routine or trigger as DELETE for that key only', () => {
    expect(delta([shipments(), proc(), fn()], [shipments(), proc()])).toEqual([
      ['function:FN_SHIP_COST', 'DELETE'],
    ]);
    expect(delta([shipments(), proc(), fn()], [shipments(), fn()])).toEqual([
      ['procedure:SP_RESTOCK', 'DELETE'],
    ]);
    expect(delta([shipments(), fn()], [shipments({ trigger: [] }), fn()])).toEqual([
      ['trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH', 'DELETE'],
    ]);
  });

  it('deletes a dropped table together with the trigger it owned', () => {
    expect(delta([shipments()], [])).toEqual([
      ['column:SHIPMENTS.ID', 'DELETE'],
      ['column:SHIPMENTS.QTY', 'DELETE'],
      ['primary_key:SHIPMENTS', 'DELETE'],
      ['table:SHIPMENTS', 'DELETE'],
      ['trigger:SHIPMENTS.TRG_SHIPMENTS_TOUCH', 'DELETE'],
    ]);
  });

  it('keeps a trigger and its table independent in both directions', () => {
    // Adding a column must not touch the trigger's hash, and vice versa.
    const withColumn = shipments({
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'qty', type: 'integer', nullable: true, primaryKey: false },
        { name: 'note', type: 'text', nullable: true, primaryKey: false },
      ],
    });
    expect(delta([shipments()], [withColumn])).toEqual([['column:SHIPMENTS.NOTE', 'ADD']]);
  });

  it('does not confuse two triggers of the same name on different tables', () => {
    const orders: TableSchema = {
      name: 'orders',
      objectType: 'TABLE',
      columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
      indices: [],
      foreignKeys: [],
      primaryKey: { columns: ['id'] },
      triggers: [{ name: 'trg_touch', timing: 'BEFORE', event: 'INSERT', definition: 'BEGIN END' }],
    };
    const shipping: TableSchema = { ...orders, name: 'shipping' };
    const keys = canonicalizeSchema([orders, shipping])
      .filter((o) => o.type === 'trigger')
      .map((o) => o.key);
    expect(keys).toEqual(['trigger:ORDERS.TRG_TOUCH', 'trigger:SHIPPING.TRG_TOUCH']);
  });

  it('does not collide a function with a procedure of the same name', () => {
    // Postgres and Db2 both allow it; two objects must stay two addresses.
    const keys = canonicalizeSchema([fn({ name: 'restock' }), proc({ name: 'restock' })]).map((o) => o.key);
    expect(keys).toEqual(['function:RESTOCK', 'procedure:RESTOCK']);
  });
});
