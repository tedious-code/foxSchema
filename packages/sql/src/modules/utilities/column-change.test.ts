/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import { splitSqlStatements } from '../sql-text/sql-splitter.js';
import { columnReferenceLines, lossyConversion, planColumnChange } from './column-change.js';
import { COLUMN_CHANGE_MAP } from './column-change.registry.js';
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
const statusFn = table('orders_status_label', {
  objectType: 'FUNCTION',
  definition: 'CREATE FUNCTION orders_status_label(oid int) RETURNS text AS $$ SELECT status FROM orders WHERE id = oid $$',
});
const statusProc = table('bump_order_status', {
  objectType: 'PROCEDURE',
  definition: 'CREATE PROCEDURE bump_order_status(oid int) AS $$ UPDATE orders SET status = \'done\' WHERE id = oid $$',
});
const ALL = [customers, products, orders, orderItems, openOrders, statusFn, statusProc];

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
  it('finds the indexes, foreign keys, triggers, views, functions and procedures that involve the column', () => {
    const { impact } = ok(plan({ column: 'status', change: { newType: 'varchar(40)' } }));
    expect(impact.indexes.map((i) => i.name)).toEqual(['orders_status_created']);
    expect(impact.triggers.map((t) => t.name)).toEqual(['orders_audit']);
    expect(impact.views).toEqual(['v_open_orders']);
    expect(impact.functions).toEqual(['orders_status_label']);
    expect(impact.procedures).toEqual(['bump_order_status']);
    expect(impact.inPrimaryKey).toBe(false);
    const fk = ok(plan({ column: 'customer_id', change: { newType: 'bigint' } })).impact;
    expect(fk.outboundForeignKeys.map((f) => f.name)).toEqual(['orders_customer_fk']);
    expect(fk.views).toEqual([]);
  });

  it('warns about views and triggers, and a conversion that can lose data', () => {
    const p = ok(plan({ column: 'status', change: { newType: 'varchar(5)' } }));
    expect(p.warnings.join('\n')).toMatch(/v_open_orders/);
    expect(p.warnings.join('\n')).toMatch(/orders_audit/);
    expect(p.warnings.join('\n')).toMatch(/orders_status_label/);
    expect(p.warnings.join('\n')).toMatch(/bump_order_status/);
    expect(p.impact.lossy).toMatch(/Narrowing varchar\(20\) to varchar\(5\)/);
    expect(p.impact.lossy).toMatch(/longer than 5 characters/);
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

  it('lays out add, sync, copy, check, constraints, switch-over, drop and triggers, in that order', () => {
    expect(ok(p).steps.map((s) => s.title)).toEqual([
      'Add the new column state__new (varchar(40))',
      'Keep the new column in step while the copy runs',
      'Copy the data in batches of 500',
      'Check that every row was copied',
      'Give the new column the old one’s constraints and indexes',
      'Switch over',
      'Drop the old column status__old',
      'Recreate table triggers that name the column',
    ]);
    expect(ok(p).steps.map((s) => s.phase)).toEqual([
      'add',
      'copy',
      'copy',
      'copy',
      'finish',
      'finish',
      'finish',
      'finish',
    ]);
  });

  it('copies a column comment onto the new column from the catalog', () => {
    expect(sqlOf(p, /constraints/)).toContain('COMMENT ON COLUMN');
    expect(sqlOf(p, /constraints/)).toContain('pg_description');
  });

  it('gives COUNT SQL and a one-batch patch for copy progress', () => {
    expect(ok(p).progress?.totalSql).toBe('SELECT COUNT(*) AS n FROM "shop"."orders";');
    expect(ok(p).progress?.remainingSql).toContain('"state__new" IS NULL');
    expect(ok(p).progress?.patchSql).toBe(
      'UPDATE "shop"."orders" SET "state__new" = CAST("status" AS varchar(40))\n' +
        'WHERE ("id") IN (\n' +
        '  SELECT "id" FROM "shop"."orders"\n' +
        '  WHERE "state__new" IS NULL AND "status" IS NOT NULL\n' +
        '  ORDER BY "id" LIMIT 500\n' +
        ');'
    );
  });

  it('previews the copy as a plpgsql loop around that patch', () => {
    const sql = sqlOf(p, /^Copy/);
    expect(sql).toContain('DO $fox_copy$');
    expect(sql).toContain('LOOP');
    expect(sql).toContain('EXIT WHEN n = 0;');
    expect(sql).toContain('SET "state__new" = CAST("status" AS varchar(40))');
    expect(sql).toContain('ORDER BY "id" LIMIT 500');
    expect(splitSqlStatements(sql)).toHaveLength(1);
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
    expect(sqlOf(p, /^Copy/)).toContain('-- Repeat until this UPDATE changes 0 rows');
    expect(sqlOf(p, /^Copy/)).not.toContain('DO $fox_copy$');
    expect(sqlOf(p, /^Copy/)).not.toContain('CREATE PROCEDURE');
  });

  it('TiDB switches with two RENAME statements: one ALTER cannot rename both columns', () => {
    const sql = sqlOf(plan({ dialect: 'tidb', column: 'status', change: { newType: 'varchar(40)' } }), /^Switch/);
    expect(sql).toBe(
      [
        'ALTER TABLE `shop`.`orders` RENAME COLUMN `status` TO `status__old`;',
        'ALTER TABLE `shop`.`orders` RENAME COLUMN `status__new` TO `status`;',
      ].join('\n')
    );
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });
});

