/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import { splitSqlStatements } from '../sql-text/sql-splitter.js';
import { lossyConversion, planColumnChange } from './column-change.js';
import type { ColumnChangeInput, ColumnChangePlan } from './column-change.types.js';

const col = (name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});

const table = (name: string, extra: Partial<TableSchema>): TableSchema => ({
  name,
  objectType: 'TABLE',
  columns: [],
  indices: [],
  foreignKeys: [],
  ...extra,
});

const customers = table('customers', {
  columns: [col('id', 'integer', { primaryKey: true, nullable: false }), col('name', 'varchar(100)')],
  primaryKey: { columns: ['id'] },
});
const products = table('products', {
  columns: [col('id', 'integer', { primaryKey: true, nullable: false }), col('sku', 'varchar(20)', { nullable: false })],
  primaryKey: { columns: ['id'] },
  indices: [{ name: 'products_sku_key', columns: ['sku'], unique: true }],
});
const orders = table('orders', {
  columns: [
    col('id', 'integer', { primaryKey: true, nullable: false }),
    col('customer_id', 'integer'),
    col('status', 'varchar(20)', { nullable: false, defaultValue: "'new'" }),
    col('total', 'numeric(10,2)'),
    col('created_at', 'timestamp'),
  ],
  primaryKey: { columns: ['id'] },
  indices: [{ name: 'orders_status_created', columns: ['status', 'created_at'], unique: false }],
  foreignKeys: [
    { name: 'orders_customer_fk', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] },
  ],
  triggers: [{ name: 'orders_audit', definition: 'INSERT INTO audit VALUES (NEW.status)' }],
});
const orderItems = table('order_items', {
  columns: [col('order_id', 'integer'), col('sku', 'varchar(20)')],
  foreignKeys: [{ name: 'items_sku_fk', columns: ['sku'], referencedTable: 'products', referencedColumns: ['sku'] }],
});
const openOrders = table('v_open_orders', {
  objectType: 'VIEW',
  definition: "SELECT id, status FROM orders WHERE status <> 'done'",
});
const ALL = [customers, products, orders, orderItems, openOrders];

const plan = (over: Partial<ColumnChangeInput> & Pick<ColumnChangeInput, 'column' | 'change'>): ColumnChangePlan =>
  planColumnChange({ dialect: 'postgres', schema: 'shop', table: orders, tables: ALL, batchSize: 500, ...over });

const ok = (p: ColumnChangePlan) => {
  if (!p.ok) throw new Error(p.error);
  return p;
};
const sqlOf = (p: ColumnChangePlan, title: RegExp) => ok(p).steps.find((s) => title.test(s.title))?.sql ?? '';

describe('planColumnChange: what it refuses', () => {
  it.each([
    ['an engine without the plan yet', { dialect: 'oracle', column: 'status', change: { newType: 'text' } }, /not available for Oracle yet/],
    ['a column the table does not have', { column: 'nope', change: { newName: 'x' } }, /has no column nope/],
    ['no change', { column: 'status', change: { newName: 'status', newType: 'VARCHAR(20)' } }, /Nothing to change/],
    ['a name already taken', { column: 'status', change: { newName: 'total' } }, /already has a column total/],
    ['a primary key column', { column: 'id', change: { newType: 'bigint' } }, /primary key column/],
  ] as const)('refuses %s', (_label, over, error) => {
    const p = plan(over as never);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(error);
  });

  it('refuses a column other tables reference, naming them', () => {
    const p = planColumnChange({ dialect: 'postgres', table: products, tables: ALL, column: 'sku', change: { newType: 'varchar(40)' } });
    expect(!p.ok && p.error).toMatch(/foreign keys point at this column \(order_items\)/);
  });

  it('refuses a type change on a table without a primary key, but allows a rename there', () => {
    const typed = planColumnChange({ dialect: 'postgres', table: orderItems, tables: ALL, column: 'sku', change: { newType: 'text' } });
    expect(!typed.ok && typed.error).toMatch(/needs a primary key/);
    const renamed = planColumnChange({ dialect: 'postgres', table: orderItems, tables: ALL, column: 'sku', change: { newName: 'item_sku' } });
    expect(renamed.ok).toBe(true);
  });
});

