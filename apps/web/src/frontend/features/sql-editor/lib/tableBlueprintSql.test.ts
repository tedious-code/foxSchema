import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '@/shared/lib/types';
import {
  applyTypeSize,
  buildColumnDef,
  classifyColumnType,
  defaultDialectColumnType,
  dialectBooleanDefaultOptions,
  dialectIdentitySupport,
  dialectIndexSupport,
  diffBlueprintColumns,
  generateAddForeignKeySql,
  generateBlueprintAlterSql,
  generateCreateIndexSql,
  generateCreateTableSql,
  generateCreateTriggerSql,
  generateDropForeignKeySql,
  generateDropIndexSql,
  generateDropTableSql,
  generateDropTriggerSql,
  generatePkAlterSql,
  generateTableBlueprintSql,
  dialectFkConstraintSupport,
  matchFkReferencedColumns,
  moveFkColumnsLockstep,
  quoteTableRef,
  qualifyTableName,
  isIntegerAutoIncrementType,
  listDialectDataTypes,
  parseTypeSize,
  quoteIdent,
  suggestFkName,
  suggestIndexName,
  appendFkTriggerSql,
  nextArchiveTableName,
  generateRenameTableSql,
  generateCloneTableSql,
  findInboundForeignKeyTables,
  executableSqlStatements,
} from './tableBlueprintSql';

const col = (partial: Partial<ColumnInfo> & Pick<ColumnInfo, 'name' | 'type'>): ColumnInfo => ({
  nullable: true,
  primaryKey: false,
  ...partial,
});

describe('quoteIdent', () => {
  it('leaves plain names unquoted', () => {
    expect(quoteIdent('orders', 'postgres')).toBe('orders');
  });

  it('quotes special names per dialect', () => {
    expect(quoteIdent('my col', 'postgres')).toBe('"my col"');
    expect(quoteIdent('my col', 'mysql')).toBe('`my col`');
    expect(quoteIdent('my col', 'sqlserver')).toBe('[my col]');
  });
});

describe('listDialectDataTypes', () => {
  it('renders postgres-native names', () => {
    const types = listDialectDataTypes('postgres');
    const values = types.map((t) => t.value);
    expect(values).toContain('integer');
    expect(values).toContain('bigint');
    expect(values).toContain('varchar(255)');
    expect(values).toContain('boolean');
    expect(values).toContain('timestamptz');
  });

  it('renders mysql-native names', () => {
    const types = listDialectDataTypes('mysql');
    const values = types.map((t) => t.value);
    expect(values).toContain('int');
    expect(values).toContain('bigint');
    expect(values).toContain('tinyint(1)');
    expect(values).toContain('varchar(255)');
  });

  it('marks integer-like options for auto-inc', () => {
    const intOpt = listDialectDataTypes('postgres').find((t) => t.value === 'integer');
    expect(intOpt?.integerLike).toBe(true);
    const varchar = listDialectDataTypes('postgres').find((t) => t.value === 'varchar(255)');
    expect(varchar?.integerLike).toBe(false);
  });

  it('defaultDialectColumnType prefers varchar(255)', () => {
    expect(defaultDialectColumnType('postgres')).toBe('varchar(255)');
    expect(defaultDialectColumnType('mysql')).toBe('varchar(255)');
  });
});

