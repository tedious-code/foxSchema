/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Attribution is only worth having if it is right, so most of these cases are
 * about the ways it could be confidently wrong: a name two joined tables share,
 * a schema cache that has drifted from the database, an outer join with no
 * matching row. In every one of those the answer must be "unknown" rather than
 * a plausible guess — the reader acts on this label.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeResultColumns,
  collapsedColumnsFor,
  fromClauseEntries,
  rowKeyFor,
  tablesInOrigins,
  splitSelectItems,
} from './column-origin.js';
import type { TableSchema } from '@foxschema/sql';

const table = (name: string, columns: string[], pk?: string[]): TableSchema =>
  ({
    name,
    objectType: 'TABLE',
    columns: columns.map((c) => ({ name: c, type: 'int', nullable: true })),
    indices: [],
    foreignKeys: [],
    ...(pk ? { primaryKey: { name: `pk_${name}`, columns: pk } } : {}),
  }) as unknown as TableSchema;

const ORDERS = table('orders', ['id', 'customer_id', 'total', 'created_at'], ['id']);
const CUSTOMERS = table('customers', ['id', 'name', 'created_at'], ['id']);
const PRODUCTS = table('products', ['id', 'name', 'price'], ['id']);
const ALL = [ORDERS, CUSTOMERS, PRODUCTS];

const attribute = (sql: string, cols: string[], tables = ALL) =>
  attributeResultColumns({ sql, resultColumns: cols, tables });

describe('fromClauseEntries', () => {
  it('keeps the written order, which is the order SELECT * expands in', () => {
    const entries = fromClauseEntries(
      'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON 1=1'
    );
    expect(entries.map((e) => e.name)).toEqual(['orders', 'customers', 'products']);
    expect(entries.map((e) => e.alias)).toEqual(['o', 'c', 'p']);
  });

  it('reads a comma-separated FROM list', () => {
    const entries = fromClauseEntries('SELECT * FROM orders o, customers c WHERE c.id = o.customer_id');
    expect(entries.map((e) => e.name)).toEqual(['orders', 'customers']);
  });

  it('does not take a SELECT-list comma for a table', () => {
    // `SELECT a, b FROM t` — the comma separates output columns, not tables.
    const entries = fromClauseEntries('SELECT id, total FROM orders');
    expect(entries.map((e) => e.name)).toEqual(['orders']);
  });

  it('does not take a following keyword for an alias', () => {
    // `FROM orders WHERE` once bound the alias `where`, so `WHERE.x` resolved.
    const entries = fromClauseEntries('SELECT * FROM orders WHERE total > 10');
    expect(entries).toEqual([{ name: 'orders' }]);
  });

  it('reads quoted and schema-qualified names', () => {
    const entries = fromClauseEntries('SELECT * FROM "sales"."orders" AS o JOIN [dbo].[customers] c ON 1=1');
    // Each part unquoted, not the whole string — `sales"."orders` matches nothing.
    expect(entries.map((e) => e.name)).toEqual(['sales.orders', 'dbo.customers']);
    expect(entries.map((e) => e.alias)).toEqual(['o', 'c']);
  });
});

describe('SELECT * across a join', () => {
  it('separates three columns that are all called id', () => {
    // The whole point: by name alone these are indistinguishable.
    const cols = [
      'id', 'customer_id', 'total', 'created_at', //  orders
      'id', 'name', 'created_at',                 //  customers
      'id', 'name', 'price',                      //  products
    ];
    const origins = attribute(
      'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON 1=1',
      cols
    );
    expect(origins.map((o) => o.table)).toEqual([
      'orders', 'orders', 'orders', 'orders',
      'customers', 'customers', 'customers',
      'products', 'products', 'products',
    ]);
    expect(new Set(origins.map((o) => o.confidence))).toEqual(new Set(['positional']));
  });

  it('carries the alias through, so the header can say o. or c.', () => {
    const origins = attribute('SELECT * FROM orders o JOIN customers c ON 1=1', [
      'id', 'customer_id', 'total', 'created_at', 'id', 'name', 'created_at',
    ]);
    expect(origins[0]!.qualifier).toBe('o');
    expect(origins[4]!.qualifier).toBe('c');
  });

  it('abandons alignment when a name differs but the count still matches', () => {
    // The dangerous drift: `total` was renamed to `amount`, so the counts still
    // line up and only the names reveal it. Without checking names, position 2
    // would be labelled orders.total — a column that no longer exists.
    const cols = ['id', 'customer_id', 'amount', 'created_at', 'id', 'name', 'created_at'];
    const origins = attribute('SELECT * FROM orders o JOIN customers c ON 1=1', cols);
    expect(origins.every((o) => o.confidence !== 'positional')).toBe(true);
    expect(origins[2]!.table).toBeUndefined();
  });

  it('abandons alignment when the cache disagrees with the result', () => {
    // A column added since the schema was cached shifts every position by one.
    // Attributing anyway would relabel the whole grid, confidently and wrongly.
    const cols = ['id', 'customer_id', 'total', 'created_at', 'discount', 'id', 'name', 'created_at'];
    const origins = attribute('SELECT * FROM orders o JOIN customers c ON 1=1', cols);
    expect(origins.every((o) => o.confidence !== 'positional')).toBe(true);
    // It falls back to per-name attribution: `total` is unique to orders.
    expect(origins.find((o) => o.column === 'total')?.table).toBe('orders');
    // `id` is on both tables, so it stays unattributed rather than guessed.
    expect(origins.filter((o) => o.column === 'id').every((o) => o.table === undefined)).toBe(true);
  });
});