describe('planColumnChange: MySQL', () => {
  const p = plan({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' } });

  it('copies with a procedure loop around UPDATE … LIMIT, and renames both columns in one ALTER', () => {
    const sql = sqlOf(p, /^Copy/);
    expect(ok(p).progress?.patchSql).toBe(
      'UPDATE `shop`.`orders` SET `status__new` = `status`\nWHERE `status__new` IS NULL AND `status` IS NOT NULL\nLIMIT 500;'
    );
    expect(sql).toContain('CREATE PROCEDURE `fox_copy_orders_status`()');
    expect(sql).toContain('UNTIL ROW_COUNT() = 0 END REPEAT;');
    expect(sql).toContain('CALL `fox_copy_orders_status`();');
    expect(splitSqlStatements(sql)).toHaveLength(4);
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

  it('copies with a WHILE loop around UPDATE TOP, and renames through sp_rename in one batch and one transaction', () => {
    expect(ok(p).progress?.patchSql).toBe(
      'UPDATE TOP (500) [shop].[orders] SET [status__new] = CAST([status] AS nvarchar(40))\nWHERE [status__new] IS NULL AND [status] IS NOT NULL;'
    );
    const copy = sqlOf(p, /^Copy/);
    expect(copy).toContain('WHILE @fox_n > 0');
    expect(copy).toContain('SET @fox_n = @@ROWCOUNT');
    expect(splitSqlStatements(copy)).toHaveLength(1);
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
    ['varchar(100)', 'varchar(20)', /Narrowing varchar\(100\) to varchar\(20\).*longer than 20/],
    ['text', 'varchar(50)', /Narrowing text to varchar\(50\).*longer than 50/],
    ['varchar(20)', 'integer', /Converting text \(varchar\(20\)\) to a number \(integer\)/],
    ['nvarchar(40)', 'numeric(10,2)', /Converting text \(nvarchar\(40\)\) to a number/],
    ['varchar(20)', 'boolean', /Converting text \(varchar\(20\)\) to boolean/],
    ['text', 'bool', /true or false/],
    ['bigint', 'int', /Narrowing bigint to int.*range/],
    ['double precision', 'real', /Narrowing double precision to real.*precision/],
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
    ['real', 'double precision'],
  ])('%s → %s is safe', (from, to) => {
    expect(lossyConversion(from, to)).toBeUndefined();
  });
});

describe('planColumnChange: unique constraints and filtered indexes', () => {
  it('finds a unique constraint and a partial index whose predicate names the column', () => {
    const flags = table('flags', {
      columns: [col('id', 'integer', { primaryKey: true, nullable: false }), col('code', 'text')],
      primaryKey: { columns: ['id'] },
      indices: [
        { name: 'flags_code_key', columns: ['code'], unique: true, constraint: true },
        { name: 'flags_code_partial', columns: ['id'], unique: false, filter: 'code IS NOT NULL' },
      ],
    });
    const p = ok(planColumnChange({ dialect: 'postgres', table: flags, tables: [flags], column: 'code', change: { newName: 'flag' } }));
    expect(p.impact.indexes.map((i) => i.name).sort()).toEqual(['flags_code_key', 'flags_code_partial']);
  });
});

describe('planColumnChange: every registered dialect', () => {
  const dialects = Object.keys(COLUMN_CHANGE_MAP);

  it.each(dialects)('%s generates a rename script', (dialect) => {
    const p = ok(plan({ dialect, column: 'status', change: { newName: 'state' } }));
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.sql.trim().length).toBeGreaterThan(10);
    expect(splitSqlStatements(p.steps[0]!.sql).length).toBeGreaterThan(0);
  });

  it.each(dialects)('%s generates a type-change script with add, copy and finish SQL', (dialect) => {
    const p = ok(plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.steps.filter((s) => s.phase === 'add').length).toBeGreaterThan(0);
    expect(p.steps.filter((s) => s.phase === 'copy').length).toBeGreaterThan(0);
    expect(p.steps.filter((s) => s.phase === 'finish').length).toBeGreaterThan(0);
    for (const step of p.steps) {
      expect(step.sql.trim().length, `${dialect} ${step.title}`).toBeGreaterThan(0);
      expect(splitSqlStatements(step.sql).length, `${dialect} ${step.title} splits`).toBeGreaterThan(0);
    }
    expect(p.progress?.patchSql).toMatch(/UPDATE/i);
  });

  it.each(['oracle', 'sqlite', 'redshift', 'db2', 'clickhouse', 'duckdb'] as const)(
    '%s is refused as not yet',
    (dialect) => {
      const p = plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } });
      expect(p.ok).toBe(false);
      expect(!p.ok && p.error).toMatch(/not available/i);
    }
  );
});

