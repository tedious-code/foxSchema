import { describe, expect, it } from 'vitest';
import { canonicalizeSchema } from './canonical.js';
import { stableStringify } from './stable-stringify.js';
import { mergeBody, roundTrips, shapeKey, splitBody } from './shape.js';
import type { TableSchema } from '@foxschema/sql';

const COLUMN_BODY = {
  name: 'email',
  table: 'customer',
  dataType: 'varchar(255)',
  nullable: true,
  default: null,
  identity: false,
  identityGeneration: null,
  collation: null,
};

describe('splitBody / mergeBody', () => {
  it('round trips exactly — the invariant the object hash depends on', () => {
    // The hash was computed over the whole body. If recombining does not
    // reproduce it, every stored hash silently stops matching what a read
    // reconstructs, and the history becomes unverifiable.
    expect(stableStringify(mergeBody(splitBody(COLUMN_BODY)))).toBe(stableStringify(COLUMN_BODY));
    expect(roundTrips(COLUMN_BODY)).toBe(true);
  });

  it('puts only name and table in identity', () => {
    const { identity, shape } = splitBody(COLUMN_BODY);
    expect(Object.keys(identity).sort()).toEqual(['name', 'table']);
    expect(Object.keys(shape).sort()).toEqual([
      'collation',
      'dataType',
      'default',
      'identity',
      'identityGeneration',
      'nullable',
    ]);
  });

  it('gives two columns of the same declaration one shape key', () => {
    // This is the entire point: `int not null` is one row, however many tables
    // declare it.
    const a = splitBody({ ...COLUMN_BODY, name: 'a', table: 't1' });
    const b = splitBody({ ...COLUMN_BODY, name: 'b', table: 't2' });
    expect(shapeKey(a.shape)).toBe(shapeKey(b.shape));
  });

  it('separates declarations that differ in any field', () => {
    const base = splitBody(COLUMN_BODY);
    for (const patch of [
      { dataType: 'varchar(100)' },
      { nullable: false },
      { default: '0' },
      { identity: true },
      { collation: 'C' },
    ]) {
      const other = splitBody({ ...COLUMN_BODY, ...patch });
      expect(shapeKey(other.shape), JSON.stringify(patch)).not.toBe(shapeKey(base.shape));
    }
  });

  it('does not confuse a missing field with an explicitly null one', () => {
    // `{}` and `{default: null}` are different declarations; collapsing them
    // would let a column silently gain or lose a default across versions.
    expect(shapeKey(splitBody({ name: 'x' }).shape)).not.toBe(
      shapeKey(splitBody({ name: 'x', default: null }).shape)
    );
  });

  it('handles a body with no identity fields at all', () => {
    // A primary key body carries `table` and `columns`, no `name`.
    const pk = { table: 'customer', columns: ['id'] };
    expect(roundTrips(pk)).toBe(true);
    expect(splitBody(pk).identity).toEqual({ table: 'customer' });
  });

  it('handles an empty body', () => {
    expect(roundTrips({})).toBe(true);
    expect(mergeBody(splitBody({}))).toEqual({});
  });

  it('preserves nested and array values', () => {
    const body = { name: 'idx', table: 't', columns: ['a', 'b'], filter: null, unique: true };
    expect(roundTrips(body)).toBe(true);
    expect(mergeBody(splitBody(body))).toEqual(body);
  });

  it('round trips every object a real schema canonicalises to', () => {
    // Fixtures drift from what the canonicaliser actually emits; drive the
    // invariant from the producer instead of from hand-written bodies.
    const tables: TableSchema[] = [
      {
        name: 'customer',
        objectType: 'TABLE',
        columns: [
          { name: 'id', type: 'integer', nullable: false, identity: true },
          { name: 'email', type: 'varchar(255)', nullable: true },
        ],
        indices: [{ name: 'idx_email', columns: ['email'], unique: true }],
        primaryKey: { columns: ['id'] },
        triggers: [{ name: 'trg', timing: 'AFTER', event: 'INSERT', definition: 'BEGIN END' }],
      } as TableSchema,
      {
        name: 'v_sales',
        objectType: 'VIEW',
        definition: 'SELECT 1',
      } as TableSchema,
    ];
    const objects = canonicalizeSchema(tables);
    expect(objects.length).toBeGreaterThan(5);
    for (const object of objects) {
      expect(roundTrips(object.body), object.key).toBe(true);
    }
  });
});