describe('classifyColumnType / sizes / boolean defaults', () => {
  it('classifies kinds', () => {
    expect(classifyColumnType('integer')).toBe('integer');
    expect(classifyColumnType('varchar(50)')).toBe('text');
    expect(classifyColumnType('numeric(10,2)')).toBe('decimal');
    expect(classifyColumnType('boolean')).toBe('boolean');
    expect(classifyColumnType('tinyint(1)')).toBe('boolean');
    expect(classifyColumnType('timestamptz')).toBe('datetime');
  });

  it('parses and applies varchar length', () => {
    expect(parseTypeSize('varchar(255)')).toEqual({ kind: 'length', length: 255 });
    expect(applyTypeSize('varchar(255)', { length: 100 })).toBe('varchar(100)');
  });

  it('parses and applies decimal precision/scale', () => {
    expect(parseTypeSize('decimal(10,2)')).toEqual({
      kind: 'decimal',
      precision: 10,
      scale: 2,
    });
    expect(applyTypeSize('numeric(10,2)', { precision: 18, scale: 4 })).toBe('numeric(18,4)');
  });

  it('offers dialect boolean defaults', () => {
    expect(dialectBooleanDefaultOptions('postgres').map((o) => o.value)).toEqual([
      '',
      'TRUE',
      'FALSE',
      'NULL',
    ]);
    expect(dialectBooleanDefaultOptions('mysql').some((o) => o.value === '1')).toBe(true);
    expect(dialectBooleanDefaultOptions('sqlserver').map((o) => o.value)).toEqual([
      '',
      '1',
      '0',
      'NULL',
    ]);
  });

  it('hides auto-inc for boolean and decimal', () => {
    expect(isIntegerAutoIncrementType('boolean')).toBe(false);
    expect(isIntegerAutoIncrementType('tinyint(1)')).toBe(false);
    expect(isIntegerAutoIncrementType('decimal(10,2)')).toBe(false);
    expect(isIntegerAutoIncrementType('bigint')).toBe(true);
  });

  it('emits UNIQUE when set', () => {
    expect(
      buildColumnDef(
        { name: 'email', type: 'varchar(255)', nullable: false, primaryKey: false, unique: true },
        'postgres'
      )
    ).toContain('UNIQUE');
  });
});

describe('dialectIdentitySupport', () => {
  it('exposes AUTO_INCREMENT for mysql', () => {
    expect(dialectIdentitySupport('mysql').label).toBe('Auto increment');
    expect(dialectIdentitySupport('mysql').clauseHint).toBe('AUTO_INCREMENT');
    expect(dialectIdentitySupport('mysql').supported).toBe(true);
  });

  it('exposes GENERATED options for postgres', () => {
    expect(dialectIdentitySupport('postgres').generations).toEqual(['ALWAYS', 'BY DEFAULT']);
  });

  it('marks sqlite supported with AUTOINCREMENT', () => {
    expect(dialectIdentitySupport('sqlite').supported).toBe(true);
    expect(dialectIdentitySupport('sqlite').clauseHint).toBe('AUTOINCREMENT');
  });
});

describe('buildColumnDef', () => {
  it('builds postgres-style add column def', () => {
    expect(
      buildColumnDef(
        col({ name: 'status', type: 'varchar(32)', nullable: false, defaultValue: `'open'` }),
        'postgres'
      )
    ).toBe(`status varchar(32) DEFAULT 'open' NOT NULL`);
  });

  it('appends identity clause for postgres', () => {
    expect(
      buildColumnDef(
        col({
          name: 'id',
          type: 'integer',
          nullable: false,
          identity: true,
          identityGeneration: 'BY DEFAULT',
        }),
        'postgres'
      )
    ).toContain('GENERATED BY DEFAULT AS IDENTITY');
  });

  it('appends AUTO_INCREMENT for mysql', () => {
    expect(
      buildColumnDef(col({ name: 'id', type: 'int', nullable: false, identity: true }), 'mysql')
    ).toContain('AUTO_INCREMENT');
  });

  it('omits identity clause when type is not int/long', () => {
    expect(
      buildColumnDef(
        col({ name: 'name', type: 'varchar(50)', nullable: false, identity: true }),
        'mysql'
      )
    ).not.toContain('AUTO_INCREMENT');
  });
});

