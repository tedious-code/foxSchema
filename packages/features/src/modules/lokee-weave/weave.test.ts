import { describe, expect, it } from 'vitest';
import { canonicalizeSchema } from './canonical';
import {
  applyChanges,
  diffAgainstIndex,
  hashObject,
  hashObjects,
  rootHash,
  weave,
  type Digest,
  type WeaveObject,
} from './weave';
import { stableStringify } from './stable-stringify';
import type { TableSchema } from '@foxschema/sql';

/**
 * A digest only has to be deterministic and collision-free for these inputs;
 * using the text itself makes failures readable. Real callers pass sha256.
 */
const digest: Digest = (text) => `h(${text.length}:${text})`;
/**
 * Compact digest for tests that only compare hashes.
 *
 * Deliberately content-sensitive: a length-based fake silently passed the
 * "only the changed object" test because `varchar(100)` and `varchar(255)`
 * are the same length, so a real change hashed identically.
 */
const short: Digest = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

function table(over: Partial<TableSchema> = {}): TableSchema {
  return {
    name: 'customer',
    objectType: 'TABLE',
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'email', type: 'varchar(100)', nullable: false, primaryKey: false },
    ],
    indices: [],
    foreignKeys: [],
    primaryKey: { name: 'pk_customer', columns: ['id'] },
    ...over,
  };
}

describe('canonicalizeSchema — granularity and addressing', () => {
  it('splits a table into container, columns and primary key', () => {
    const keys = canonicalizeSchema([table()]).map((o) => o.key);
    expect(keys).toEqual([
      'column:CUSTOMER.EMAIL',
      'column:CUSTOMER.ID',
      'primary_key:CUSTOMER',
      'table:CUSTOMER',
    ]);
  });

  it('upper-cases the key but keeps the real name in the body', () => {
    // Oracle and Db2 fold identifiers; the key is an address, never DDL.
    const [column] = canonicalizeSchema([table({ name: 'Customer' })]);
    expect(column!.key.startsWith('column:CUSTOMER.')).toBe(true);
    expect(column!.body.table).toBe('Customer');
  });

  it('returns objects in key order regardless of introspection order', () => {
    const a = canonicalizeSchema([table({ name: 'b' }), table({ name: 'a' })]).map((o) => o.key);
    const b = canonicalizeSchema([table({ name: 'a' }), table({ name: 'b' })]).map((o) => o.key);
    expect(a).toEqual(b);
  });

  it('drops a duplicated object rather than letting the last one win', () => {
    // Otherwise the root hash would depend on which duplicate came last.
    const objects = canonicalizeSchema([table(), table()]);
    expect(new Set(objects.map((o) => o.key)).size).toBe(objects.length);
  });

  it('keeps the container body free of its children', () => {
    // A column change must not also change the table's hash, or the delta
    // would carry both and the sharing would be lost.
    const withExtra = table({
      columns: [...table().columns, { name: 'status', type: 'varchar(20)', nullable: true, primaryKey: false }],
    });
    const before = canonicalizeSchema([table()]).find((o) => o.key === 'table:CUSTOMER');
    const after = canonicalizeSchema([withExtra]).find((o) => o.key === 'table:CUSTOMER');
    expect(stableStringify(after!.body)).toBe(stableStringify(before!.body));
  });

  it('ignores whitespace-only differences in a view definition', () => {
    const one = canonicalizeSchema([
      table({ objectType: 'VIEW', name: 'v', columns: [], definition: 'SELECT a,\n  b FROM t;' }),
    ]);
    const two = canonicalizeSchema([
      table({ objectType: 'VIEW', name: 'v', columns: [], definition: '  SELECT a, b FROM t  ' }),
    ]);
    expect(hashObjects(one, short)[0]!.hash).toBe(hashObjects(two, short)[0]!.hash);
  });

  it('treats a missing default and a null default as the same', () => {
    const a = canonicalizeSchema([
      table({ columns: [{ name: 'c', type: 'int', nullable: true, primaryKey: false }] }),
    ]);
    const b = canonicalizeSchema([
      table({
        columns: [{ name: 'c', type: 'int', nullable: true, primaryKey: false, defaultValue: undefined }],
      }),
    ]);
    expect(hashObjects(a, short)[0]!.hash).toBe(hashObjects(b, short)[0]!.hash);
  });

  it('does not fold a primary key name into identity', () => {
    // Server-generated constraint names differ between two databases holding
    // the same logical schema.
    const a = canonicalizeSchema([table({ primaryKey: { name: 'pk_1', columns: ['id'] } })]);
    const b = canonicalizeSchema([table({ primaryKey: { name: 'pk_2', columns: ['id'] } })]);
    const pk = (list: ReturnType<typeof canonicalizeSchema>) =>
      hashObjects(list, short).find((o) => o.key === 'primary_key:CUSTOMER')!.hash;
    expect(pk(a)).toBe(pk(b));
  });
});