describe('planColumnChange: what it touches', () => {
  it('finds the indexes, foreign keys, triggers and views that involve the column', () => {
    const { impact } = ok(plan({ column: 'status', change: { newType: 'varchar(40)' } }));
    expect(impact.indexes.map((i) => i.name)).toEqual(['orders_status_created']);
    expect(impact.triggers.map((t) => t.name)).toEqual(['orders_audit']);
    expect(impact.views).toEqual(['v_open_orders']);
    expect(impact.inPrimaryKey).toBe(false);
    const fk = ok(plan({ column: 'customer_id', change: { newType: 'bigint' } })).impact;
    expect(fk.outboundForeignKeys.map((f) => f.name)).toEqual(['orders_customer_fk']);
    expect(fk.views).toEqual([]);
  });

  it('warns about views and triggers, and a conversion that can lose data', () => {
    const p = ok(plan({ column: 'status', change: { newType: 'varchar(5)' } }));
    expect(p.warnings.join('\n')).toMatch(/v_open_orders/);
    expect(p.warnings.join('\n')).toMatch(/orders_audit/);
    expect(p.warnings.join('\n')).toMatch(/longer than 5 characters/);
  });
});

describe('planColumnChange: a rename alone', () => {
  it.each([
    ['postgres', 'ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";'],
    ['cockroachdb', 'ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";'],
    ['mysql', 'ALTER TABLE `shop`.`orders` RENAME COLUMN `status` TO `state`;'],
    ['tidb', 'ALTER TABLE `shop`.`orders` RENAME COLUMN `status` TO `state`;'],
    ['sqlserver', "EXEC sp_rename N'shop.orders.status', N'state', N'COLUMN';"],
  ])('is one in-place step on %s', (dialect, sql) => {
    const p = ok(plan({ dialect, column: 'status', change: { newName: 'state' } }));
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.sql).toBe(sql);
  });
});

describe('planColumnChange: a type change on PostgreSQL', () => {
  const p = plan({ column: 'status', change: { newName: 'state', newType: 'varchar(40)' } });

  it('lays out add, sync, copy, check, constraints, switch-over and drop, in that order', () => {
    expect(ok(p).steps.map((s) => s.title)).toEqual([
      'Add the new column state__new (varchar(40))',
      'Keep the new column in step while the copy runs',
      'Copy the data in batches of 500',
      'Check that every row was copied',
      'Give the new column the old one’s constraints and indexes',
      'Switch over',
      'Drop the old column status__old',
    ]);
  });

  it('copies in key order, only rows not yet copied, so a rerun picks up where it stopped', () => {
    expect(sqlOf(p, /^Copy/)).toBe(
      'UPDATE "shop"."orders" SET "state__new" = CAST("status" AS varchar(40))\n' +
        'WHERE ("id") IN (\n' +
        '  SELECT "id" FROM "shop"."orders"\n' +
        '  WHERE "state__new" IS NULL AND "status" IS NOT NULL\n' +
        '  ORDER BY "id" LIMIT 500\n' +
        ');'
    );
  });

  it('carries NOT NULL and rebuilds the index on the new column, and drops the default when the type changes', () => {
    const sql = sqlOf(p, /constraints/);
    expect(sql).toContain('ALTER TABLE "shop"."orders" ALTER COLUMN "state__new" SET NOT NULL;');
    expect(sql).toContain('CREATE INDEX "orders_status_created__new" ON "shop"."orders" ("state__new", "created_at");');
    expect(sql).not.toContain('SET DEFAULT');
  });

  it('renames both columns in one transaction, after dropping the sync trigger', () => {
    expect(sqlOf(p, /^Switch/)).toBe(
      [
        'BEGIN;',
        'DROP TRIGGER IF EXISTS "fox_sync_orders_status" ON "shop"."orders";',
        'ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "status__old";',
        'ALTER TABLE "shop"."orders" RENAME COLUMN "state__new" TO "state";',
        'COMMIT;',
      ].join('\n')
    );
  });

  it('drops the old column last and gives the new index the old name', () => {
    const sql = sqlOf(p, /^Drop the old/);
    expect(sql.split('\n')[0]).toBe('ALTER TABLE "shop"."orders" DROP COLUMN "status__old";');
    expect(sql).toContain('ALTER INDEX "shop"."orders_status_created__new" RENAME TO "orders_status_created";');
  });

  it('recreates an outbound foreign key on the new column', () => {
    const fk = plan({ column: 'customer_id', change: { newType: 'bigint' } });
    expect(sqlOf(fk, /constraints/)).toContain(
      'ALTER TABLE "shop"."orders" ADD CONSTRAINT "orders_customer_fk__new" FOREIGN KEY ("customer_id__new") REFERENCES "customers" ("id");'
    );
    expect(sqlOf(fk, /^Drop the old/)).toContain('RENAME CONSTRAINT "orders_customer_fk__new" TO "orders_customer_fk";');
  });

  it('keeps the default when only the name changes through a rebuild, and NOT NULL either way', () => {
    const same = plan({ column: 'status', change: { newType: 'text' } });
    expect(sqlOf(same, /constraints/)).not.toContain('SET DEFAULT');
  });
});