describe('diffBlueprintColumns + generateBlueprintAlterSql', () => {
  const original = [
    col({ name: 'id', type: 'integer', nullable: false, primaryKey: true }),
    col({ name: 'name', type: 'varchar(100)', nullable: false }),
  ];

  it('generates ADD for postgres', () => {
    const draft = [...original, col({ name: 'sku', type: 'varchar(50)', nullable: true })];
    const ops = diffBlueprintColumns(original, draft, new Set());
    const sql = generateBlueprintAlterSql('products', 'postgres', ops);
    expect(sql).toEqual(['ALTER TABLE products ADD COLUMN sku varchar(50);']);
  });

  it('generates DROP for postgres', () => {
    const ops = diffBlueprintColumns(original, original, new Set(['name']));
    const sql = generateBlueprintAlterSql('products', 'postgres', ops);
    expect(sql).toEqual(['ALTER TABLE products DROP COLUMN name;']);
  });

  it('generates MODIFY for mysql', () => {
    const draft = [original[0]!, col({ name: 'name', type: 'varchar(200)', nullable: false })];
    const ops = diffBlueprintColumns(original, draft, new Set());
    const sql = generateBlueprintAlterSql('products', 'mysql', ops);
    expect(sql.some((s) => s.includes('MODIFY COLUMN name varchar(200)'))).toBe(true);
  });

  it('generates DROP then ADD order', () => {
    const draft = [original[0]!, col({ name: 'code', type: 'text', nullable: true })];
    const ops = diffBlueprintColumns(original, draft, new Set(['name']));
    const sql = generateBlueprintAlterSql('products', 'postgres', ops);
    expect(sql[0]).toContain('DROP COLUMN name');
    expect(sql[1]).toContain('ADD COLUMN code text');
  });

  it('emits set default when only default changes (postgres)', () => {
    const draft = [
      original[0]!,
      col({ name: 'name', type: 'varchar(100)', nullable: false, defaultValue: `'x'` }),
    ];
    const ops = diffBlueprintColumns(original, draft, new Set());
    const sql = generateBlueprintAlterSql('products', 'postgres', ops);
    expect(sql).toEqual([`ALTER TABLE products ALTER COLUMN name SET DEFAULT 'x';`]);
  });
});

describe('primary key alter', () => {
  it('adds composite primary key', () => {
    const sql = generatePkAlterSql('order_lines', 'postgres', [], ['order_id', 'line_no']);
    expect(sql).toEqual([
      'ALTER TABLE order_lines ADD PRIMARY KEY (order_id, line_no);',
    ]);
  });

  it('drops then recreates when key changes', () => {
    const sql = generatePkAlterSql('t', 'mysql', ['id'], ['a', 'b'], 'PRIMARY');
    expect(sql[0]).toMatch(/DROP PRIMARY KEY/i);
    expect(sql[1]).toBe('ALTER TABLE t ADD PRIMARY KEY (a, b);');
  });

  it('reviews a ClickHouse composite key change instead of ALTER ADD PRIMARY KEY', () => {
    const sql = generatePkAlterSql('order_coupons', 'clickhouse', ['order_id'], ['order_id', 'coupon_id']);
    expect(sql.join('\n')).toMatch(/-- review:/);
    expect(sql.join('\n')).not.toMatch(/ALTER TABLE .* ADD .*PRIMARY KEY/i);
  });
});

describe('create / drop table', () => {
  it('creates with IF NOT EXISTS and composite PK (postgres)', () => {
    const sql = generateCreateTableSql(
      'order_lines',
      [
        col({ name: 'order_id', type: 'integer', nullable: false }),
        col({ name: 'line_no', type: 'integer', nullable: false }),
        col({ name: 'qty', type: 'integer', nullable: true }),
      ],
      ['order_id', 'line_no'],
      'postgres'
    );
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^CREATE TABLE IF NOT EXISTS order_lines/);
    expect(sql[0]).toContain('PRIMARY KEY (order_id, line_no)');
    expect(sql[0]).not.toMatch(/INTEGER NOT NULL PRIMARY KEY/);
  });

  it('maps a ClickHouse composite PK to MergeTree ORDER BY, not a constraint', () => {
    const sql = generateCreateTableSql(
      'order_coupons',
      [
        col({ name: 'order_id', type: 'Int32', nullable: false, primaryKey: true }),
        col({ name: 'coupon_id', type: 'Int32', nullable: false, primaryKey: true }),
        col({ name: 'applied_at', type: 'DateTime', nullable: false }),
      ],
      ['order_id', 'coupon_id'],
      'clickhouse'
    );
    expect(sql[0]).toMatch(/ENGINE = MergeTree ORDER BY \(order_id, coupon_id\)/);
    expect(sql[0]).not.toMatch(/CONSTRAINT/);
    expect(sql[0]).not.toContain('PRIMARY KEY (order_id, coupon_id)');
  });

  it('uses OBJECT_ID guard for sqlserver create', () => {
    const sql = generateCreateTableSql(
      't',
      [col({ name: 'id', type: 'int', nullable: false, identity: true })],
      ['id'],
      'sqlserver'
    );
    expect(sql[0]).toMatch(/IF OBJECT_ID\(N't', N'U'\) IS NULL/);
    expect(sql[0]).toContain('IDENTITY(1,1)');
  });

  it('drops with IF EXISTS for postgres', () => {
    expect(generateDropTableSql('products', 'postgres')).toEqual([
      'DROP TABLE IF EXISTS products;',
    ]);
  });

  it('uses dialect drop hook for oracle', () => {
    const sql = generateDropTableSql('products', 'oracle');
    expect(sql[0]).toMatch(/DROP TABLE/i);
  });
});

