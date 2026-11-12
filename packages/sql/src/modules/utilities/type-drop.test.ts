/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import { duckDbEnumValues } from '../../providers/duckDb/duckdb.type-drop.js';
import { withoutTypeCast } from '../../providers/postgres/postgres.type-drop.js';
import { splitSqlStatements } from '../sql-text/sql-splitter.js';
import { planTypeDrop, userTypesOf } from './type-drop.js';
import { TYPE_DROP_MAP, dialectSupportsTypeDrop } from './type-drop.registry.js';
import type { TypeDropInput, TypeDropPlan } from './type-drop.types.js';
import { parseTypeReference, referencesType } from './type-name-match.js';

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
const enumType = (name: string, values: string[]): TableSchema =>
  table(name, { objectType: 'TYPE', userType: { metaType: 'E', attributes: values.map((v) => ({ name: v, type: '' })) } });
const domainType = (name: string, base: string): TableSchema =>
  table(name, { objectType: 'TYPE', userType: { metaType: 'D', sourceType: base } });

const status = enumType('order_status', ['new', 'paid', 'shipped', 'cancelled']);
const email = domainType('email', 'character varying(120)');
const unused = enumType('mood', ['sad', 'ok']);
const orders = table('orders', {
  columns: [
    col('id', 'integer', { primaryKey: true, nullable: false }),
    col('status', 'shop.order_status', { nullable: false, defaultValue: "'new'::shop.order_status" }),
    col('tags', 'shop.order_status[]'),
    col('contact', 'shop.email', { defaultValue: "'a@b.c'::character varying" }),
    col('note', 'text'),
  ],
  primaryKey: { columns: ['id'] },
  indices: [{ name: 'orders_status_idx', columns: ['status'], unique: false }],
});
const history = table('order_history', { columns: [col('old_status', 'order_status')] });
const label = table('order_label', {
  objectType: 'FUNCTION',
  // Its body names the type; its parameters do not, so it is a "may use".
  definition: 'CREATE FUNCTION order_label(p text)\nRETURNS order_status AS $$ SELECT p::order_status $$',
  parameters: [{ name: 'p', type: 'text', mode: 'IN' }],
});
const takesOnly = table('takes_status', {
  objectType: 'PROCEDURE',
  definition: 'BEGIN NULL; END',
  parameters: [{ name: 'p', type: 'order_status', mode: 'IN' }],
});
const openOrders = table('v_open', { objectType: 'VIEW', definition: "SELECT id FROM orders WHERE status = 'new'::order_status" });
const ALL = [orders, history, label, openOrders, status, email, unused];

const plan = (over: Partial<TypeDropInput> & Pick<TypeDropInput, 'type'>): TypeDropPlan =>
  planTypeDrop({ dialect: 'postgres', schema: 'shop', tables: ALL, ...over });
const ok = (p: TypeDropPlan) => {
  if (!p.ok) throw new Error(p.error);
  return p;
};

describe('referencesType', () => {
  it('reads a type reference whatever its schema, quoting or array suffix', () => {
    expect(parseTypeReference('"shop"."Order Status"[]')).toEqual({ schema: 'shop', name: 'Order Status', array: true });
    expect(parseTypeReference('[dbo].[Phone]')).toEqual({ schema: 'dbo', name: 'Phone', array: false });
    expect(parseTypeReference('phone(20)')).toEqual({ name: 'phone', array: false });
    expect(referencesType('shop.order_status', 'order_status', 'shop')).toEqual({ uses: true, array: false });
    expect(referencesType('ORDER_STATUS[]', 'order_status')).toEqual({ uses: true, array: true });
  });

  it('does not match another type, a longer name, or the same name in another schema', () => {
    expect(referencesType('order_status_old', 'order_status').uses).toBe(false);
    expect(referencesType('text', 'order_status').uses).toBe(false);
    expect(referencesType('billing.order_status', 'order_status', 'shop').uses).toBe(false);
    expect(referencesType(undefined, 'order_status').uses).toBe(false);
  });
});