describe('explicit column lists', () => {
  it('trusts the qualifier the statement wrote', () => {
    const origins = attribute(
      'SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id',
      ['id', 'name', 'total']
    );
    expect(origins.map((o) => [o.table, o.confidence])).toEqual([
      ['orders', 'qualified'],
      ['customers', 'qualified'],
      ['orders', 'qualified'],
    ]);
  });

  it('resolves an unqualified name only when one table has it', () => {
    const origins = attribute(
      'SELECT total, price FROM orders o JOIN products p ON 1=1',
      ['total', 'price']
    );
    expect(origins.map((o) => o.table)).toEqual(['orders', 'products']);
    expect(origins.map((o) => o.confidence)).toEqual(['unique', 'unique']);
  });

  it('refuses an unqualified name two joined tables share', () => {
    // `name` is on customers and products. There is no way to tell, and
    // picking the first would be wrong half the time.
    const origins = attribute(
      'SELECT name FROM customers c JOIN products p ON 1=1',
      ['name']
    );
    expect(origins[0]!.table).toBeUndefined();
    expect(origins[0]!.confidence).toBe('unknown');
  });

  it('handles alias.* mixed with named columns', () => {
    const origins = attribute(
      'SELECT o.*, c.name FROM orders o JOIN customers c ON 1=1',
      ['id', 'customer_id', 'total', 'created_at', 'name']
    );
    expect(origins.map((o) => o.table)).toEqual([
      'orders', 'orders', 'orders', 'orders', 'customers',
    ]);
  });

  it('gives up on alignment when the list holds an expression', () => {
    // `SUM(o.total)` produces one column whose name the engine chooses, so
    // positions after it cannot be trusted.
    const origins = attribute(
      'SELECT o.id, SUM(o.total) FROM orders o JOIN customers c ON 1=1',
      ['id', 'sum']
    );
    expect(origins.every((o) => o.confidence !== 'positional')).toBe(true);
    expect(origins[1]!.table).toBeUndefined();
  });
});

describe('when nothing can be said', () => {
  it('answers unknown rather than throwing on an empty schema cache', () => {
    const origins = attribute('SELECT * FROM orders o JOIN customers c ON 1=1', ['id'], []);
    expect(origins).toEqual([{ index: 0, column: 'id', confidence: 'unknown' }]);
  });

  it('answers unknown for a table the cache has never heard of', () => {
    const origins = attribute('SELECT * FROM unknown_table', ['id', 'x']);
    expect(origins.every((o) => o.table === undefined)).toBe(true);
  });

  it('survives a statement it cannot parse', () => {
    const origins = attribute('SELECT FROM WHERE', ['id']);
    expect(origins).toHaveLength(1);
    expect(origins[0]!.confidence).toBe('unknown');
  });
});

describe('tablesInOrigins', () => {
  it('lists tables in the order their columns appear', () => {
    const origins = attribute(
      'SELECT c.name, o.total FROM orders o JOIN customers c ON 1=1',
      ['name', 'total']
    );
    // customers first: its column is leftmost, whatever the FROM order was.
    expect(tablesInOrigins(origins)).toEqual(['customers', 'orders']);
  });

  it('skips unattributed columns', () => {
    expect(tablesInOrigins([{ index: 0, column: 'x', confidence: 'unknown' }])).toEqual([]);
  });
});