describe('hashing — identity', () => {
  it('is stable across runs for the same input', () => {
    const objects = canonicalizeSchema([table()]);
    expect(rootHash(hashObjects(objects, digest), digest)).toBe(
      rootHash(hashObjects(objects, digest), digest)
    );
  });

  it('distinguishes objects with identical bodies at different addresses', () => {
    // Every `id integer not null` in the database would otherwise be one object.
    const a = { key: 'column:A.ID', type: 'column' as const, body: { t: 1 } };
    const b = { key: 'column:B.ID', type: 'column' as const, body: { t: 1 } };
    expect(hashObject(a, digest)).not.toBe(hashObject(b, digest));
  });

  it('root hash ignores object order', () => {
    const objects = hashObjects(canonicalizeSchema([table()]), digest);
    const shuffled = [...objects].reverse();
    expect(rootHash(shuffled, digest)).toBe(rootHash(objects, digest));
  });

  it('root hash changes when any object changes', () => {
    const before = hashObjects(canonicalizeSchema([table()]), digest);
    const after = hashObjects(
      canonicalizeSchema([
        table({
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'email', type: 'varchar(255)', nullable: false, primaryKey: false },
          ],
        }),
      ]),
      digest
    );
    expect(rootHash(after, digest)).not.toBe(rootHash(before, digest));
  });
});

describe('diffAgainstIndex — only what changed', () => {
  const hashed = (t: TableSchema[]): WeaveObject[] => hashObjects(canonicalizeSchema(t), short);
  const index = (objects: WeaveObject[]) => new Map(objects.map((o) => [o.key, o.hash]));

  it('reports nothing for an unchanged schema', () => {
    const objects = hashed([table()]);
    expect(diffAgainstIndex(index(objects), objects)).toEqual([]);
  });

  it('reports only the changed object, not its neighbours', () => {
    // The whole storage argument: 3 changes in a 20,000-object schema must
    // write 3 rows.
    const before = hashed([table()]);
    const after = hashed([
      table({
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'email', type: 'varchar(255)', nullable: false, primaryKey: false },
        ],
      }),
    ]);
    const changes = diffAgainstIndex(index(before), after);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.key).toBe('column:CUSTOMER.EMAIL');
    expect(changes[0]!.operation).toBe('MODIFY');
    expect(changes[0]!.previousHash).toBeDefined();
  });

  it('reports an added object as ADD with no previous hash', () => {
    const before = hashed([table()]);
    const after = hashed([
      table({
        columns: [...table().columns, { name: 'status', type: 'varchar(20)', nullable: true, primaryKey: false }],
      }),
    ]);
    const added = diffAgainstIndex(index(before), after);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ key: 'column:CUSTOMER.STATUS', operation: 'ADD' });
    expect(added[0]!.previousHash).toBeUndefined();
  });

  it('detects a dropped object', () => {
    // Without delete detection a reconstructed schema keeps objects that no
    // longer exist.
    const before = hashed([table(), table({ name: 'orders', columns: [], primaryKey: undefined })]);
    const after = hashed([table()]);
    const changes = diffAgainstIndex(index(before), after);
    expect(changes.map((c) => c.key)).toEqual(['table:ORDERS']);
    expect(changes[0]!.operation).toBe('DELETE');
    expect(changes[0]!.hash).toBeUndefined();
  });

  it('treats a first capture as all ADDs', () => {
    const objects = hashed([table()]);
    const changes = diffAgainstIndex(new Map(), objects);
    expect(changes).toHaveLength(objects.length);
    expect(changes.every((c) => c.operation === 'ADD')).toBe(true);
  });

  it('emits changes in key order so a delta is reproducible', () => {
    const after = hashed([table({ name: 'b' }), table({ name: 'a' })]);
    const keys = diffAgainstIndex(new Map(), after).map((c) => c.key);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('applyChanges — the latest index tracks the delta', () => {
  it('round-trips: previous + changes === current', () => {
    // The property the latest-state index depends on. If it fails, the index
    // drifts from history and every later capture is wrong.
    const before = hashObjects(canonicalizeSchema([table()]), short);
    const after = hashObjects(
      canonicalizeSchema([
        table({
          columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }],
          primaryKey: { name: 'pk', columns: ['id'] },
        }),
        table({ name: 'orders', columns: [], primaryKey: undefined }),
      ]),
      short
    );
    const previousIndex = new Map(before.map((o) => [o.key, o.hash]));
    const next = applyChanges(previousIndex, diffAgainstIndex(previousIndex, after));
    expect([...next.entries()].sort()).toEqual(
      [...after.map((o) => [o.key, o.hash] as const)].sort()
    );
  });

  it('does not mutate the index it was given', () => {
    const previous = new Map([['a', '1']]);
    applyChanges(previous, [{ key: 'a', operation: 'DELETE' }]);
    expect(previous.get('a')).toBe('1');
  });
});

describe('weave — one capture', () => {
  it('reports unchanged when the schema matches the index', () => {
    const first = weave(canonicalizeSchema([table()]), new Map(), short);
    const index = new Map(first.objects.map((o) => [o.key, o.hash]));
    const second = weave(canonicalizeSchema([table()]), index, short);

    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
    // Rule 5: same schema → same root hash → no new version.
    expect(second.rootHash).toBe(first.rootHash);
  });

  it('reports a single delta for a single added column', () => {
    // The Phase 1 definition of done, in miniature.
    const first = weave(canonicalizeSchema([table()]), new Map(), short);
    const index = new Map(first.objects.map((o) => [o.key, o.hash]));
    const second = weave(
      canonicalizeSchema([
        table({
          columns: [...table().columns, { name: 'status', type: 'varchar(20)', nullable: true, primaryKey: false }],
        }),
      ]),
      index,
      short
    );

    expect(second.changed).toBe(true);
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]).toMatchObject({ key: 'column:CUSTOMER.STATUS', operation: 'ADD' });
    expect(second.rootHash).not.toBe(first.rootHash);
  });

  it('handles an empty schema without inventing a change', () => {
    const empty = weave([], new Map(), short);
    expect(empty.changed).toBe(false);
    expect(empty.objects).toEqual([]);
  });
});