describe('columnReferenceLines', () => {
  const def = [
    'CREATE VIEW v_open_orders AS',
    'SELECT o.id, o.status, c.name',
    'FROM orders o',
    "WHERE o.status = 'open'   -- status matters",
    '  AND o.statuses IS NULL',
  ].join('\n');

  it('gives the 1-based line, the text, and where the name sits', () => {
    const refs = columnReferenceLines(def, 'status');
    expect(refs.map((r) => r.line)).toEqual([2, 4]);
    expect(refs[0]!.text).toBe('SELECT o.id, o.status, c.name');
    expect(refs[0]!.matches).toEqual([{ start: 15, end: 21 }]);
    // Every occurrence on the line, so highlighting does not miss one.
    expect(refs[1]!.matches).toEqual([
      { start: 8, end: 14 },
      { start: 29, end: 35 },
    ]);
  });

  it('matches whole words only', () => {
    // `statuses` and `status_id` are different columns.
    const refs = columnReferenceLines('SELECT statuses, status_id, status FROM t', 'status');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.matches).toEqual([{ start: 28, end: 34 }]);
  });

  it('shows the line as it would read after the rename', () => {
    const refs = columnReferenceLines(def, 'status', 'order_status');
    expect(refs[0]!.renamed).toBe('SELECT o.id, o.order_status, c.name');
    // Two matches on one line, both replaced, offsets still correct.
    expect(refs[1]!.renamed).toBe("WHERE o.order_status = 'open'   -- order_status matters");
  });

  it('leaves `renamed` off when the name is not changing', () => {
    expect(columnReferenceLines(def, 'status')[0]!.renamed).toBeUndefined();
    expect(columnReferenceLines(def, 'status', 'status')[0]!.renamed).toBeUndefined();
  });

  it('handles CRLF, a missing definition and a name that needs escaping', () => {
    expect(columnReferenceLines('SELECT a\r\nFROM t WHERE a = 1', 'a').map((r) => r.line)).toEqual([1, 2]);
    expect(columnReferenceLines('', 'status')).toEqual([]);
    expect(columnReferenceLines('SELECT x FROM t', '')).toEqual([]);
    // A regex metacharacter in a column name must not become a pattern.
    expect(columnReferenceLines('SELECT "a.b" FROM t', 'a.b')).toHaveLength(1);
    expect(columnReferenceLines('SELECT axb FROM t', 'a.b')).toEqual([]);
  });

  it('trims trailing whitespace but keeps indentation', () => {
    const refs = columnReferenceLines('  SELECT status   ', 'status');
    expect(refs[0]!.text).toBe('  SELECT status');
  });
});

describe('impact.dependents', () => {
  it('carries the referencing lines for each view, routine and trigger', () => {
    const { impact } = ok(plan({ column: 'status', change: { newName: 'order_status' } }));
    const byName = new Map(impact.dependents.map((d) => [d.name, d]));

    // Same objects the name lists report, so the two cannot drift.
    expect([...byName.keys()].sort()).toEqual(
      [...impact.views, ...impact.functions, ...impact.procedures, ...impact.triggers.map((t) => t.name)].sort()
    );

    const view = byName.get('v_open_orders')!;
    expect(view.objectType).toBe('VIEW');
    expect(view.definition).toContain('FROM orders');
    expect(view.references.length).toBeGreaterThan(0);
    for (const r of view.references) {
      expect(r.text.toLowerCase()).toContain('status');
      expect(r.renamed).toContain('order_status');
    }

    const trigger = byName.get('orders_audit')!;
    expect(trigger.objectType).toBe('TRIGGER');
    expect(trigger.references[0]!.renamed).toContain('NEW.order_status');
  });

  it('is empty when nothing depends on the column', () => {
    const { impact } = ok(plan({ column: 'total', change: { newName: 'order_total' } }));
    expect(impact.dependents).toEqual([]);
  });

  it('still lists dependents for a type change, with no renamed line', () => {
    const { impact } = ok(plan({ column: 'status', change: { newType: 'varchar(40)' } }));
    expect(impact.dependents.length).toBeGreaterThan(0);
    for (const d of impact.dependents) for (const r of d.references) expect(r.renamed).toBeUndefined();
  });
});