describe('rowKeyFor', () => {
  const sql = 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id';
  const cols = ['id', 'customer_id', 'total', 'created_at', 'id', 'name', 'created_at'];
  const origins = attribute(sql, cols);

  it('takes the key from the columns of that table, not any column of that name', () => {
    // Both tables have `id`. Taking the first `id` for customers would open
    // the wrong customer — this is the confusion the module exists to remove.
    const row = [7, 42, 100, 'x', 42, 'Ada', 'y'];
    expect(rowKeyFor(ORDERS, origins, row)).toEqual([{ column: 'id', index: 0, value: 7 }]);
    expect(rowKeyFor(CUSTOMERS, origins, row)).toEqual([{ column: 'id', index: 4, value: 42 }]);
  });

  it('declines when the key is NULL — an outer join that did not match', () => {
    const row = [7, null, 100, 'x', null, null, null];
    expect(rowKeyFor(CUSTOMERS, origins, row)).toBeNull();
  });

  it('declines when the table has no primary key', () => {
    const noPk = table('logs', ['message']);
    const o = attribute('SELECT * FROM logs', ['message'], [noPk]);
    expect(rowKeyFor(noPk, o, ['hi'])).toBeNull();
  });

  it('declines when the key column is not in the result', () => {
    const o = attribute('SELECT total FROM orders', ['total']);
    expect(rowKeyFor(ORDERS, o, [100])).toBeNull();
  });

  it('needs every column of a composite key', () => {
    const composite = table('order_items', ['order_id', 'line_no', 'qty'], ['order_id', 'line_no']);
    const full = attribute('SELECT * FROM order_items', ['order_id', 'line_no', 'qty'], [composite]);
    expect(rowKeyFor(composite, full, [1, 2, 3])).toHaveLength(2);

    // A partial key would match more rows than intended.
    const partial = attribute('SELECT order_id, qty FROM order_items', ['order_id', 'qty'], [composite]);
    expect(rowKeyFor(composite, partial, [1, 3])).toBeNull();
  });
});

describe('collapsedColumnsFor', () => {
  const collapsed = (sql: string, cols: string[], tables = ALL) =>
    collapsedColumnsFor({ sql, resultColumns: cols, tables });

  it('names the columns a join lost to a shared name', () => {
    // The real shape: a driver keys rows by column name, so `SELECT *` over
    // orders+customers returns one `id` and one `created_at` — the customers
    // values — and the orders ones are gone with no error anywhere.
    const arrived = ['id', 'customer_id', 'total', 'created_at', 'name'];
    const out = collapsed('SELECT * FROM orders o JOIN customers c ON 1=1', arrived);
    expect(out).not.toBeNull();
    expect(out!.names.sort()).toEqual(['created_at', 'id']);
    expect(out!.lost).toBe(2); //  7 expected, 5 arrived
  });

  it('says nothing when every column survived', () => {
    const arrived = ['id', 'customer_id', 'total', 'created_at', 'name', 'price'];
    expect(collapsed('SELECT o.id, o.customer_id, o.total, o.created_at, p.name, p.price FROM orders o JOIN products p ON 1=1', arrived)).toBeNull();
  });

  it('says nothing for a single table, which cannot collide with itself', () => {
    expect(collapsed('SELECT * FROM orders', ['id', 'customer_id', 'total', 'created_at'])).toBeNull();
  });

  it('does not mistake a stale cache for a collapse', () => {
    // `discount` is not in the cache, so the shortfall is drift, not collision.
    // Claiming lost columns here would be a false alarm of its own.
    const arrived = ['id', 'discount'];
    expect(collapsed('SELECT * FROM orders o JOIN customers c ON 1=1', arrived)).toBeNull();
  });

  it('says nothing when a FROM table is not in the cache', () => {
    expect(collapsed('SELECT * FROM orders o JOIN mystery m ON 1=1', ['id'])).toBeNull();
  });
});

describe('splitSelectItems', () => {
  it('splits on top-level commas only', () => {
    expect(splitSelectItems(`a, coalesce(b, 0) AS b, 'x,y' AS s, "q,""r" , [c,d]`)).toEqual([
      'a',
      'coalesce(b, 0) AS b',
      `'x,y' AS s`,
      '"q,""r"',
      '[c,d]',
    ]);
  });
});
