import { describe, expect, it } from 'vitest';
import {
  dbSchemaToTableSchemas,
  normalizeTableSchemas,
  resolveFkReferencedColumns,
  groupForeignKeyRows,
} from './schema-to-tables.js';
import type { DbSchema, DbTable } from '../interfaces/index.js';

function emptySchema(tables: Record<string, DbTable>): DbSchema {
  return {
    tables,
    columns: {},
    functions: {},
    procedures: {},
    triggers: {},
    sequences: {},
    userTypes: {},
    primaryKeys: {},
    foreignKeys: {},
    views: {},
    uniqueConstraints: {},
    indexes: {},
    indexColumns: {},
  };
}

describe('dbSchemaToTableSchemas foreign keys', () => {
  it('preserves composite FK referenced column order (not parent PK order)', () => {
    const parent: DbTable = {
      name: 'test1',
      columns: {
        id1: { name: 'id1', type: 'int', nullable: false },
        id2: { name: 'id2', type: 'int', nullable: false },
      },
      primaryKey: ['id1', 'id2'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
    };
    const child: DbTable = {
      name: 'test2',
      columns: {
        test1_id2: { name: 'test1_id2', type: 'int', nullable: false },
        test1_id1: { name: 'test1_id1', type: 'int', nullable: false },
      },
      primaryKey: [],
      foreignKeys: [
        {
          name: 'fk_test2_test1',
          columns: ['test1_id2', 'test1_id1'],
          referencedSchema: 'mcve',
          referencedTable: 'test1',
          referencedColumns: ['id2', 'id1'],
        },
      ],
      uniqueConstraints: [],
      indexes: [],
    };

    const tables = dbSchemaToTableSchemas(
      emptySchema({ test1: parent, test2: child })
    );
    const test2 = tables.find((t) => t.name === 'test2');
    expect(test2?.foreignKeys).toEqual([
      {
        name: 'fk_test2_test1',
        columns: ['test1_id2', 'test1_id1'],
        referencedSchema: 'mcve',
        referencedTable: 'test1',
        referencedColumns: ['id2', 'id1'],
      },
    ]);
  });

  it('keeps a cross-schema parent schema on ForeignKeyInfo (FK drill needs it)', () => {
    const child: DbTable = {
      name: 'orders',
      columns: {
        product_id: { name: 'product_id', type: 'int', nullable: false },
      },
      primaryKey: [],
      foreignKeys: [
        {
          name: 'fk_orders_products',
          columns: ['product_id'],
          referencedSchema: 'inventory',
          referencedTable: 'products',
          referencedColumns: ['id'],
        },
      ],
      uniqueConstraints: [],
      indexes: [],
    };
    const tables = dbSchemaToTableSchemas(emptySchema({ orders: child }));
    expect(tables[0]?.foreignKeys[0]).toEqual({
      name: 'fk_orders_products',
      columns: ['product_id'],
      referencedSchema: 'inventory',
      referencedTable: 'products',
      referencedColumns: ['id'],
    });
  });

  it('falls back to parent PK when referencedColumns missing', () => {
    const parent: DbTable = {
      name: 'parent',
      columns: {
        a: { name: 'a', type: 'int', nullable: false },
        b: { name: 'b', type: 'int', nullable: false },
      },
      primaryKey: ['a', 'b'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
    };
    const child: DbTable = {
      name: 'child',
      columns: {
        a: { name: 'a', type: 'int', nullable: false },
        b: { name: 'b', type: 'int', nullable: false },
      },
      primaryKey: [],
      foreignKeys: [
        {
          name: 'fk_child',
          columns: ['a', 'b'],
          referencedSchema: '',
          referencedTable: 'parent',
          // omit referencedColumns — upgrade-compat path
        },
      ],
      uniqueConstraints: [],
      indexes: [],
    };

    const tables = dbSchemaToTableSchemas(emptySchema({ parent, child }));
    const fk = tables.find((t) => t.name === 'child')?.foreignKeys[0];
    expect(fk?.referencedColumns).toEqual(['a', 'b']);
  });
});

describe('normalizeTableSchemas', () => {
  it('fills omitted referencedColumns from parent PK for old client payloads', () => {
    const tables = normalizeTableSchemas([
      {
        name: 'parent',
        objectType: 'TABLE',
        columns: [
          { name: 'id1', type: 'int', nullable: false, primaryKey: true },
          { name: 'id2', type: 'int', nullable: false, primaryKey: true },
        ],
        indices: [],
        foreignKeys: [],
        primaryKey: { columns: ['id1', 'id2'] },
      },
      {
        name: 'child',
        objectType: 'TABLE',
        columns: [
          { name: 'id1', type: 'int', nullable: false, primaryKey: false },
          { name: 'id2', type: 'int', nullable: false, primaryKey: false },
        ],
        indices: [],
        foreignKeys: [
          {
            name: 'fk_old',
            columns: ['id1', 'id2'],
            referencedTable: 'parent',
            referencedColumns: undefined as unknown as string[],
          },
        ],
      },
    ]);
    expect(tables[1]!.foreignKeys[0]!.referencedColumns).toEqual(['id1', 'id2']);
  });
});

describe('resolveFkReferencedColumns', () => {
  it('uses catalog columns when every entry is a real identifier', () => {
    expect(resolveFkReferencedColumns(['a'], ['id'], ['pk'])).toEqual(['id']);
  });

  it('falls back to the parent PK when the catalog reports a NULL column', () => {
    // SQLite's PRAGMA foreign_key_list yields `to = NULL` for `REFERENCES parent`
    // with no column list — same arity as the child side, no usable name.
    const nulls = [null] as unknown as string[];
    expect(resolveFkReferencedColumns(['parent_id'], nulls, ['id'])).toEqual(['id']);
    expect(resolveFkReferencedColumns(['parent_id'], [''], ['id'])).toEqual(['id']);
  });

  it('falls back when the arity does not match', () => {
    expect(resolveFkReferencedColumns(['a', 'b'], ['id'], ['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('groupForeignKeyRows', () => {
  const rows = [
    { c: 'fk_a', t: 'orders', col: 'cust_id', rt: 'customers', rc: 'id' },
    { c: 'fk_b', t: 'lines', col: 'order_id', rt: 'orders', rc: 'id' },
    { c: 'fk_b', t: 'lines', col: 'seq', rt: 'orders', rc: 'seq' },
  ];
  const pick = (r: (typeof rows)[number]) => ({
    key: r.c,
    name: r.c,
    table: r.t,
    column: r.col,
    referencedSchema: 'public',
    referencedTable: r.rt,
    referencedColumn: r.rc,
  });

  it('folds composite keys in row order', () => {
    const out = groupForeignKeyRows(rows, pick);
    expect(out).toHaveLength(2);
    expect(out[1]!.table).toBe('lines');
    expect(out[1]!.fk.columns).toEqual(['order_id', 'seq']);
    expect(out[1]!.fk.referencedColumns).toEqual(['id', 'seq']);
  });

  it('drops parent columns entirely when the catalog reports none', () => {
    const out = groupForeignKeyRows(
      [{ ...rows[0]!, rc: null as unknown as string }],
      pick
    );
    expect(out[0]!.fk.columns).toEqual(['cust_id']);
    expect(out[0]!.fk.referencedColumns).toEqual([]);
  });

  it('drops a partially-reported parent side rather than misaligning it', () => {
    const out = groupForeignKeyRows(
      [rows[1]!, { ...rows[2]!, rc: null as unknown as string }],
      pick
    );
    expect(out[0]!.fk.columns).toEqual(['order_id', 'seq']);
    expect(out[0]!.fk.referencedColumns).toEqual([]);
  });
});

describe('dbSchemaToTableSchemas ClickHouse engine / ORDER BY', () => {
  it('copies engine and sorting key onto TableSchema', () => {
    const coupons: DbTable = {
      name: 'coupons',
      columns: { id: { name: 'id', type: 'Int32', nullable: false } },
      primaryKey: ['id'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
      engine: 'MergeTree',
      orderBy: ['id'],
    };
    const [t] = dbSchemaToTableSchemas(emptySchema({ coupons }));
    expect(t?.engine).toBe('MergeTree');
    expect(t?.orderBy).toEqual(['id']);
    expect(t?.primaryKey?.columns).toEqual(['id']);
  });

  it('omits engine / ORDER BY when the catalog did not send them', () => {
    const orders: DbTable = {
      name: 'orders',
      columns: { id: { name: 'id', type: 'int', nullable: false } },
      primaryKey: ['id'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
    };
    const [t] = dbSchemaToTableSchemas(emptySchema({ orders }));
    expect(t?.engine).toBeUndefined();
    expect(t?.orderBy).toBeUndefined();
  });
});