describe('foreign keys & triggers', () => {
  it('suggests fk name', () => {
    expect(suggestFkName('orders', ['customer_id'])).toBe('fk_orders_customer_id');
  });

  it('generates ADD FOREIGN KEY with ON DELETE', () => {
    const sql = generateAddForeignKeySql('orders', 'postgres', {
      name: 'fk_orders_customer',
      columns: ['customer_id'],
      referencedTable: 'customers',
      referencedColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id)');
    expect(sql[0]).toContain('REFERENCES customers (id)');
    expect(sql[0]).toContain('ON DELETE CASCADE');
    expect(sql[0]).not.toContain('ON UPDATE');
  });

  it('generates composite ADD FOREIGN KEY', () => {
    const sql = generateAddForeignKeySql('order_items', 'mysql', {
      name: 'fk_oi_prod',
      columns: ['tenant_id', 'product_id'],
      referencedTable: 'products',
      referencedColumns: ['tenant_id', 'id'],
      onDelete: 'CASCADE',
    });
    expect(sql[0]).toContain('FOREIGN KEY (tenant_id, product_id)');
    expect(sql[0]).toContain('REFERENCES products (tenant_id, id)');
    expect(sql[0]).toContain('ON DELETE CASCADE');
  });

  it('quotes schema.table as separate idents and qualifies with connection schema', () => {
    expect(quoteTableRef('mcve.test1', 'postgres')).toBe('mcve.test1');
    expect(quoteTableRef('My Schema.Odd-Table', 'postgres')).toBe('"My Schema"."Odd-Table"');
    expect(qualifyTableName('test1', 'mcve', 'postgres')).toBe('mcve.test1');
    expect(qualifyTableName('mcve.test1', 'other', 'postgres')).toBe('mcve.test1');
    expect(qualifyTableName('legacy_audit_log', 'demo_b', 'clickhouse')).toBe(
      'demo_b.legacy_audit_log'
    );
    expect(qualifyTableName('t', 'demo', 'sqlite')).toBe('t');

    const sql = generateAddForeignKeySql(
      'test2',
      'postgres',
      {
        name: 'fk_test2_test1',
        columns: ['test1_id2', 'test1_id1'],
        referencedTable: 'test1',
        referencedColumns: ['id2', 'id1'],
      },
      'mcve'
    );
    expect(sql[0]).toBe(
      'ALTER TABLE mcve.test2 ADD CONSTRAINT fk_test2_test1 FOREIGN KEY (test1_id2, test1_id1) REFERENCES mcve.test1 (id2, id1);'
    );
  });

  it('aligns referenced columns by local name suffix (not bare PK order)', () => {
    expect(
      matchFkReferencedColumns(
        ['test1_id2', 'test1_id1'],
        ['id1', 'id2'],
        ['id1', 'id2', 'name']
      )
    ).toEqual(['id2', 'id1']);
  });

  it('does not map paid → id via bare suffix', () => {
    expect(
      matchFkReferencedColumns(['paid', 'order_id'], ['id', 'order_id'], ['id', 'order_id'])
    ).toEqual(['id', 'order_id']); // falls back to PK order when name match fails for paid
    expect(
      matchFkReferencedColumns(['user_id'], ['id'], ['id'])
    ).toEqual(['id']);
  });

  it('reviews mismatched column counts', () => {
    const sql = generateAddForeignKeySql('t', 'postgres', {
      name: 'fk_bad',
      columns: ['a', 'b'],
      referencedTable: 'p',
      referencedColumns: ['x'],
    });
    expect(sql[0]).toMatch(/-- review:/);
    expect(sql[0]).toMatch(/column counts must match/);
  });

  it('sqlite ALTER ADD FK is review-only; CREATE TABLE inlines composite FK', () => {
    const alter = generateAddForeignKeySql('child', 'sqlite', {
      name: 'fk_child_parent',
      columns: ['a', 'b'],
      referencedTable: 'parent',
      referencedColumns: ['x', 'y'],
    });
    expect(alter[0]).toMatch(/-- review:/);
    expect(alter[0]).toMatch(/cannot ALTER TABLE ADD FOREIGN KEY/i);

    const create = generateCreateTableSql(
      'child',
      [col({ name: 'a', type: 'int' }), col({ name: 'b', type: 'int' })],
      [],
      'sqlite',
      undefined,
      [
        {
          name: 'fk_child_parent',
          columns: ['a', 'b'],
          referencedTable: 'parent',
          referencedColumns: ['x', 'y'],
        },
      ]
    );
    expect(create[0]).toContain('CONSTRAINT fk_child_parent FOREIGN KEY (a, b)');
    expect(create[0]).toContain('REFERENCES parent (x, y)');
  });

  it('clickhouse has no FK support', () => {
    expect(dialectFkConstraintSupport('clickhouse')).toMatchObject({
      alterAdd: false,
      createInline: false,
      composite: false,
    });
    const sql = generateAddForeignKeySql('t', 'clickhouse', {
      name: 'fk_x',
      columns: ['a'],
      referencedTable: 'p',
      referencedColumns: ['id'],
    });
    expect(sql[0]).toMatch(/-- review:/);
  });

  it('every registered dialect declares FK support for one or more columns', () => {
    const dialects = [
      'db2',
      'postgres',
      'mysql',
      'mariadb',
      'sqlserver',
      'oracle',
      'sqlite',
      'redshift',
      'clickhouse',
      'azuresql',
      'cockroachdb',
      'yugabytedb',
      'tidb',
      'duckdb',
    ];
    const compositeFk = {
      name: 'fk_c',
      columns: ['a', 'b'],
      referencedTable: 'parent',
      referencedColumns: ['x', 'y'],
      onDelete: 'CASCADE' as const,
    };
    for (const d of dialects) {
      const support = dialectFkConstraintSupport(d);
      expect(support, d).toBeDefined();
      if (support.alterAdd) {
        expect(support.composite, d).toBe(true);
        const sql = generateAddForeignKeySql('child', d, compositeFk);
        expect(sql[0], d).toContain('FOREIGN KEY (a, b)');
        expect(sql[0], d).toContain('REFERENCES parent (x, y)');
      } else if (support.createInline) {
        expect(support.composite, d).toBe(true);
        const create = generateCreateTableSql(
          'child',
          [col({ name: 'a', type: 'int' }), col({ name: 'b', type: 'int' })],
          [],
          d,
          undefined,
          [compositeFk]
        );
        expect(create.some((s) => s.includes('FOREIGN KEY (a, b)')), d).toBe(true);
      } else {
        expect(d).toBe('clickhouse');
      }
    }
  });

  it('generates DROP FOREIGN KEY via mysql dialect', () => {
    const sql = generateDropForeignKeySql('orders', 'mysql', 'fk_orders_customer');
    expect(sql[0]).toMatch(/DROP FOREIGN KEY/i);
  });

  it('generates mysql CREATE TRIGGER', () => {
    const sql = generateCreateTriggerSql('orders', 'mysql', {
      name: 'trg_orders_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      definition: 'BEGIN\n  SET NEW.updated_at = NOW();\nEND',
    });
    expect(sql[0]).toContain('CREATE TRIGGER trg_orders_bi BEFORE INSERT ON orders');
    expect(sql[0]).toContain('FOR EACH ROW');
  });

  it('generates postgres trigger with EXECUTE FUNCTION', () => {
    const sql = generateCreateTriggerSql('orders', 'postgres', {
      name: 'trg_orders_ai',
      timing: 'AFTER',
      event: 'INSERT',
      definition: 'EXECUTE FUNCTION audit_orders()',
    });
    expect(sql[0]).toContain('CREATE TRIGGER trg_orders_ai');
    expect(sql[0]).toContain('EXECUTE FUNCTION audit_orders()');
  });

  it('generates drop trigger', () => {
    const sql = generateDropTriggerSql('orders', 'mysql', 'trg_orders_bi');
    expect(sql[0]).toMatch(/DROP TRIGGER/i);
  });
});

describe('blueprint indexes', () => {
  it('suggests unique vs non-unique index names', () => {
    expect(suggestIndexName('orders', ['customer_id'], false)).toBe('ix_orders_customer_id');
    expect(suggestIndexName('orders', ['customer_id'], true)).toBe('ux_orders_customer_id');
  });

  it('emits CREATE INDEX with ASC/DESC and UNIQUE', () => {
    const sql = generateCreateIndexSql('orders', 'postgres', {
      name: 'ix_orders_created',
      columns: ['created_at', 'id'],
      orders: ['DESC', 'ASC'],
      unique: false,
    });
    expect(sql[0]).toBe(
      'CREATE INDEX ix_orders_created ON orders (created_at DESC, id ASC);'
    );

    const ux = generateCreateIndexSql('orders', 'mysql', {
      name: 'ux_orders_email',
      columns: ['email'],
      orders: ['ASC'],
      unique: true,
    });
    expect(ux[0]).toBe('CREATE UNIQUE INDEX ux_orders_email ON orders (email ASC);');
  });

  it('emits WHERE filter on dialects that support partial indexes', () => {
    const sql = generateCreateIndexSql('orders', 'postgres', {
      name: 'ix_orders_active',
      columns: ['customer_id'],
      orders: ['ASC'],
      unique: false,
      filter: "status = 'active'",
    });
    expect(sql[0]).toBe(
      "CREATE INDEX ix_orders_active ON orders (customer_id ASC) WHERE status = 'active';"
    );

    const mysql = generateCreateIndexSql('orders', 'mysql', {
      name: 'ix_orders_active',
      columns: ['customer_id'],
      orders: ['ASC'],
      unique: false,
      filter: "status = 'active'",
    });
    expect(mysql[0]).toMatch(/^-- review:/);
    expect(dialectIndexSupport('sqlite').filter).toBe(true);
    expect(dialectIndexSupport('mysql').filter).toBe(false);
  });

  it('emits SQL Server unique constraint when constraint flag is set', () => {
    const sql = generateCreateIndexSql('orders', 'sqlserver', {
      name: 'UQ_orders_code',
      columns: ['code'],
      orders: ['ASC'],
      unique: true,
      constraint: true,
    });
    expect(sql[0]).toMatch(/ALTER TABLE orders ADD CONSTRAINT UQ_orders_code UNIQUE \(code\);/);
  });

  it('emits DROP INDEX via dialect (MySQL ON table, SQL Server constraint)', () => {
    const mysql = generateDropIndexSql('orders', 'mysql', 'ix_orders_created');
    expect(mysql[0]).toMatch(/DROP INDEX ix_orders_created ON orders/i);

    const ss = generateDropIndexSql('orders', 'sqlserver', 'UQ_orders_code', undefined, {
      constraint: true,
    });
    expect(ss[0]).toMatch(/ALTER TABLE orders DROP CONSTRAINT UQ_orders_code/i);
  });

  it('reviews ClickHouse / Redshift create and drop', () => {
    for (const d of ['clickhouse', 'redshift']) {
      expect(dialectIndexSupport(d).create).toBe(false);
      const create = generateCreateIndexSql('t', d, {
        name: 'ix_t_a',
        columns: ['a'],
        orders: ['ASC'],
        unique: false,
      });
      expect(create[0]).toMatch(/^-- review:/);
      const drop = generateDropIndexSql('t', d, 'ix_t_a');
      expect(drop[0]).toMatch(/^-- review:/);
    }
  });

  it('appends drop then create index around FKs', () => {
    const sql = appendFkTriggerSql(['-- base'], {
      tableName: 'orders',
      dialect: 'postgres',
      dropIndexes: [{ name: 'ix_old' }],
      addIndexes: [
        {
          name: 'ix_new',
          columns: ['a'],
          orders: ['DESC'],
          unique: false,
        },
      ],
    });
    expect(sql[0]).toMatch(/DROP INDEX/i);
    expect(sql[0]).toContain('ix_old');
    expect(sql[1]).toBe('-- base');
    expect(sql.some((s) => s.includes('CREATE INDEX ix_new') && s.includes('a DESC'))).toBe(
      true
    );
  });

  it('emits DROP INDEX before column alters when both are present', () => {
    const sql = appendFkTriggerSql(['ALTER TABLE orders DROP COLUMN stale;'], {
      tableName: 'orders',
      dialect: 'postgres',
      dropIndexes: [{ name: 'ix_stale' }],
    });
    expect(sql[0]).toMatch(/DROP INDEX/i);
    expect(sql[0]).toContain('ix_stale');
    expect(sql[1]).toContain('DROP COLUMN stale');
  });
});

describe('generateTableBlueprintSql', () => {
  it('emits column alter then pk add', () => {
    const sql = generateTableBlueprintSql({
      tableName: 't',
      dialect: 'postgres',
      columnOps: [{ kind: 'add', column: col({ name: 'b', type: 'int', nullable: false }) }],
      previousPk: ['a'],
      nextPk: ['a', 'b'],
    });
    expect(sql.some((s) => s.includes('ADD COLUMN b'))).toBe(true);
    expect(sql.some((s) => s.includes('PRIMARY KEY (a, b)'))).toBe(true);
  });
});

describe('moveFkColumnsLockstep', () => {
  it('permutes referencedColumns with local columns when lengths match', () => {
    const next = moveFkColumnsLockstep(
      ['a_id', 'b_id'],
      ['a', 'b'],
      'a_id',
      1
    );
    expect(next.columns).toEqual(['b_id', 'a_id']);
    expect(next.referencedColumns).toEqual(['b', 'a']);
  });

  it('calls resync when referencedColumns length differs', () => {
    const next = moveFkColumnsLockstep(
      ['a_id', 'b_id'],
      ['a'],
      'a_id',
      1,
      (cols) => cols.map((c) => c.replace(/_id$/, ''))
    );
    expect(next.columns).toEqual(['b_id', 'a_id']);
    expect(next.referencedColumns).toEqual(['b', 'a']);
  });
});

describe('clone / archive table', () => {
  const orders = {
    name: 'orders',
    objectType: 'TABLE' as const,
    columns: [
      col({ name: 'id', type: 'integer', nullable: false, primaryKey: true }),
      col({ name: 'customer_id', type: 'integer', nullable: false }),
      col({ name: 'note', type: 'text', nullable: true }),
    ],
    indices: [
      { name: 'ix_orders_customer', columns: ['customer_id'], unique: false },
    ],
    foreignKeys: [
      {
        name: 'fk_orders_customer',
        columns: ['customer_id'],
        referencedTable: 'customers',
        referencedColumns: ['id'],
      },
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
  };

  it('nextArchiveTableName continues from highest suffix', () => {
    expect(
      nextArchiveTableName('orders', ['orders', 'orders_1', 'orders_3'], { suffixMode: 'auto' })
    ).toMatchObject({ archiveName: 'orders_4', number: 4 });
    expect(
      nextArchiveTableName('orders', ['orders'], { suffixMode: 'fixed', startNumber: 1 })
    ).toMatchObject({ archiveName: 'orders_1', number: 1 });
    expect(
      nextArchiveTableName('orders', ['orders', 'orders_1'], {
        suffixMode: 'fixed',
        startNumber: 1,
      }).error
    ).toMatch(/already exists/i);
  });

  it('generateRenameTableSql is dialect-aware', () => {
    expect(generateRenameTableSql('orders', 'orders_1', 'postgres', 'public')).toEqual([
      'ALTER TABLE public.orders RENAME TO orders_1;',
    ]);
    expect(generateRenameTableSql('orders', 'orders_1', 'mysql', 'app')).toEqual([
      'RENAME TABLE app.orders TO app.orders_1;',
    ]);
    expect(generateRenameTableSql('orders', 'orders_1', 'sqlserver', 'dbo')[0]).toContain(
      'sp_rename'
    );
  });

  it('generateCloneTableSql renames then recreates empty table with indexes and FKs', () => {
    const plan = generateCloneTableSql({
      table: orders,
      dialect: 'postgres',
      schema: 'public',
      existingTableNames: ['orders', 'customers'],
      suffixMode: 'auto',
      startNumber: 1,
      keepIndexes: true,
      keepForeignKeys: true,
    });
    expect(plan.error).toBeUndefined();
    expect(plan.archiveName).toBe('orders_1');
    const sql = plan.statements.join('\n');
    expect(sql).toContain('ALTER TABLE public.orders RENAME TO orders_1');
    expect(sql).toContain('CREATE TABLE public.orders');
    expect(sql).not.toContain('IF NOT EXISTS');
    expect(sql).toContain('CREATE INDEX ix_orders_customer ON public.orders');
    expect(sql).toContain('FOREIGN KEY');
    expect(executableSqlStatements(plan.statements).length).toBeGreaterThan(2);
  });

  it('generateCloneTableSql can skip indexes and FKs', () => {
    const plan = generateCloneTableSql({
      table: orders,
      dialect: 'postgres',
      schema: 'public',
      existingTableNames: ['orders'],
      keepIndexes: false,
      keepForeignKeys: false,
    });
    const sql = plan.statements.join('\n');
    expect(sql).not.toMatch(/CREATE INDEX ix_orders_customer ON public\.orders/);
    expect(sql).not.toContain('fk_orders_customer');
    expect(sql).toContain('ALTER TABLE public.orders RENAME TO orders_1');
    expect(sql).toContain('CREATE TABLE public.orders');
  });

  it('cockroachdb/yugabytedb free archive index names like postgres', () => {
    const plan = generateCloneTableSql({
      table: orders,
      dialect: 'cockroachdb',
      schema: 'public',
      existingTableNames: ['orders'],
      keepIndexes: true,
      keepForeignKeys: true,
    });
    const sql = plan.statements.join('\n');
    expect(sql).toContain('ALTER INDEX ix_orders_customer RENAME TO');
    expect(sql).toContain('DROP CONSTRAINT');
  });

  it('sqlserver renames archive constraints/indexes before recreate', () => {
    const plan = generateCloneTableSql({
      table: {
        ...orders,
        indices: [
          {
            name: 'ux_orders_note',
            columns: ['note'],
            unique: true,
            constraint: true,
          },
        ],
      },
      dialect: 'sqlserver',
      schema: 'dbo',
      existingTableNames: ['orders'],
      keepIndexes: true,
      keepForeignKeys: false,
    });
    const sql = plan.statements.join('\n');
    expect(sql).toContain('sp_rename');
    expect(sql).toMatch(/ux_orders_note_h1|orders_pkey_h1/);
  });

  it('sqlite clone emits INTEGER PRIMARY KEY AUTOINCREMENT', () => {
    const plan = generateCloneTableSql({
      table: {
        ...orders,
        columns: [
          col({ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, identity: true }),
          col({ name: 'customer_id', type: 'INTEGER', nullable: false }),
          col({ name: 'note', type: 'TEXT', nullable: true }),
        ],
        primaryKey: { columns: ['id'] },
      },
      dialect: 'sqlite',
      existingTableNames: ['orders', 'customers'],
      keepIndexes: true,
      keepForeignKeys: true,
    });
    const sql = executableSqlStatements(plan.statements).join('\n');
    expect(sql).toMatch(/INTEGER PRIMARY KEY AUTOINCREMENT/i);
    expect(sql).not.toMatch(/NOT NULL AUTOINCREMENT/i);
    expect(sql).toContain('ALTER TABLE orders RENAME TO orders_1');
  });

  it('findInboundForeignKeyTables lists children', () => {
    const tables = [
      orders,
      {
        name: 'order_items',
        objectType: 'TABLE' as const,
        columns: [col({ name: 'id', type: 'integer' })],
        indices: [],
        foreignKeys: [
          {
            name: 'fk_items_orders',
            columns: ['order_id'],
            referencedTable: 'orders',
            referencedColumns: ['id'],
          },
        ],
      },
    ];
    expect(findInboundForeignKeyTables(tables, 'orders')).toEqual(['order_items']);
  });
});
