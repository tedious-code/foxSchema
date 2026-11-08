/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import { splitSqlStatements } from '../sql-text/sql-splitter.js';
import { columnReferenceLines, largeTableNote, lossyConversion, planColumnChange } from './column-change.js';
import { COLUMN_CHANGE_MAP, columnChangeLargeTable } from './column-change.registry.js';
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
/** The same, in large-table mode: new column, batched copy, switch-over. */
const large = (over: Parameters<typeof plan>[0]): ColumnChangePlan => plan({ largeTable: true, ...over });

const ok = (p: ColumnChangePlan) => {
  if (!p.ok) throw new Error(p.error);
  return p;
};
const sqlOf = (p: ColumnChangePlan, title: RegExp) => ok(p).steps.find((s) => title.test(s.title))?.sql ?? '';

describe('planColumnChange: what it refuses', () => {
  it.each([
    ['an engine without the plan yet', { dialect: 'mongodb', column: 'status', change: { newType: 'text' } }, /not available for MongoDB yet/],
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

  it('needs a primary key only to copy in batches: a direct change and a rename go ahead without one', () => {
    const copied = planColumnChange({ dialect: 'postgres', table: orderItems, tables: ALL, column: 'sku', change: { newType: 'text' }, largeTable: true });
    expect(!copied.ok && copied.error).toMatch(/needs a primary key/);
    const direct = planColumnChange({ dialect: 'postgres', table: orderItems, tables: ALL, column: 'sku', change: { newType: 'text' } });
    expect(direct.ok).toBe(true);
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
  const p = large({ column: 'status', change: { newName: 'state', newType: 'varchar(40)' } });

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
    const fk = large({ column: 'customer_id', change: { newType: 'bigint' } });
    expect(sqlOf(fk, /constraints/)).toContain(
      'ALTER TABLE "shop"."orders" ADD CONSTRAINT "orders_customer_fk__new" FOREIGN KEY ("customer_id__new") REFERENCES "customers" ("id");'
    );
    expect(sqlOf(fk, /^Drop the old/)).toContain('RENAME CONSTRAINT "orders_customer_fk__new" TO "orders_customer_fk";');
  });

  it('keeps the default when only the name changes through a rebuild, and NOT NULL either way', () => {
    const same = large({ column: 'status', change: { newType: 'text' } });
    expect(sqlOf(same, /constraints/)).not.toContain('SET DEFAULT');
  });
});

describe('planColumnChange: engines without triggers', () => {
  it.each(['cockroachdb', 'tidb'])('%s has no sync step, and says to run the copy again before the switch', (dialect) => {
    const p = ok(large({ dialect, column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.steps.some((s) => /Keep the new column in step/.test(s.title))).toBe(false);
    expect(p.warnings.join('\n')).toMatch(/no triggers/);
    expect(p.steps.find((s) => /^Copy/.test(s.title))?.note).toMatch(/run it once more just before the switch-over/);
    expect(sqlOf(p, /^Copy/)).toContain('-- Repeat until this UPDATE changes 0 rows');
    expect(sqlOf(p, /^Copy/)).not.toContain('DO $fox_copy$');
    expect(sqlOf(p, /^Copy/)).not.toContain('CREATE PROCEDURE');
  });

  it('TiDB switches with two RENAME statements: one ALTER cannot rename both columns', () => {
    const sql = sqlOf(large({ dialect: 'tidb', column: 'status', change: { newType: 'varchar(40)' } }), /^Switch/);
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
  const p = large({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' } });

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
    const fk = large({ dialect: 'mysql', table: narrow, tables: [customers, narrow], column: 'customer_id', change: { newType: 'integer' } });
    expect(sqlOf(fk, /^Drop the old/).split('\n')[0]).toBe('ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `orders_customer_fk`;');
  });
});

describe('planColumnChange: SQL Server', () => {
  const p = large({ dialect: 'sqlserver', column: 'status', change: { newType: 'nvarchar(40)' } });

  it('copies with a WHILE loop around UPDATE TOP, and renames through sp_rename in one batch and one transaction', () => {
    expect(ok(p).progress?.patchSql).toBe(
      'UPDATE TOP (500) [shop].[orders] SET [status__new] = CAST([status] AS nvarchar(40))\nWHERE [status__new] IS NULL AND [status] IS NOT NULL;'
    );
    const copy = sqlOf(p, /^Copy/);
    expect(copy).toContain('WHILE @fox_n > 0');
    expect(copy).toContain('SET @fox_n = @@ROWCOUNT');
    expect(splitSqlStatements(copy)).toHaveLength(1);
    const lines = sqlOf(p, /^Switch/).split('\n');
    expect(lines.slice(0, 3)).toEqual(['SET XACT_ABORT ON', 'BEGIN TRANSACTION', '  DROP TRIGGER IF EXISTS [shop].[fox_sync_orders_status]']);
    expect(lines).toContain("  EXEC sp_rename N'shop.orders.status', N'status__old', N'COLUMN'");
    expect(lines).toContain("  EXEC sp_rename N'shop.orders.status__new', N'status', N'COLUMN'");
    expect(lines.at(-1)).toBe('COMMIT TRANSACTION;');
    expect(splitSqlStatements(sqlOf(p, /^Switch/))).toHaveLength(1);
  });

  it('drops the default constraint by looking up its name before dropping the column', () => {
    const sql = sqlOf(p, /^Drop the old/);
    expect(sql).toMatch(/sys\.default_constraints[\s\S]*SET @sql = N'ALTER TABLE \[shop\]\.\[orders\] DROP CONSTRAINT ' \+ QUOTENAME\(@df\) EXEC sp_executesql @sql END\n/);
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
    const p = large({ dialect, column: 'status', change: { newType: 'varchar(40)' } });
    expect(splitSqlStatements(sqlOf(p, title))).toHaveLength(count);
  });

  it('SQL Server drop step is one batch in one transaction, so its index list lives through it', () => {
    const sql = sqlOf(large({ dialect: 'sqlserver', column: 'status', change: { newType: 'varchar(40)' } }), /^Drop the old/);
    expect(splitSqlStatements(sql)).toHaveLength(1);
    expect(sql.startsWith('SET XACT_ABORT ON\nBEGIN TRANSACTION\n')).toBe(true);
    expect(sql.endsWith('COMMIT TRANSACTION;')).toBe(true);
  });

  it('SQL Server large-table mode scripts its indexes from the catalog, on the new column and back', () => {
    // Recreating from Fox's model lost a filtered index's filter (found live).
    const p = large({ dialect: 'sqlserver', column: 'status', change: { newType: 'varchar(40)' } });
    const constraints = sqlOf(p, /^Give the new column/);
    expect(constraints).toContain("REPLACE(QUOTENAME(c.name), QUOTENAME(N'status'), QUOTENAME(N'status__new'))");
    expect(constraints).toContain("REPLACE(i.filter_definition, QUOTENAME(N'status'), QUOTENAME(N'status__new'))");
    expect(constraints).toContain("QUOTENAME(i.name + N'__new')");
    expect(constraints).toMatch(/WHILE[^\n]*create_sql/);
    expect(constraints).not.toContain('CREATE INDEX [orders_status_created__new]');
    const drop = sqlOf(p, /^Drop the old/);
    expect(drop).toContain("c.name = N'status__old')");
    const at = (needle: string | RegExp) => (typeof needle === 'string' ? drop.indexOf(needle) : drop.search(needle));
    expect(at(/WHILE[^\n]*drop_sql/)).toBeLessThan(at('DROP COLUMN [status__old]'));
    expect(at('DROP COLUMN [status__old]')).toBeLessThan(at(/WHILE[^\n]*rename_sql/));
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

  // DuckDB refuses a table with an index, as `orders` has; it has tests of its own.
  it.each(dialects.filter((d) => d !== 'duckdb'))('%s generates a rename script', (dialect) => {
    const p = ok(plan({ dialect, column: 'status', change: { newName: 'state' } }));
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.sql.trim().length).toBeGreaterThan(10);
    expect(splitSqlStatements(p.steps[0]!.sql).length).toBeGreaterThan(0);
  });

  it.each(dialects.filter(columnChangeLargeTable))('%s generates a type-change script with add, copy and finish SQL', (dialect) => {
    const p = ok(large({ dialect, column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.steps.filter((s) => s.phase === 'add').length).toBeGreaterThan(0);
    expect(p.steps.filter((s) => s.phase === 'copy').length).toBeGreaterThan(0);
    expect(p.steps.filter((s) => s.phase === 'finish').length).toBeGreaterThan(0);
    for (const step of p.steps) {
      expect(step.sql.trim().length, `${dialect} ${step.title}`).toBeGreaterThan(0);
      expect(splitSqlStatements(step.sql).length, `${dialect} ${step.title} splits`).toBeGreaterThan(0);
    }
    expect(p.progress?.patchSql).toMatch(/UPDATE/i);
  });

  it.each(['mongodb', 'redis'] as const)('%s is refused as not yet', (dialect) => {
    const p = plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/not available/i);
  });

  it('offers large-table mode on the engines that have it, and refuses it elsewhere', () => {
    expect(dialects.filter(columnChangeLargeTable).sort()).toEqual(
      ['azuresql', 'cockroachdb', 'mariadb', 'mysql', 'postgres', 'sqlserver', 'tidb', 'yugabytedb']
    );
    const p = plan({ dialect: 'oracle', column: 'status', change: { newType: 'varchar2(40)' }, largeTable: true });
    expect(!p.ok && p.error).toMatch(/Large-table mode is not available for Oracle/);
  });
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

  it('quotes a new name that needs it, the way the dialect does', () => {
    // The plan's own ALTER quotes `order status`; the line we show has to too,
    // or it is invalid SQL presented as what the view needs to say.
    expect(columnReferenceLines('SELECT status FROM t', 'status', 'order status', 'postgres')[0]!.renamed).toBe(
      'SELECT "order status" FROM t'
    );
    expect(columnReferenceLines('SELECT status FROM t', 'status', 'order status', 'mysql')[0]!.renamed).toBe(
      'SELECT `order status` FROM t'
    );
    expect(columnReferenceLines('SELECT status FROM t', 'status', 'order status', 'mssql')[0]!.renamed).toBe(
      'SELECT [order status] FROM t'
    );
  });

  it('leaves an ordinary rename exactly as it reads', () => {
    // A plain name needs no quotes in any dialect, so nothing moves.
    for (const dialect of ['postgres', 'mysql', 'mssql', 'oracle']) {
      expect(columnReferenceLines('SELECT status FROM t', 'status', 'order_status', dialect)[0]!.renamed).toBe(
        'SELECT order_status FROM t'
      );
    }
  });

  it('does not quote twice where the definition already quotes the name', () => {
    const quoted = (definition: string, dialect: string) =>
      columnReferenceLines(definition, 'status', 'order status', dialect)[0]!.renamed;
    expect(quoted('SELECT "status" FROM t', 'postgres')).toBe('SELECT "order status" FROM t');
    expect(quoted('SELECT `status` FROM t', 'mysql')).toBe('SELECT `order status` FROM t');
    expect(quoted('SELECT [status] FROM t', 'mssql')).toBe('SELECT [order status] FROM t');
    // The quote character the definition used, inside the new name, is escaped.
    expect(columnReferenceLines('SELECT "status" FROM t', 'status', 'or"der', 'postgres')[0]!.renamed).toBe(
      'SELECT "or""der" FROM t'
    );
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

  it('quotes the new name in the dependent lines the way the plan does', () => {
    for (const [dialect, expected] of [
      ['postgres', 'SELECT id, "order status" FROM orders WHERE "order status" <> \'done\''],
      ['mysql', 'SELECT id, `order status` FROM orders WHERE `order status` <> \'done\''],
    ] as const) {
      const { impact, steps } = ok(plan({ dialect, column: 'status', change: { newName: 'order status' } }));
      const view = impact.dependents.find((d) => d.name === 'v_open_orders')!;
      expect(view.references[0]!.renamed).toBe(expected);
      // The same quoting the engine's own rename step uses.
      expect(steps[0]!.sql).toContain(expected.includes('`') ? '`order status`' : '"order status"');
    }
  });

  it('is empty when nothing depends on the column', () => {
    const { impact } = ok(plan({ column: 'total', change: { newName: 'order_total' } }));
    expect(impact.dependents).toEqual([]);
  });

  it('lists no lines for a type change alone: the one-line warnings name the objects', () => {
    for (const largeTable of [false, true]) {
      const p = ok(plan({ column: 'status', change: { newType: 'varchar(40)' }, largeTable }));
      expect(p.impact.dependents).toEqual([]);
      expect(p.impact.functions).toEqual(['orders_status_label']);
      expect(p.impact.procedures).toEqual(['bump_order_status']);
      expect(p.warnings.join('\n')).toMatch(/Functions that may use the column: orders_status_label/);
      expect(p.warnings.join('\n')).toMatch(/Procedures that may use the column: bump_order_status/);
    }
  });

  it('lists the lines when a type change renames too', () => {
    const { impact } = ok(plan({ column: 'status', change: { newName: 'state', newType: 'varchar(40)' } }));
    expect(impact.dependents.map((d) => d.name)).toContain('orders_status_label');
    expect(impact.dependents.every((d) => d.references.every((r) => r.renamed !== undefined))).toBe(true);
  });
});

describe('planColumnChange: a direct type change (the default)', () => {
  it('is one in-place step by default, with no copy and no progress', () => {
    const p = ok(plan({ column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.mode).toBe('direct');
    expect(p.progress).toBeUndefined();
    expect(p.steps.map((s) => s.phase)).toEqual(['add']);
    expect(p.steps[0]!.sql).toBe(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE varchar(40);'
    );
    expect(p.steps[0]!.note).toMatch(/default \('new'\) is converted too/);
  });

  it('spells out USING only when the kind of type changes', () => {
    // An explicit USING made CockroachDB rewrite an indexed column it would
    // otherwise only relabel, and refuse (found live).
    expect(ok(plan({ column: 'total', change: { newType: 'numeric(14,2)' } })).steps[0]!.sql).toBe(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "total" TYPE numeric(14,2);'
    );
    expect(ok(plan({ column: 'customer_id', change: { newType: 'bigint' } })).steps[0]!.sql).toBe(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "customer_id" TYPE bigint;'
    );
    expect(ok(plan({ column: 'status', change: { newType: 'integer' } })).steps[0]!.sql).toBe(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE integer USING "status"::integer;'
    );
    expect(ok(plan({ dialect: 'cockroachdb', column: 'status', change: { newType: 'varchar(40)' } })).steps[0]!.sql).not.toContain('USING');
  });

  it('names the mode of each kind of change', () => {
    expect(ok(plan({ column: 'status', change: { newName: 'state' } })).mode).toBe('rename');
    expect(ok(plan({ column: 'status', change: { newType: 'text' }, largeTable: true })).mode).toBe('copy');
  });

  it('changes the type, then renames, when both change', () => {
    const p = ok(plan({ column: 'status', change: { newName: 'state', newType: 'varchar(40)' } }));
    expect(p.steps.map((s) => s.title)).toEqual(['Change status to varchar(40)', 'Rename status to state']);
  });

  it('turns on CockroachDB’s general type change first', () => {
    const sql = ok(plan({ dialect: 'cockroachdb', column: 'status', change: { newType: 'text' } })).steps[0]!.sql;
    expect(sql.split('\n')[0]).toBe('SET enable_experimental_alter_column_type_general = true;');
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('says PostgreSQL refuses while a view uses the column, in place of the plain view warning', () => {
    const pg = ok(plan({ column: 'status', change: { newType: 'varchar(40)' } })).warnings.join('\n');
    expect(pg).toMatch(/PostgreSQL refuses to change the type of a column a view uses\. If v_open_orders uses it, drop it first/);
    expect(pg).not.toMatch(/Views that may use the column/);
    // MySQL resolves a view when it is read, so the plain warning stays.
    const my = ok(plan({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' } })).warnings.join('\n');
    expect(my).toMatch(/Views that may use the column: v_open_orders/);
    // Large-table mode keeps its own warnings.
    expect(ok(large({ column: 'status', change: { newType: 'varchar(40)' } })).warnings.join('\n')).toMatch(/Views that may use/);
  });

  it('refuses an identity column, and needs no primary key', () => {
    const ident = table('t', { columns: [col('n', 'integer', { identity: true })] });
    const p = planColumnChange({ dialect: 'postgres', table: ident, tables: [ident], column: 'n', change: { newType: 'bigint' } });
    expect(!p.ok && p.error).toMatch(/identity column is not covered yet/);
  });

  it('still refuses a foreign key whose other side would not match', () => {
    const p = plan({ dialect: 'mysql', column: 'customer_id', change: { newType: 'bigint' } });
    expect(!p.ok && p.error).toMatch(/both sides of a foreign key/);
  });
});

describe('planColumnChange: the size warning', () => {
  const sized = (estimatedRows?: number | null, sizeBytes?: number | null, largeTable = false) =>
    ok(plan({ column: 'status', change: { newType: 'varchar(40)' }, estimatedRows, sizeBytes, largeTable })).warnings.join('\n');

  it('warns on a table of a million rows or a gigabyte, and points at large-table mode', () => {
    expect(sized(2_500_000, 300 * 1024 ** 2)).toMatch(/orders is large \(about 2\.5 million rows, 0\.3 GB\)\..*large-table mode/);
    expect(sized(null, 3 * 1024 ** 3)).toMatch(/orders is large \(3\.0 GB\)/);
  });

  it('says nothing on a small table, an unknown size, or in large-table mode', () => {
    expect(sized(999_999, 10 * 1024 ** 2)).not.toMatch(/is large/);
    expect(sized(undefined, undefined)).not.toMatch(/is large/);
    expect(sized(5_000_000, null, true)).not.toMatch(/is large/);
  });

  it('largeTableNote reads billions and terabytes', () => {
    expect(largeTableNote('t', 3_200_000_000, 2 * 1024 ** 4)).toMatch(/about 3\.2 billion rows, 2\.0 TB/);
    expect(largeTableNote('t', 10, 10)).toBeUndefined();
  });
});

describe('planColumnChange: a direct type change on MySQL', () => {
  const sqlFor = (over: Partial<ColumnChangeInput> = {}) =>
    ok(plan({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' }, ...over })).steps[0]!.sql;

  it('restates NOT NULL and the default, and keeps the comment read from the catalog', () => {
    const sql = sqlFor();
    expect(sql).toContain(
      "SET @fox_col_sql = CONCAT('ALTER TABLE `shop`.`orders` MODIFY COLUMN `status` varchar(40) NOT NULL DEFAULT ''new'' COMMENT ', QUOTE(IFNULL(@fox_col_comment, '')));"
    );
    expect(sql).toContain("COLUMN_NAME = 'status'");
    expect(splitSqlStatements(sql)).toHaveLength(5);
  });

  it('restates a collation only on a character type', () => {
    const collated = table('orders', {
      columns: [col('id', 'int', { primaryKey: true }), col('code', 'varchar(10)', { collation: 'utf8mb4_bin' })],
      primaryKey: { columns: ['id'] },
    });
    const sqlOf2 = (newType: string) =>
      ok(planColumnChange({ dialect: 'mysql', table: collated, tables: [collated], column: 'code', change: { newType } })).steps[0]!.sql;
    expect(sqlOf2('varchar(20)')).toContain('varchar(20) NULL COLLATE utf8mb4_bin COMMENT');
    expect(sqlOf2('int')).toContain('MODIFY COLUMN `code` int NULL COMMENT');
  });

  it('still keeps the comment on the new column in large-table mode', () => {
    const sql = ok(large({ dialect: 'mysql', column: 'status', change: { newType: 'varchar(40)' } })).steps.map((s) => s.sql).join('\n');
    expect(sql).toContain("CONCAT('ALTER TABLE `shop`.`orders` MODIFY COLUMN `status__new` varchar(40) NULL COMMENT ', QUOTE(");
  });
});

describe('planColumnChange: a direct type change on SQL Server', () => {
  const stepSql = (over: Partial<ColumnChangeInput> & Pick<ColumnChangeInput, 'column' | 'change'>) =>
    ok(plan({ dialect: 'sqlserver', ...over })).steps[0]!.sql;
  const lines = (sql: string) => sql.split('\n').map((l) => l.trim());

  it('is one batch in one transaction, so a failure undoes the drops too', () => {
    const sql = stepSql({ column: 'total', change: { newType: 'decimal(14,2)' } });
    expect(lines(sql)[0]).toBe('SET XACT_ABORT ON');
    expect(lines(sql)[1]).toBe('BEGIN TRANSACTION');
    expect(lines(sql).at(-1)).toBe('COMMIT TRANSACTION;');
    expect(lines(sql)).toContain('ALTER TABLE [shop].[orders] ALTER COLUMN [total] decimal(14,2) NULL');
    // One statement, so drivers send it as one batch and the transaction holds.
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('scripts the indexes from the catalog as it runs, filters, includes and sort order with them', () => {
    // Fox's index model has no filter or included columns: recreating from it
    // turned a filtered unique index into an unfiltered one (found live).
    const sql = stepSql({ column: 'total', change: { newType: 'decimal(14,2)' } });
    expect(sql).toContain('DECLARE @fox_ix TABLE');
    expect(sql).toContain("ISNULL(N' WHERE ' + i.filter_definition, N'')");
    expect(sql).toContain("ISNULL(N' INCLUDE (' + inc.cols + N')', N'')");
    expect(sql).toContain("CASE WHEN ic.is_descending_key = 1 THEN N' DESC'");
    // Any index naming the column, key or included: an INCLUDE-only one blocks the ALTER too.
    expect(sql).toMatch(/AND \(EXISTS \(SELECT 1 FROM sys\.index_columns AS ic[\s\S]*c\.name = N'total'\)/);
  });

  it('drops the indexes, then the default, changes the column, and puts them back in reverse', () => {
    const all = lines(stepSql({ column: 'status', change: { newType: 'nvarchar(40)' } }));
    const at = (re: RegExp) => all.findIndex((l) => re.test(l));
    const dropIx = at(/^SET @fox_n = 1 WHILE .* drop_sql/);
    const dropDefault = at(/^DECLARE @df sysname.*c\.name = N'status'/);
    const alter = at(/^ALTER TABLE \[shop\]\.\[orders\] ALTER COLUMN \[status\] nvarchar\(40\) NOT NULL$/);
    const addDefault = at(/^ALTER TABLE \[shop\]\.\[orders\] ADD DEFAULT 'new' FOR \[status\]$/);
    const createIx = at(/^SET @fox_n = 1 WHILE .* create_sql/);
    expect([dropIx, dropDefault, alter, addDefault, createIx].every((i) => i > 0)).toBe(true);
    expect(dropIx < dropDefault && dropDefault < alter && alter < addDefault && addDefault < createIx).toBe(true);
  });

  it('drops a foreign key first and adds it back last', () => {
    const t = table('orders', {
      columns: [col('id', 'int', { primaryKey: true }), col('cid', 'int')],
      primaryKey: { columns: ['id'] },
      foreignKeys: [{ name: 'fk_cid', columns: ['cid'], referencedTable: 'customers', referencedColumns: ['id'] }],
    });
    const parent = table('customers', { columns: [col('id', 'bigint', { primaryKey: true })] });
    const all = lines(
      ok(
        planColumnChange({ dialect: 'sqlserver', schema: 'dbo', table: t, tables: [t, parent], column: 'cid', change: { newType: 'bigint' } })
      ).steps[0]!.sql
    );
    expect(all[2]).toBe('ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_cid]');
    expect(all.at(-2)).toBe(
      'ALTER TABLE [dbo].[orders] ADD CONSTRAINT [fk_cid] FOREIGN KEY ([cid]) REFERENCES [dbo].[customers] ([id])'
    );
  });

  it('restates a collation on a character type', () => {
    const t = table('orders', {
      columns: [col('id', 'int', { primaryKey: true }), col('code', 'varchar(10)', { collation: 'Latin1_General_BIN2' })],
      primaryKey: { columns: ['id'] },
    });
    const sql = ok(planColumnChange({ dialect: 'sqlserver', table: t, tables: [t], column: 'code', change: { newType: 'varchar(20)' } })).steps[0]!.sql;
    expect(sql).toContain('ALTER COLUMN [code] varchar(20) COLLATE Latin1_General_BIN2 NULL');
  });
});

describe('planColumnChange: every registered dialect, direct', () => {
  // SQLite has no in-place type change; its refusal has a test of its own.
  it.each(Object.keys(COLUMN_CHANGE_MAP).filter((d) => d !== 'sqlite' && d !== 'duckdb'))('%s changes a type in place, in SQL that splits', (dialect) => {
    const p = ok(plan({ dialect, column: 'status', change: { newType: 'varchar(40)' } }));
    expect(p.mode).toBe('direct');
    expect(p.steps.every((s) => s.phase === 'add')).toBe(true);
    for (const step of p.steps) expect(splitSqlStatements(step.sql).length, `${dialect} ${step.title}`).toBeGreaterThan(0);
  });
});

describe('planColumnChange: SQL Server filtered indexes in large-table mode', () => {
  // SQL Server will not rename a column a filter names (found live): the
  // switch-over failed with "one or more objects access this column".
  const p = large({ dialect: 'sqlserver', column: 'status', change: { newName: 'state', newType: 'varchar(40)' } });

  it('copies only unfiltered indexes ahead of the switch-over', () => {
    expect(sqlOf(p, /^Give the new column/)).toContain('AND i.has_filter = 0');
  });

  it('moves the filtered ones inside the switch-over: dropped before the renames, rebuilt on the new name after', () => {
    const sql = sqlOf(p, /^Switch/);
    expect(sql).toContain('AND i.has_filter = 1');
    expect(sql).toContain("REPLACE(i.filter_definition, QUOTENAME(N'status'), QUOTENAME(N'state'))");
    const dropAt = sql.search(/WHILE[^\n]*drop_sql/);
    const renameAt = sql.indexOf("EXEC sp_rename N'shop.orders.status', N'status__old', N'COLUMN'");
    const createAt = sql.search(/WHILE[^\n]*create_sql/);
    expect(dropAt).toBeGreaterThan(0);
    expect(dropAt < renameAt && renameAt < createAt).toBe(true);
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('counts an index whose filter names the column even when it does not index it', () => {
    expect(sqlOf(p, /^Switch/)).toContain("OR (i.has_filter = 1 AND CHARINDEX(QUOTENAME(N'status'), i.filter_definition) > 0)");
    const direct = ok(plan({ dialect: 'sqlserver', column: 'total', change: { newType: 'decimal(14,2)' } })).steps[0]!.sql;
    expect(direct).toContain("CHARINDEX(QUOTENAME(N'total'), i.filter_definition) > 0");
  });
});

describe('planColumnChange: engines that change in place only', () => {
  const step = (dialect: string, change: { newName?: string; newType?: string }, column = 'status', schema = 'shop') =>
    ok(plan({ dialect, schema, column, change })).steps;

  it('Oracle renames, and MODIFYs the type without restating NOT NULL', () => {
    expect(step('oracle', { newName: 'state' }).map((s) => s.sql)).toEqual([
      'ALTER TABLE "SHOP"."orders" RENAME COLUMN "status" TO "state";',
    ]);
    const typed = step('oracle', { newType: 'VARCHAR2(40)' });
    expect(typed.map((s) => s.sql)).toEqual(['ALTER TABLE "SHOP"."orders" MODIFY ("status" VARCHAR2(40));']);
    expect(typed[0]!.note).toMatch(/ORA-01439/);
  });

  it('Db2 sets the data type, then reorganises the table through ADMIN_CMD', () => {
    expect(step('db2', { newType: 'VARCHAR(40)' }).map((s) => s.sql)).toEqual([
      'ALTER TABLE "SHOP"."orders" ALTER COLUMN "status" SET DATA TYPE VARCHAR(40);',
      `CALL SYSPROC.ADMIN_CMD('REORG TABLE "SHOP"."orders"');`,
    ]);
    expect(step('db2', { newName: 'state' })[0]!.sql).toBe('ALTER TABLE "SHOP"."orders" RENAME COLUMN "status" TO "state";');
  });

  it('SQLite renames, and refuses a type change with the reason', () => {
    expect(step('sqlite', { newName: 'state' })[0]!.sql).toBe('ALTER TABLE "orders" RENAME COLUMN "status" TO "state";');
    const p = plan({ dialect: 'sqlite', column: 'status', change: { newType: 'TEXT' } });
    expect(!p.ok && p.error).toMatch(/SQLite cannot change a column’s type in place/);
    // Renaming and retyping at once is refused whole, not half done.
    expect(plan({ dialect: 'sqlite', column: 'status', change: { newName: 'state', newType: 'TEXT' } }).ok).toBe(false);
  });

  describe('DuckDB', () => {
    const plain = table('orders', {
      columns: [col('id', 'INTEGER', { primaryKey: true }), col('status', 'VARCHAR'), col('note', 'VARCHAR')],
      primaryKey: { columns: ['id'] },
    });
    const duck = (t: TableSchema, change: { newName?: string; newType?: string }) =>
      planColumnChange({ dialect: 'duckdb', schema: 'main', table: t, tables: [t], column: 'status', change });

    it('changes the type in place with a USING cast, and renames', () => {
      expect(ok(duck(plain, { newType: 'VARCHAR(40)' })).steps[0]!.sql).toBe(
        'ALTER TABLE "main"."orders" ALTER COLUMN "status" TYPE VARCHAR(40) USING CAST("status" AS VARCHAR(40));'
      );
      expect(ok(duck(plain, { newName: 'state' })).steps[0]!.sql).toBe('ALTER TABLE "main"."orders" RENAME COLUMN "status" TO "state";');
    });

    it('refuses any change while the table has an index, on any column, naming it', () => {
      // DuckDB: "Cannot alter entry … because there are entries that depend on it" (found live).
      const indexed = { ...plain, indices: [{ name: 'orders_note_idx', columns: [], unique: false }] };
      for (const change of [{ newName: 'state' }, { newType: 'VARCHAR(40)' }]) {
        const p = duck(indexed, change);
        expect(!p.ok && p.error).toMatch(/DuckDB will not change a column of orders while the table has an index \(orders_note_idx\)/);
      }
    });
  });

  it('Redshift lengthens a VARCHAR and refuses every other type change', () => {
    expect(step('redshift', { newType: 'varchar(40)' })[0]!.sql).toBe(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE varchar(40);'
    );
    expect(step('redshift', { newType: 'varchar(max)' })).toHaveLength(1);
    for (const newType of ['varchar(10)', 'integer', 'char(40)']) {
      const p = plan({ dialect: 'redshift', column: 'status', change: { newType } });
      expect(!p.ok && p.error, newType).toMatch(/only to make a VARCHAR longer/);
    }
    expect(step('redshift', { newName: 'state' })[0]!.sql).toBe('ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";');
  });

  describe('ClickHouse', () => {
    const events = table('events', {
      columns: [
        col('id', 'UInt64', { nullable: false }),
        col('ts', 'DateTime', { nullable: false }),
        col('note', 'String', { nullable: true }),
        col('qty', 'Int32', { nullable: false }),
      ],
      orderBy: ['ts', 'cityHash64(id)'],
    });
    const ch = (column: string, change: { newName?: string; newType?: string }) =>
      planColumnChange({ dialect: 'clickhouse', schema: 'analytics', table: events, tables: [events], column, change });

    it('modifies the type, keeping a nullable column Nullable', () => {
      const p = ok(ch('note', { newType: 'LowCardinality(String)' }));
      // Nullable goes inside LowCardinality, or every NULL fails to convert.
      expect(p.steps[0]!.sql).toBe('ALTER TABLE `analytics`.`events` MODIFY COLUMN `note` LowCardinality(Nullable(String));');
      expect(ok(ch('note', { newType: 'FixedString(8)' })).steps[0]!.sql).toBe(
        'ALTER TABLE `analytics`.`events` MODIFY COLUMN `note` Nullable(FixedString(8));'
      );
      expect(ok(ch('qty', { newType: 'Int64' })).steps[0]!.sql).toBe('ALTER TABLE `analytics`.`events` MODIFY COLUMN `qty` Int64;');
      expect(ok(ch('qty', { newName: 'quantity' })).steps[0]!.sql).toBe(
        'ALTER TABLE `analytics`.`events` RENAME COLUMN `qty` TO `quantity`;'
      );
    });

    it('refuses a column in the sorting key, by name or inside an expression, with its own reason', () => {
      for (const p of [ch('ts', { newName: 'at' }), ch('id', { newType: 'UInt32' })]) {
        expect(!p.ok && p.error).toMatch(/sorting key \(ORDER BY \/ PRIMARY KEY\), and ClickHouse will not rename it/);
      }
      // Even when Fox also marks it as the primary key: the engine's reason wins.
      const keyed = { ...events, primaryKey: { columns: ['ts'] } };
      const p = planColumnChange({ dialect: 'clickhouse', table: keyed, tables: [keyed], column: 'ts', change: { newName: 'at' } });
      expect(!p.ok && p.error).toMatch(/ClickHouse will not rename it/);
    });

    it('reads ClickHouse types for the data-loss check', () => {
      expect(ok(ch('qty', { newType: 'Int16' })).impact.lossy).toMatch(/Narrowing Int32 to Int16/);
      expect(lossyConversion('Nullable(String)', 'Nullable(Int64)')).toMatch(/text \(Nullable\(String\)\) to a number/);
      expect(lossyConversion('Int32', 'Int64')).toBeUndefined();
    });
  });
});
