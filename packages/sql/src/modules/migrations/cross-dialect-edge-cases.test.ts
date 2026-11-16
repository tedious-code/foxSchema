/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-dialect & all-14-dialect schema migration edge-case suite.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CompareModule } from '../schema-diff/compare.module.js';
import { SqlGeneratorModule } from './sql-generator.module.js';
import { validateMigrationPlan } from './migration-validation.js';
import { DIALECT_MAP, resolveDialect } from '../dialect/registry.js';
import { dialectSupportsFk } from '../dialect/fk-support.js';
import type { ColumnInfo, TableSchema } from '../../interfaces/index.js';

const ALL_DIALECTS = Object.keys(DIALECT_MAP);
const gen = new SqlGeneratorModule();

function col(
  overrides: Partial<ColumnInfo> & Pick<ColumnInfo, 'name' | 'type' | 'nullable'>,
): ColumnInfo {
  return {
    primaryKey: false,
    ...overrides,
  };
}

function makeTable(overrides: Partial<TableSchema> & Pick<TableSchema, 'name'>): TableSchema {
  return {
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [],
    ...overrides,
  };
}

function multiTypeCatalog(schemaPrefix: string): TableSchema[] {
  const orders = makeTable({
    name: `${schemaPrefix}.orders`,
    primaryKey: { name: 'pk_orders', columns: ['id'] },
    orderBy: ['id'],
    columns: [
      col({ name: 'id', type: 'bigint', nullable: false, primaryKey: true, identity: true }),
      col({ name: 'order_code', type: 'varchar(64)', nullable: false }),
      col({ name: 'total_amount', type: 'decimal(12,2)', nullable: false }),
      col({ name: 'is_paid', type: 'boolean', nullable: false }),
      col({ name: 'created_at', type: 'timestamp(3)', nullable: false }),
      col({ name: 'settled_at', type: 'timestamptz(6)', nullable: true }),
      col({ name: 'correlation_id', type: 'uuid', nullable: true }),
      col({ name: 'payload', type: 'json', nullable: true }),
      col({ name: 'notes', type: 'text', nullable: true }),
      col({ name: 'raw_blob', type: 'blob', nullable: true }),
    ],
    indices: [
      { name: 'ux_orders_code', columns: ['order_code'], unique: true },
      { name: 'ix_orders_paid_created', columns: ['is_paid', 'created_at'], unique: false },
    ],
  });

  const orderItems = makeTable({
    name: `${schemaPrefix}.order_items`,
    primaryKey: { name: 'pk_order_items', columns: ['id'] },
    orderBy: ['id'],
    columns: [
      col({ name: 'id', type: 'bigint', nullable: false, primaryKey: true, identity: true }),
      col({ name: 'order_id', type: 'bigint', nullable: false }),
      col({ name: 'sku', type: 'varchar(40)', nullable: false }),
      col({ name: 'qty', type: 'integer', nullable: false }),
      col({ name: 'unit_price', type: 'decimal(10,2)', nullable: false }),
    ],
    indices: [{ name: 'ix_order_items_order_sku', columns: ['order_id', 'sku'], unique: true }],
    foreignKeys: [
      {
        name: 'fk_order_items_order',
        columns: ['order_id'],
        referencedTable: `${schemaPrefix}.orders`,
        referencedColumns: ['id'],
      },
    ],
  });

  return [orderItems, orders];
}