describe('planTypeDrop: what it finds', () => {
  it('finds the columns, arrays included, and the routines and views that may use the type', () => {
    const { impact } = ok(plan({ type: status }));
    expect(impact.kind).toBe('enum');
    expect(impact.values).toEqual(['new', 'paid', 'shipped', 'cancelled']);
    expect(impact.columns.map((c) => `${c.table}.${c.column.name}${c.array ? '[]' : ''}`)).toEqual([
      'orders.status',
      'orders.tags[]',
      'order_history.old_status',
    ]);
    expect(impact.dependents.map((d) => `${d.objectType} ${d.name}`)).toEqual(['FUNCTION order_label', 'VIEW v_open']);
    // The lines that name it, for the reader to act on.
    expect(impact.dependents[0]!.references.map((r) => r.line)).toEqual([2]);
  });

  it('refuses up front while a routine takes the type as a parameter, before any column is changed', () => {
    // Found through its parameters alone: its body never names the type.
    const p = plan({ type: status, tables: [...ALL, takesOnly] });
    expect(!p.ok && p.error).toMatch(
      /^takes_status takes order_status as a parameter, and the database will not drop the type while it exists\./
    );
    expect(!p.ok && p.impact?.dependents.map((d) => d.name)).toContain('takes_status');
    expect(!p.ok && p.impact?.dependents.find((d) => d.name === 'takes_status')?.references).toEqual([]);
    const fn = table('status_of', { objectType: 'FUNCTION', parameters: [{ name: 'p', type: 'shop.order_status[]', mode: 'IN' }] });
    const two = plan({ type: status, tables: [...ALL, takesOnly, fn] });
    expect(!two.ok && two.error).toMatch(/^takes_status, status_of take order_status as a parameter.*while they exist/);
    // Another schema's type of the same name is not this one.
    const other = table('other_fn', { objectType: 'FUNCTION', parameters: [{ name: 'p', type: 'billing.order_status', mode: 'IN' }] });
    expect(plan({ type: status, tables: [...ALL, other] }).ok).toBe(true);
  });

  it('finds a type built on the type, and refuses until that one is gone', () => {
    const wrapper = domainType('strict_status', 'shop.order_status');
    const p = plan({ type: status, tables: [...ALL, wrapper] });
    expect(!p.ok && p.error).toMatch(/Other types are built on order_status \(strict_status\)/);
  });

  it('lists a schema’s user types by name', () => {
    expect(userTypesOf(ALL).map((t) => t.name)).toEqual(['email', 'mood', 'order_status']);
  });
});