describe('planColumnChange: engines without triggers', () => {
  it.each(['cockroachdb', 'tidb'])('%s has no sync step, and says to run the copy again before the switch', (dialect) => {
    const p = ok(plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.steps.some((s) => /Keep the new column in step/.test(s.title))).toBe(false);
    expect(p.warnings.join('\n')).toMatch(/no triggers/);
    expect(p.steps.find((s) => /^Copy/.test(s.title))?.note).toMatch(/run it once more just before the switch-over/);
  });
});

describe('planColumnChange: MySQL', () => {
  const p = plan({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' } });

  it('copies with UPDATE … LIMIT and renames both columns in one ALTER', () => {
    expect(sqlOf(p, /^Copy/)).toBe(
      'UPDATE `shop`.`orders` SET `status__new` = `status`\nWHERE `status__new` IS NULL AND `status` IS NOT NULL\nLIMIT 500;'
    );
    expect(sqlOf(p, /^Switch/)).toContain(
      'ALTER TABLE `shop`.`orders` RENAME COLUMN `status` TO `status__old`, RENAME COLUMN `status__new` TO `status`;'
    );
  });

  it('drops the old index by name before the column, since MySQL would shrink it instead', () => {
    const lines = sqlOf(p, /^Drop the old/).split('\n');
    expect(lines.indexOf('DROP INDEX `orders_status_created` ON `shop`.`orders`;')).toBeLessThan(
      lines.indexOf('ALTER TABLE `shop`.`orders` DROP COLUMN `status__old`;')
    );
  });

  it('drops a foreign key before the indexes it needs', () => {
    // Widening a smallint key column to the parent's integer: the one type change MySQL allows on it.
    const narrow = {
      ...orders,
      columns: orders.columns.map((c) => (c.name === 'customer_id' ? { ...c, type: 'smallint' } : c)),
    };
    const fk = plan({ dialect: 'mysql', table: narrow, tables: [customers, narrow], column: 'customer_id', change: { newType: 'integer' } });
    expect(sqlOf(fk, /^Drop the old/).split('\n')[0]).toBe('ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `orders_customer_fk`;');
  });
});

describe('planColumnChange: SQL Server', () => {
  const p = plan({ dialect: 'sqlserver', column: 'status', change: { newType: 'nvarchar(40)' } });

  it('copies with UPDATE TOP, and renames through sp_rename in one batch and one transaction', () => {
    expect(sqlOf(p, /^Copy/)).toBe(
      'UPDATE TOP (500) [shop].[orders] SET [status__new] = CAST([status] AS nvarchar(40))\nWHERE [status__new] IS NULL AND [status] IS NOT NULL;'
    );
    expect(sqlOf(p, /^Switch/)).toBe(
      [
        'SET XACT_ABORT ON',
        'BEGIN TRANSACTION',
        '  DROP TRIGGER IF EXISTS [shop].[fox_sync_orders_status]',
        "  EXEC sp_rename N'shop.orders.status', N'status__old', N'COLUMN'",
        "  EXEC sp_rename N'shop.orders.status__new', N'status', N'COLUMN'",
        'COMMIT TRANSACTION;',
      ].join('\n')
    );
  });

  it('drops the default constraint by looking up its name before dropping the column', () => {
    const sql = sqlOf(p, /^Drop the old/);
    expect(sql).toMatch(/sys\.default_constraints[\s\S]*SET @sql = N'ALTER TABLE \[shop\]\.\[orders\] DROP CONSTRAINT ' \+ QUOTENAME\(@df\) EXEC sp_executesql @sql END;/);
    expect(sql).not.toMatch(/EXEC\(/);
    expect(sql.indexOf('sys.default_constraints')).toBeLessThan(sql.indexOf('DROP COLUMN [status__old]'));
  });

  it('uses dbo when no schema is given', () => {
    const noSchema = planColumnChange({ dialect: 'sqlserver', table: orders, tables: ALL, column: 'status', change: { newName: 'state' } });
    expect(ok(noSchema).steps[0]!.sql).toBe("EXEC sp_rename N'dbo.orders.status', N'state', N'COLUMN';");
  });
});

describe('planColumnChange: foreign key types', () => {
  it.each(['mysql', 'tidb', 'sqlserver'])('refuses on %s when the referenced column would keep another type', (dialect) => {
    const p = plan({ dialect, column: 'customer_id', change: { newType: 'bigint' } });
    expect(!p.ok && p.error).toMatch(/foreign key to customers\.id \(integer\)[\s\S]*same type/);
  });

  it('allows it on PostgreSQL, which only needs comparable types', () => {
    expect(plan({ column: 'customer_id', change: { newType: 'bigint' } }).ok).toBe(true);
  });

  it('allows a type that matches the referenced column', () => {
    const narrow = {
      ...orders,
      columns: orders.columns.map((c) => (c.name === 'customer_id' ? { ...c, type: 'smallint' } : c)),
    };
    expect(planColumnChange({ dialect: 'mysql', table: narrow, tables: [customers, narrow], column: 'customer_id', change: { newType: 'INTEGER' } }).ok).toBe(true);
  });
});

describe('planColumnChange: the steps split into the statements meant', () => {
  // Open in editor runs each statement on its own; a step must not split where it should not.
  it.each([
    ['postgres', /Keep the new column/, 3],
    ['postgres', /^Switch/, 5],
    ['sqlserver', /Keep the new column/, 1],
    ['sqlserver', /^Switch/, 1],
    ['mysql', /Keep the new column/, 2],
  ])('%s %s is %i statement(s)', (dialect, title, count) => {
    const p = plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } });
    expect(splitSqlStatements(sqlOf(p, title))).toHaveLength(count);
  });

  it('SQL Server drop step is one statement per line, the default lookup included', () => {
    const sql = sqlOf(plan({ dialect: 'sqlserver', column: 'status', change: { newType: 'varchar(40)' } }), /^Drop the old/);
    expect(splitSqlStatements(sql)).toHaveLength(sql.split('\n').length);
  });
});

describe('lossyConversion', () => {
  it.each([
    ['varchar(100)', 'varchar(20)', /longer than 20/],
    ['text', 'varchar(50)', /longer than 50/],
    ['varchar(20)', 'integer', /not a valid integer/],
    ['bigint', 'int', /range/],
    ['double precision', 'integer', /rounded/],
    ['numeric(10,2)', 'numeric(10,0)', /decimal places/],
    ['numeric(10,2)', 'numeric(6,2)', /before the decimal point/],
    ['timestamptz', 'timestamp', /time zone/],
    ['timestamp', 'date', /time of day/],
    ['integer', 'boolean', /true or false/],
  ])('%s → %s can lose data', (from, to, reason) => {
    expect(lossyConversion(from, to)).toMatch(reason);
  });

  it.each([
    ['varchar(20)', 'varchar(40)'],
    ['int', 'bigint'],
    ['integer', 'numeric(12,2)'],
    ['date', 'timestamp'],
    ['timestamp', 'timestamptz'],
    ['integer', 'text'],
  ])('%s → %s is safe', (from, to) => {
    expect(lossyConversion(from, to)).toBeUndefined();
  });
});