describe('Cross-dialect 14x14 schema migration matrix', () => {
  it('migrates FK-linked multi-type tables across all 182 cross-dialect pairs cleanly', async () => {
    const compare = new CompareModule();

    for (const sourceDialect of ALL_DIALECTS) {
      const sourceTables = multiTypeCatalog('src_schema');
      for (const targetDialect of ALL_DIALECTS) {
        if (sourceDialect === targetDialect) continue;

        const diff = await compare.compare(
          sourceTables,
          [],
          { source: sourceDialect, target: targetDialect },
          { source: 'src_schema', target: 'tgt_schema' },
        );

        const plan = gen.generateMigrationPlan(diff.tables, targetDialect, {
          sourceSchema: 'src_schema',
          targetSchema: 'tgt_schema',
          sourceDialect,
          targetDialect,
        });

        expect(plan.length, `${sourceDialect} -> ${targetDialect} plan empty`).toBe(2);
        // Dependency ordering: orders must be created before order_items.
        expect(plan[0]!.objectName, `${sourceDialect} -> ${targetDialect} order`).toBe('ORDERS');
        expect(plan[1]!.objectName, `${sourceDialect} -> ${targetDialect} order`).toBe('ORDER_ITEMS');

        const allSql = plan.flatMap((s) => s.statements).join('\n');
        const fkSupport = dialectSupportsFk(targetDialect);
        if (!fkSupport.alterAdd) {
          expect(allSql, `${sourceDialect} -> ${targetDialect} emitted ALTER ADD FK`).not.toMatch(
            /ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/i,
          );
          if (fkSupport.createInline) {
            expect(allSql, `${sourceDialect} -> ${targetDialect} missing inline FK`).toMatch(/FOREIGN KEY/i);
          } else {
            expect(allSql, `${sourceDialect} -> ${targetDialect} missing FK review note`).toContain('-- review:');
          }
        }

        // No unflattened line breaks inside comments and pre-flight validation has zero errors.
        for (const step of plan) {
          for (const stmt of step.statements) {
            if (stmt.startsWith('--')) {
              expect(stmt.includes('\n'), `${sourceDialect} -> ${targetDialect} unflattened comment`).toBe(false);
            }
          }
        }
        const selection = Object.fromEntries(diff.tables.map((t) => [`${t.objectType}:${t.tableName}`, true]));
        const issues = validateMigrationPlan(diff.tables, selection, resolveDialect(targetDialect), plan);
        const errors = issues.filter((i) => i.severity === 'error');
        expect(errors, `${sourceDialect} -> ${targetDialect} errors: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
      }
    }
  });

  it('executes PostgreSQL -> SQLite generated migration DDL directly on real SQLite', async () => {
    const compare = new CompareModule();
    const pgTables = multiTypeCatalog('public');
    const diff = await compare.compare(
      pgTables,
      [],
      { source: 'postgres', target: 'sqlite' },
      { source: 'public', target: 'main' },
    );

    const script = gen.generateMigrationSql(diff.tables, 'sqlite', {
      sourceSchema: 'public',
      sourceDialect: 'postgres',
      targetDialect: 'sqlite',
    });

    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(script);
      db.exec(
        "INSERT INTO orders (id, order_code, total_amount, is_paid, created_at) VALUES (1, 'ORD-100', 199.95, 1, '2026-11-15T00:00:00Z');",
      );
      db.exec(
        "INSERT INTO order_items (id, order_id, sku, qty, unit_price) VALUES (10, 1, 'SKU-A', 2, 99.97);",
      );

      // FK constraint must actually reject orphan child rows.
      expect(() =>
        db.exec("INSERT INTO order_items (id, order_id, sku, qty, unit_price) VALUES (11, 999, 'SKU-B', 1, 10.00);"),
      ).toThrow(/FOREIGN KEY constraint failed/i);

      const row = db.prepare('SELECT order_code, total_amount FROM orders WHERE id = 1').get() as {
        order_code: string;
        total_amount: number;
      };
      expect(row).toEqual({ order_code: 'ORD-100', total_amount: 199.95 });
    } finally {
      db.close();
    }
  });
});

describe('Cross-dialect ClickHouse Nullable/LowCardinality & type comparison edge cases', () => {
  it('unwraps ClickHouse Nullable(...) and LowCardinality(...) for comparison and migration', async () => {
    const ch = resolveDialect('clickhouse');
    expect(ch.parseType('Nullable(Int64)')).toMatchObject({ base: 'bigint' });
    expect(ch.parseType('Nullable(String)')).toMatchObject({ base: 'text' });
    expect(ch.parseType('Nullable(Decimal(10, 2))')).toMatchObject({ base: 'decimal', precision: 10, scale: 2 });
    expect(ch.parseType("Nullable(DateTime64(3, 'UTC'))")).toMatchObject({ base: 'timestamp', length: 3 });
    expect(ch.parseType('LowCardinality(String)')).toMatchObject({ base: 'text' });
    expect(ch.parseType('LowCardinality(Nullable(FixedString(8)))')).toMatchObject({ base: 'char', length: 8 });

    // nullableTypeWrapper must never double-wrap Nullable(Nullable(...))
    expect(ch.nullableTypeWrapper!('Nullable(Int32)', true)).toBe('Nullable(Int32)');
    expect(ch.nullableTypeWrapper!('Int32', true)).toBe('Nullable(Int32)');

    const compare = new CompareModule();
    const chTable = makeTable({
      name: 'analytics.events',
      columns: [
        col({ name: 'user_id', type: 'Nullable(Int64)', nullable: true }),
        col({ name: 'country', type: 'LowCardinality(String)', nullable: false }),
        col({ name: 'amount', type: 'Nullable(Decimal(10, 2))', nullable: true }),
      ],
    });
    const pgTable = makeTable({
      name: 'public.events',
      columns: [
        col({ name: 'user_id', type: 'bigint', nullable: true }),
        col({ name: 'country', type: 'text', nullable: false }),
        col({ name: 'amount', type: 'numeric(10,2)', nullable: true }),
      ],
    });

    const diff = await compare.compare([chTable], [pgTable], { source: 'clickhouse', target: 'postgres' });
    expect(diff.summary.modified).toBe(0);
    expect(diff.summary.unchanged).toBe(1);

    const ddl = gen.generateObjectDdl(
      makeTable({
        name: 'public.events',
        columns: chTable.columns.map((c) => ({
          ...c,
          type: resolveDialect('postgres').renderType(ch.parseType(c.type)).sql,
        })),
      }),
      'postgres',
    );
    expect(ddl).toContain('user_id bigint');
    expect(ddl).toContain('country text NOT NULL');
    expect(ddl).toContain('amount numeric(10,2)');
    expect(ddl).not.toContain('Nullable(');
  });

  it('treats equivalent types, MariaDB NULL defaults, and schema-qualified sequences as UNCHANGED across dialects', async () => {
    const compare = new CompareModule();

    const oracleSrc = makeTable({
      name: 'HR.ACCOUNTS',
      columns: [
        col({ name: 'small_id', type: 'NUMBER(9,0)', nullable: false }),
        col({ name: 'big_id', type: 'NUMBER(10,0)', nullable: false }),
        col({ name: 'balance', type: 'NUMBER(10,2)', nullable: false }),
        col({ name: 'email', type: 'VARCHAR2(100)', nullable: true, defaultValue: undefined }),
        col({ name: 'bio', type: 'CLOB', nullable: true }),
      ],
    });
    const pgTarget = makeTable({
      name: 'public.accounts',
      columns: [
        col({ name: 'small_id', type: 'integer', nullable: false }),
        col({ name: 'big_id', type: 'bigint', nullable: false }),
        col({ name: 'balance', type: 'numeric(10,2)', nullable: false }),
        col({ name: 'email', type: 'varchar(100)', nullable: true, defaultValue: 'NULL' }),
        col({ name: 'bio', type: 'text', nullable: true }),
      ],
    });

    const oraVsPg = await compare.compare([oracleSrc], [pgTarget], { source: 'oracle', target: 'postgres' });
    expect(oraVsPg.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 1 });

    const mssqlSrc = makeTable({
      name: 'dbo.payments',
      columns: [
        col({ name: 'active', type: 'bit', nullable: false }),
        col({ name: 'amount', type: 'money', nullable: false }),
        col({ name: 'notes', type: 'nvarchar(max)', nullable: true }),
      ],
    });
    const mysqlTarget = makeTable({
      name: 'app.payments',
      columns: [
        col({ name: 'active', type: 'tinyint(1)', nullable: false }),
        col({ name: 'amount', type: 'decimal(19,4)', nullable: false }),
        col({ name: 'notes', type: 'longtext', nullable: true }),
      ],
    });

    const mssqlVsMysql = await compare.compare([mssqlSrc], [mysqlTarget], { source: 'sqlserver', target: 'mysql' });
    expect(mssqlVsMysql.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 1 });

    const seqSrc = makeTable({
      name: 'demo_a.items',
      columns: [col({ name: 'id', type: 'bigint', nullable: false, defaultValue: "nextval('demo_a.items_id_seq'::regclass)" })],
    });
    const seqTgt = makeTable({
      name: 'demo_b.items',
      columns: [col({ name: 'id', type: 'bigint', nullable: false, defaultValue: "nextval('demo_b.items_id_seq'::regclass)" })],
    });
    const seqCmp = await compare.compare(
      [seqSrc],
      [seqTgt],
      { source: 'postgres', target: 'postgres' },
      { source: 'demo_a', target: 'demo_b' },
    );
    expect(seqCmp.summary.unchanged).toBe(1);
  });

  it('flags cross-dialect procedural objects and defaults for manual review across all 14 dialects', async () => {
    const compare = new CompareModule();
    const viewSrc = makeTable({
      name: 'demo_a.v_active',
      objectType: 'VIEW',
      definition: 'SELECT id FROM demo_a.orders WHERE status = 1;',
    });
    const diff = await compare.compare([viewSrc], [], { source: 'postgres', target: 'mysql' });

    for (const targetDialect of ALL_DIALECTS) {
      if (resolveDialect(targetDialect) === resolveDialect('postgres')) continue;
      const plan = gen.generateMigrationPlan(diff.tables, targetDialect, {
        sourceSchema: 'demo_a',
        targetSchema: 'demo_b',
        sourceDialect: 'postgres',
        targetDialect,
      });
      const stmts = plan.flatMap((s) => s.statements);
      expect(stmts.join('\n')).toContain('MANUAL REVIEW REQUIRED');
      expect(stmts.every((s) => s.startsWith('--'))).toBe(true);
    }

    const defaultDiff = await compare.compare(
      [
        makeTable({
          name: 'demo_a.events',
          columns: [col({ name: 'created_at', type: 'timestamp', nullable: false, defaultValue: 'now()' })],
        }),
      ],
      [
        makeTable({
          name: 'demo_b.events',
          columns: [col({ name: 'created_at', type: 'datetime', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' })],
        }),
      ],
      { source: 'postgres', target: 'mysql' },
    );
    const defaultPlan = gen.generateMigrationPlan(defaultDiff.tables, 'mysql', {
      sourceSchema: 'demo_a',
      targetSchema: 'demo_b',
      sourceDialect: 'postgres',
      targetDialect: 'mysql',
    });
    const defaultSql = defaultPlan.flatMap((s) => s.statements).join('\n');
    expect(defaultSql).toContain('-- review:');
    expect(defaultSql).not.toMatch(/SET DEFAULT now\(\)/i);
  });
});

describe('All-14-dialect ALTER, non-destructive, sequence, type, and identifier edge cases', () => {
  it('supports ALTER, non-destructive mode, and hostile/reserved identifiers on every dialect', async () => {
    const compare = new CompareModule();
    const hostileSource = makeTable({
      name: 'src.Order Details',
      primaryKey: { name: 'pk_od', columns: ['order', 'key'] },
      orderBy: ['order', 'key'],
      columns: [
        col({ name: 'order', type: 'integer', nullable: false, primaryKey: true }),
        col({ name: 'key', type: 'varchar(50)', nullable: false, primaryKey: true }),
        col({ name: 'select', type: 'varchar(120)', nullable: true }),
        col({ name: 'extra_new', type: 'boolean', nullable: false }),
      ],
      indices: [{ name: 'ix_od_select', columns: ['select'], unique: false }],
      foreignKeys: [
        {
          name: 'fk_od_parent',
          columns: ['order'],
          referencedTable: 'src.orders',
          referencedColumns: ['id'],
        },
      ],
    });
    const hostileTarget = makeTable({
      name: 'tgt.Order Details',
      primaryKey: { name: 'pk_od', columns: ['order', 'key'] },
      orderBy: ['order', 'key'],
      columns: [
        col({ name: 'order', type: 'integer', nullable: false, primaryKey: true }),
        col({ name: 'key', type: 'varchar(20)', nullable: true, primaryKey: true }),
        col({ name: 'select', type: 'varchar(120)', nullable: true }),
        col({ name: 'legacy_col', type: 'integer', nullable: true }),
      ],
      indices: [{ name: 'ix_od_legacy', columns: ['legacy_col'], unique: false }],
      foreignKeys: [
        {
          name: 'fk_od_legacy',
          columns: ['legacy_col'],
          referencedTable: 'tgt.legacy',
          referencedColumns: ['id'],
        },
      ],
    });

    for (const dialect of ALL_DIALECTS) {
      const diff = await compare.compare([hostileSource], [hostileTarget], {
        source: dialect,
        target: dialect,
      });

      // Destructive mode: completes cleanly for every dialect.
      const fullPlan = gen.generateMigrationPlan(diff.tables, dialect, {
        sourceSchema: 'src',
        targetSchema: 'tgt',
      });
      expect(fullPlan.length, `${dialect} ALTER plan empty`).toBeGreaterThan(0);

      // Non-destructive mode: never drops columns, indexes, FKs, or tables.
      const safePlan = gen.generateMigrationPlan(diff.tables, dialect, {
        sourceSchema: 'src',
        targetSchema: 'tgt',
        nonDestructive: true,
      });
      const safeStatements = safePlan
        .flatMap((s) => s.statements)
        .filter((s) => !s.trim().startsWith('--') && !s.includes('$fs_pre$') && !s.includes('$fs_post$'));
      for (const stmt of safeStatements) {
        expect(stmt, `${dialect} emitted destructive DROP in nonDestructive mode: ${stmt}`).not.toMatch(
          /\bDROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT|FOREIGN\s+KEY|VIEW|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|TYPE|DOMAIN|ROLE)\b/i,
        );
      }

      // Dialect-appropriate quoting for reserved words (`order`, `key`, `select`) and space (`Order Details`).
      const ddl = gen.generateObjectDdl(hostileSource, dialect);
      if (dialect === 'MYSQL' || dialect === 'MARIADB' || dialect === 'TIDB') {
        expect(ddl).toContain('`Order Details`');
        expect(ddl).toContain('`order`');
        expect(ddl).toContain('`key`');
      } else if (dialect === 'SQLSERVER' || dialect === 'AZURESQL') {
        expect(ddl).toContain('[Order Details]');
        expect(ddl).toContain('[order]');
        expect(ddl).toContain('[key]');
      } else {
        expect(ddl).toContain('"Order Details"');
        expect(ddl).toContain('"order"');
        expect(ddl).toContain('"key"');
      }
    }
  });

  it('renders SEQUENCE and TYPE DDL with dialect-specific syntax across dialects', () => {
    const seqTable = makeTable({
      name: 'app.inv_seq',
      objectType: 'SEQUENCE',
      sequence: { start: '100', increment: '5', minValue: '1', maxValue: '999999', cycle: false, cache: 0 },
    });
    expect(gen.generateObjectDdl(seqTable, 'oracle')).toContain('NOCYCLE NOCACHE');
    expect(gen.generateObjectDdl(seqTable, 'mariadb')).toContain('NOCYCLE NOCACHE');
    expect(gen.generateObjectDdl(seqTable, 'postgres')).toContain('NO CYCLE NO CACHE');

    const pgEnum = makeTable({
      name: 'app.order_status',
      objectType: 'TYPE',
      userType: {
        metaType: 'E',
        attributes: [
          { name: 'pending', type: '' },
          { name: 'paid', type: '' },
          { name: 'cancelled', type: '' },
        ],
      },
    });
    expect(gen.generateObjectDdl(pgEnum, 'postgres')).toBe(
      "CREATE TYPE app.order_status AS ENUM ('pending', 'paid', 'cancelled');",
    );

    const oracleObj = makeTable({
      name: 'APP.ADDR_OBJ',
      objectType: 'TYPE',
      userType: { metaType: 'O', attributes: [{ name: 'CITY', type: 'VARCHAR2(80)' }] },
    });
    expect(gen.generateObjectDdl(oracleObj, 'oracle')).toContain('AS OBJECT');

    const mssqlAlias = makeTable({
      name: 'dbo.phone_t',
      objectType: 'TYPE',
      userType: { metaType: 'D', sourceType: 'varchar(20)' },
    });
    expect(gen.generateObjectDdl(mssqlAlias, 'sqlserver')).toBe('CREATE TYPE dbo.phone_t FROM varchar(20);');
  });
});