describe('planTypeDrop: PostgreSQL', () => {
  it('drops a type nothing uses in one step, with no CASCADE', () => {
    const p = ok(plan({ type: unused }));
    expect(p.steps.map((s) => s.sql)).toEqual(['DROP TYPE "shop"."mood";']);
    expect(p.steps[0]!.note).toMatch(/No CASCADE/);
    expect(p.warnings).toEqual([]);
  });

  it('never writes CASCADE, on any engine, used or not', () => {
    for (const dialect of Object.keys(TYPE_DROP_MAP)) {
      for (const type of [status, unused, email]) {
        const p = planTypeDrop({ dialect, schema: 'shop', tables: ALL, type });
        if (p.ok) expect(p.steps.map((s) => s.sql).join('\n')).not.toMatch(/cascade/i);
      }
    }
  });

  it('moves each enum column to text first: default dropped and set again without its cast', () => {
    const p = ok(plan({ type: status }));
    expect(p.steps.map((s) => s.title)).toEqual([
      'Change orders.status to text',
      'Change orders.tags to text[]',
      'Change order_history.old_status to text',
      'Drop order_status',
    ]);
    expect(p.steps[0]!.sql).toBe(
      [
        'BEGIN;',
        'ALTER TABLE "shop"."orders" ALTER COLUMN "status" DROP DEFAULT;',
        'ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE text USING "status"::text;',
        'ALTER TABLE "shop"."orders" ALTER COLUMN "status" SET DEFAULT \'new\';',
        'COMMIT;',
      ].join('\n')
    );
    // An array stays an array.
    expect(p.steps[1]!.sql).toContain('ALTER COLUMN "tags" TYPE text[] USING "tags"::text[];');
    expect(p.steps.at(-1)!.sql).toBe('DROP TYPE "shop"."order_status";');
  });

  it('casts through text to another type, and refuses one too short for the values', () => {
    const p = ok(plan({ type: status, replacement: 'varchar(20)' }));
    expect(p.steps[0]!.sql).toContain('TYPE varchar(20) USING "status"::text::varchar(20);');
    expect(p.steps[1]!.sql).toContain('TYPE varchar(20)[] USING "tags"::text[]::varchar(20)[];');
    const short = plan({ type: status, replacement: 'varchar(5)' });
    expect(!short.ok && short.error).toMatch(/varchar\(5\) is shorter than the longest value, 'cancelled' \(9 characters\)/);
  });

  it('keeps the allowed values as a check constraint when asked, and warns when not', () => {
    const kept = ok(plan({ type: status, keepValuesCheck: true }));
    expect(kept.steps[0]!.sql).toContain(
      `ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('new', 'paid', 'shipped', 'cancelled'));`
    );
    expect(kept.steps[1]!.sql).toContain(`CHECK ("tags" <@ ARRAY['new', 'paid', 'shipped', 'cancelled']::text[]);`);
    expect(kept.warnings.join('\n')).not.toMatch(/accept any text/);
    expect(ok(plan({ type: status })).warnings.join('\n')).toMatch(/Without the check constraint.*accept any text/);
  });

  it('warns about the routines and views that may use it, saying why it matters', () => {
    const w = ok(plan({ type: status })).warnings.join('\n');
    expect(w).toMatch(/Functions that may use the type: order_label/);
    expect(w).toMatch(/Views that may use the type: v_open/);
    expect(w).toMatch(/refuses the drop/);
  });

  it('moves a domain’s columns to its base type and drops it as a domain', () => {
    const p = ok(plan({ type: email }));
    expect(p.impact.kind).toBe('domain');
    expect(p.steps[0]!.sql).toContain(
      'ALTER TABLE "shop"."orders" ALTER COLUMN "contact" TYPE character varying(120) USING "contact"::character varying(120);'
    );
    expect(p.steps.at(-1)!.sql).toBe('DROP DOMAIN "shop"."email";');
    expect(p.warnings.join('\n')).toMatch(/domain's own rules/);
  });

  it('refuses a column in a foreign key, naming the column and the key', () => {
    const keyed = table('shipments', {
      columns: [col('status', 'order_status')],
      foreignKeys: [{ name: 'shipments_status_fk', columns: ['status'], referencedTable: 'statuses', referencedColumns: ['code'] }],
    });
    const p = plan({ type: status, tables: [keyed, status] });
    expect(!p.ok && p.error).toMatch(/shipments\.status cannot be moved off order_status: it has a foreign key \(shipments_status_fk\)/);
    const referenced = table('statuses', { columns: [col('code', 'order_status')] });
    const child = table('child', {
      columns: [col('s', 'text')],
      foreignKeys: [{ name: 'child_fk', columns: ['s'], referencedTable: 'statuses', referencedColumns: ['code'] }],
    });
    const q = plan({ type: status, tables: [referenced, child, status] });
    expect(!q.ok && q.error).toMatch(/child has a foreign key pointing at it/);
  });

  it('refuses to leave the columns on the type being dropped', () => {
    const p = plan({ type: status, replacement: 'shop.order_status' });
    expect(!p.ok && p.error).toMatch(/that is the type being dropped/);
  });

  it('strips every cast to the type from a default, and nothing else', () => {
    expect(withoutTypeCast("'new'::shop.order_status", 'order_status', 'shop')).toBe("'new'");
    expect(withoutTypeCast(`'{}'::"shop"."order_status"[]`, 'order_status', 'shop')).toBe("'{}'");
    expect(withoutTypeCast("ARRAY['new'::order_status, 'paid'::order_status]", 'order_status', 'shop')).toBe("ARRAY['new', 'paid']");
    expect(withoutTypeCast("'x'::text", 'order_status', 'shop')).toBe("'x'::text");
    expect(withoutTypeCast("'new'::order_status_old", 'order_status_old', 'shop')).toBe("'new'");
  });
});

describe('planTypeDrop: PostgreSQL composite types', () => {
  const address = table('address', {
    objectType: 'TYPE',
    userType: { metaType: 'O', attributes: [{ name: 'street', type: 'text' }, { name: 'status', type: 'shop.order_status' }] },
  });

  it('drops a composite nothing uses with DROP TYPE', () => {
    const p = ok(plan({ type: address, tables: [address] }));
    expect(p.impact.kind).toBe('composite');
    expect(p.impact.suggestedReplacement).toBeUndefined();
    expect(p.steps.map((s) => s.sql)).toEqual(['DROP TYPE "shop"."address";']);
  });

  it('refuses while a column is declared with it: no built-in type holds its fields', () => {
    const people = table('people', { columns: [col('home', 'shop.address')] });
    const p = plan({ type: address, tables: [people, address] });
    expect(!p.ok && p.error).toMatch(/A column is declared with address \(people\.home\).*PostgreSQL has no in-place change/);
    // Even when asked for one: the plan does not guess a conversion.
    expect(plan({ type: address, tables: [people, address], replacement: 'text' }).ok).toBe(false);
  });

  it('counts a composite with a field of the type as a type built on it', () => {
    const p = plan({ type: status, tables: [...ALL, address] });
    expect(!p.ok && p.error).toMatch(/Other types are built on order_status \(address\)/);
  });
});

describe('planTypeDrop: CockroachDB', () => {
  it('turns on the general type change and runs outside a transaction', () => {
    const sql = ok(plan({ dialect: 'cockroachdb', type: status })).steps[0]!.sql;
    expect(sql.split('\n')[0]).toBe('SET enable_experimental_alter_column_type_general = true;');
    expect(sql).not.toMatch(/BEGIN|COMMIT/);
  });
});

describe('planTypeDrop: SQL Server', () => {
  const phone = table('Phone', { objectType: 'TYPE', userType: { metaType: 'D', sourceType: 'varchar(20)' } });
  const people = table('people', {
    columns: [col('id', 'int', { primaryKey: true, nullable: false }), col('phone', 'Phone', { nullable: false, defaultValue: "('000')" })],
    primaryKey: { columns: ['id'] },
    indices: [{ name: 'people_phone_idx', columns: ['phone'], unique: false }],
  });

  it('moves an alias type’s column to its base type through the in-place change, then drops it', () => {
    const p = ok(planTypeDrop({ dialect: 'sqlserver', schema: 'dbo', type: phone, tables: [people, phone] }));
    expect(p.impact.kind).toBe('alias');
    expect(p.impact.suggestedReplacement).toBe('varchar(20)');
    expect(p.steps.map((s) => s.title)).toEqual(['Change people.phone to varchar(20)', 'Drop Phone']);
    // The same transaction Rename Column writes: indexes and default off, change, back on.
    expect(p.steps[0]!.sql).toContain('ALTER TABLE [dbo].[people] ALTER COLUMN [phone] varchar(20) NOT NULL');
    expect(p.steps[0]!.sql).toContain('DECLARE @fox_ix TABLE');
    expect(splitSqlStatements(p.steps[0]!.sql)).toHaveLength(1);
    expect(p.steps[1]!.sql).toBe('DROP TYPE [dbo].[Phone];');
  });

  it('passes on the column planner’s refusal, naming the column', () => {
    const keyed = { ...people, columns: [col('phone', 'Phone', { primaryKey: true, nullable: false })], primaryKey: { columns: ['phone'] } };
    const p = planTypeDrop({ dialect: 'sqlserver', schema: 'dbo', type: phone, tables: [keyed, phone] });
    expect(!p.ok && p.error).toMatch(/people\.phone cannot be moved off Phone: .*primary key/);
  });
});

describe('planTypeDrop: DuckDB', () => {
  const mood = enumType('mood', ['sad', 'ok', "it's fine"]);
  const diary = table('diary', {
    columns: [col('id', 'integer', { primaryKey: true }), col('m', "enum('sad', 'ok', 'it''s fine')"), col('n', "enum('a', 'b')")],
    primaryKey: { columns: ['id'] },
  });

  it('reads the values of an enum column type', () => {
    expect(duckDbEnumValues("ENUM('sad', 'ok', 'it''s fine')")).toEqual(['sad', 'ok', "it's fine"]);
    expect(duckDbEnumValues('varchar')).toBeUndefined();
  });

  it('matches a column on its values, since DuckDB does not report the type’s name', () => {
    const p = ok(planTypeDrop({ dialect: 'duckdb', schema: 'main', type: mood, tables: [diary, mood] }));
    expect(p.impact.columns.map((c) => c.column.name)).toEqual(['m']);
    expect(p.steps.map((s) => s.sql)).toEqual([
      'ALTER TABLE "main"."diary" ALTER COLUMN "m" TYPE VARCHAR USING CAST("m" AS VARCHAR);',
      'DROP TYPE "main"."mood";',
    ]);
    expect(p.impact.canKeepValuesCheck).toBe(false);
    expect(p.warnings.join('\n')).toMatch(/DuckDB cannot add a check constraint/);
  });

  it('passes on DuckDB’s refusal for a table that has an index', () => {
    const indexed = { ...diary, indices: [{ name: 'diary_m_idx', columns: [], unique: false }] };
    const p = planTypeDrop({ dialect: 'duckdb', schema: 'main', type: mood, tables: [indexed, mood] });
    expect(!p.ok && p.error).toMatch(/diary\.m cannot be moved off mood: DuckDB will not change a column/);
  });
});

describe('planTypeDrop: engines that only drop an unused type', () => {
  const address = table('ADDRESS_T', { objectType: 'TYPE', userType: { metaType: 'O', attributes: [{ name: 'CITY', type: 'VARCHAR2(40)' }] } });
  const money = table('MONEY_T', { objectType: 'TYPE', userType: { metaType: 'T', sourceType: 'DECIMAL' } });

  it('Oracle and Db2 drop a type nothing uses, with the schema folded to upper case', () => {
    expect(ok(planTypeDrop({ dialect: 'oracle', schema: 'shop', type: address, tables: [address] })).steps.map((s) => s.sql)).toEqual([
      'DROP TYPE "SHOP"."ADDRESS_T";',
    ]);
    const db2 = ok(planTypeDrop({ dialect: 'db2', schema: 'shop', type: money, tables: [money] }));
    expect(db2.impact.kind).toBe('alias');
    expect(db2.steps.map((s) => s.sql)).toEqual(['DROP TYPE "SHOP"."MONEY_T";']);
  });

  it('refuse while a column is declared with it, naming the columns', () => {
    const people = table('PEOPLE', { columns: [col('HOME', 'ADDRESS_T'), col('WORK', 'ADDRESS_T')] });
    const p = planTypeDrop({ dialect: 'oracle', schema: 'SHOP', type: address, tables: [people, address] });
    expect(!p.ok && p.error).toMatch(/2 columns are declared with ADDRESS_T \(PEOPLE\.HOME, PEOPLE\.WORK\).*Oracle has no in-place change/);
    expect(!p.ok && p.impact?.columns).toHaveLength(2);
  });
});

describe('planTypeDrop: what it refuses', () => {
  it.each(['mysql', 'mariadb', 'tidb', 'sqlite', 'clickhouse', 'redshift', 'mongodb'])('%s has no user-defined types', (dialect) => {
    expect(dialectSupportsTypeDrop(dialect)).toBe(false);
    const p = planTypeDrop({ dialect, type: status, tables: ALL });
    expect(!p.ok && p.error).toMatch(/has no user-defined types/);
  });

  it('refuses something that is not a type', () => {
    const p = plan({ type: orders });
    expect(!p.ok && p.error).toMatch(/orders is not a user-defined type/);
  });

  it.each(Object.keys(TYPE_DROP_MAP))('%s writes SQL that splits into statements', (dialect) => {
    const p = planTypeDrop({ dialect, schema: 'shop', type: unused, tables: [unused] });
    for (const step of ok(p).steps) expect(splitSqlStatements(step.sql).length).toBeGreaterThan(0);
  });
});
