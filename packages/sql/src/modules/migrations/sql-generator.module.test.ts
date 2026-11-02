import { describe, it, expect } from 'vitest';
import { SqlGeneratorModule } from './sql-generator.module.js';
import { db2SqlDialect } from '../../providers/db2/db2.sql-dialect.js';
import { DIALECT_MAP } from '../dialect/registry.js';
import { TableDiff } from '../../interfaces/index.js';
import { TableSchema } from '../../interfaces/index.js';

const gen = new SqlGeneratorModule();

const tableSchema = (over: Partial<TableSchema> & { name: string }): TableSchema => ({
  objectType: 'TABLE',
  columns: [],
  indices: [],
  foreignKeys: [],
  ...over,
});

describe('SqlGeneratorModule.generateObjectDdl', () => {
  it('renders a composite primary key as a table-level constraint', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'ORDERS',
        primaryKey: { name: 'PK_ORDERS', columns: ['ORDER_ID', 'LINE_NO'] },
        columns: [
          { name: 'ORDER_ID', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'LINE_NO', type: 'INTEGER', nullable: false, primaryKey: true },
        ],
      })
    );
    expect(ddl).toContain('CONSTRAINT PK_ORDERS PRIMARY KEY (ORDER_ID, LINE_NO)');
    // must NOT inline PRIMARY KEY per column (invalid for composite keys)
    expect(ddl).not.toMatch(/INTEGER NOT NULL PRIMARY KEY/);
  });

  it('renders an identity column', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'T',
        columns: [{ name: 'ID', type: 'INTEGER', nullable: false, primaryKey: true, identity: true, identityGeneration: 'ALWAYS' }],
      })
    );
    expect(ddl).toContain('GENERATED ALWAYS AS IDENTITY');
  });

  it('renders a sequence with its attributes', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({ name: 'SEQ', objectType: 'SEQUENCE', sequence: { dataType: 'BIGINT', start: '1', increment: '1', cache: 20 } })
    );
    expect(ddl).toContain('CREATE SEQUENCE IF NOT EXISTS SEQ AS BIGINT START WITH 1 INCREMENT BY 1');
    expect(ddl).toContain('CACHE 20');
  });

  it('renders a structured type with its attributes', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({ name: 'ADDR', objectType: 'TYPE', userType: { attributes: [{ name: 'STREET', type: 'VARCHAR(100)' }] } })
    );
    expect(ddl).toContain('CREATE TYPE ADDR AS (');
    expect(ddl).toContain('STREET VARCHAR(100)');
  });

  it('renders an Oracle object type as AS OBJECT, not DB2 MODE DB2SQL', () => {
    const t = tableSchema({ name: 'T_ADDRESS', objectType: 'TYPE',
      userType: { metaType: 'O', attributes: [{ name: 'STREET', type: 'VARCHAR2(100)' }, { name: 'CITY', type: 'VARCHAR2(50)' }] } });
    const ora = gen.generateObjectDdl(t, 'oracle');
    expect(ora).toContain('CREATE TYPE T_ADDRESS AS OBJECT (');
    expect(ora).not.toContain('MODE DB2SQL');
    // DB2 keeps its own syntax
    expect(gen.generateObjectDdl(t, 'db2')).toContain('MODE DB2SQL');
  });

  it('renders a SQL Server user type as CREATE TYPE ... FROM, not DB2 MODE DB2SQL', () => {
    const t = tableSchema({ name: 'EMAIL_TYPE', objectType: 'TYPE', userType: { sourceType: 'varchar(255)', metaType: 'D' } });
    const ss = gen.generateObjectDdl(t, 'sqlserver');
    expect(ss).toBe('CREATE TYPE EMAIL_TYPE FROM varchar(255);');
    expect(ss).not.toContain('MODE DB2SQL');
  });

  it('renders MariaDB CREATE SEQUENCE with single-token NOCYCLE/NOCACHE', () => {
    const t = tableSchema({ name: 'PLAIN_SEQ', objectType: 'SEQUENCE', sequence: { start: '1', increment: '1', cycle: false, cache: 0 } });
    const ddl = gen.generateObjectDdl(t, 'mariadb');
    expect(ddl).toContain('NOCYCLE');
    expect(ddl).toContain('NOCACHE');
    expect(ddl).not.toMatch(/NO CYCLE|NO CACHE/);
    expect(ddl).toContain('CREATE SEQUENCE IF NOT EXISTS PLAIN_SEQ');
  });
});

describe('SqlGeneratorModule.generateMigrationPlan', () => {
  const addedTable = (name: string): TableDiff => ({
    tableName: name,
    objectType: 'TABLE',
    status: 'ADDED',
    columnDiffs: [],
    indexDiffs: [],
    foreignKeyDiffs: [],
    sourceTable: tableSchema({ name, columns: [{ name: 'ID', type: 'INTEGER', nullable: false, primaryKey: false }] }),
  });

  describe('DB2 caps DECIMAL precision', () => {
    it('narrows a precision Db2 cannot store, and says so', () => {
      // Postgres, Oracle and SQL Server all allow 38 digits; Db2 stops at 31
      // and answers SQL0604N above it (verified on 11.5: 31 ok, 32 fails). The
      // precision used to pass straight through, so a cross-dialect migration
      // died at CREATE TABLE — after the plan had been reviewed and accepted.
      const pg = DIALECT_MAP.POSTGRES!;
      const wide = db2SqlDialect.renderType(pg.parseType('numeric(38,2)'));
      expect(wide.sql).toBe('DECIMAL(31,2)');
      expect(wide.warning).toMatch(/31/);
    });

    it('leaves a precision it can store untouched, with no warning', () => {
      const pg = DIALECT_MAP.POSTGRES!;
      for (const spec of ['numeric(31,2)', 'numeric(10,2)']) {
        const out = db2SqlDialect.renderType(pg.parseType(spec));
        expect(out.warning, spec).toBeUndefined();
      }
    });
  });

  describe('DB2 tolerates a foreign key that is already gone', () => {
    it('wraps the FK drop in the same 42704 handler as its other drops', () => {
      // Dropping a parent table takes its inbound foreign keys with it, and
      // table drops are ordered before the ALTERs — so by the time the explicit
      // FK drop runs, the constraint often no longer exists. DB2 has no DROP
      // CONSTRAINT IF EXISTS, and DB2 has transactional DDL, so the resulting
      // SQL0204N rolled the *entire* migration back: on the live samples the
      // revert reported no error and changed nothing at all.
      const sql = db2SqlDialect.dropForeignKeyStatement!('S.CHILD', 'FK_CHILD_PARENT');
      expect(sql).toContain("SQLSTATE '42704'");
      expect(sql).toContain('DROP FOREIGN KEY FK_CHILD_PARENT');
    });

    it('still drops the constraint it was asked to drop', () => {
      const sql = db2SqlDialect.dropForeignKeyStatement!('S.CHILD', 'FK_X');
      expect(sql).toMatch(/ALTER TABLE S\.CHILD DROP FOREIGN KEY FK_X/);
    });
  });

  describe('DB2 converges after adding a NOT NULL column', () => {
    // DB2 cannot add a NOT NULL column to a populated table without a default
    // (SQL0193N), so the dialect appends `WITH DEFAULT`. That leaves the column
    // holding a default the source never declared, and the next comparison
    // reports the same change again — for ever. Verified end to end against the
    // shipped DEMO_A/DEMO_B samples on DB2 11.5: with this, re-comparing after
    // the migration reports no differences at all.
    const addNotNull = (over: Partial<{ nullable: boolean; defaultValue: string }> = {}): TableDiff => ({
      tableName: 'PRODUCTS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        {
          name: 'SKU',
          status: 'ADDED',
          source: { name: 'SKU', type: 'VARCHAR(50)', nullable: false, ...over },
        },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'PRODUCTS' }),
      targetTable: tableSchema({ name: 'PRODUCTS' }),
    });

    it('drops the implicit default it had to add', () => {
      const sql = gen.generateMigrationPlan([addNotNull()], 'db2').flatMap((s) => s.statements);
      const add = sql.findIndex((s) => /ADD\b/i.test(s) && /WITH DEFAULT/i.test(s));
      const drop = sql.findIndex((s) => /DROP DEFAULT/i.test(s));
      expect(add, 'no ADD … WITH DEFAULT emitted').toBeGreaterThanOrEqual(0);
      expect(drop, 'the implicit default is never dropped — this never converges').toBeGreaterThan(add);
    });

    it('keeps a default the source actually declares', () => {
      const sql = gen
        .generateMigrationPlan([addNotNull({ defaultValue: "'x'" })], 'db2')
        .flatMap((s) => s.statements)
        .join('\n');
      expect(sql).toContain("DEFAULT 'x'");
      expect(sql, 'dropped a default the source asked for').not.toMatch(/DROP DEFAULT/i);
    });

    it('leaves a nullable column alone', () => {
      const sql = gen
        .generateMigrationPlan([addNotNull({ nullable: true })], 'db2')
        .flatMap((s) => s.statements)
        .join('\n');
      expect(sql).not.toMatch(/DROP DEFAULT/i);
    });

    it('does not touch other dialects', () => {
      for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle']) {
        const sql = gen.generateMigrationPlan([addNotNull()], dialect).flatMap((s) => s.statements).join('\n');
        expect(sql, dialect).not.toMatch(/DROP DEFAULT/i);
      }
    });
  });

  describe('DB2 reorg-pending after column changes', () => {
    // Verified against DB2 11.5: after ALTER TABLE … DROP COLUMN, a SELECT
    // still succeeds while every INSERT fails with SQL0668N reason code 7. A
    // migration without the REORG therefore reports success and hands back a
    // table nobody can write to — and because reads work, it can be a long
    // while before anyone notices.
    const droppedColumn: TableDiff = {
      tableName: 'CUSTOMER',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'OLD_COL', status: 'REMOVED', target: { name: 'old_col', type: 'VARCHAR(10)', nullable: true } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'customer' }),
      targetTable: tableSchema({ name: 'customer' }),
    };

    it('reorgs the table after a DROP COLUMN', () => {
      const sql = gen.generateMigrationPlan([droppedColumn], 'db2').flatMap((s) => s.statements);
      const drop = sql.findIndex((s) => /DROP COLUMN/i.test(s));
      const reorg = sql.findIndex((s) => /REORG TABLE/i.test(s));
      expect(drop, 'no DROP COLUMN emitted').toBeGreaterThanOrEqual(0);
      expect(reorg, 'no REORG emitted — the table stays unwritable').toBeGreaterThan(drop);
      // ADMIN_CMD is the callable form; bare `REORG TABLE` is a CLP command
      // and cannot be sent over a client connection.
      expect(sql[reorg]).toContain('SYSPROC.ADMIN_CMD');
    });

    it('does not reorg when nothing was dropped or retyped', () => {
      const added: TableDiff = {
        ...droppedColumn,
        columnDiffs: [
          { name: 'NEW_COL', status: 'ADDED', source: { name: 'new_col', type: 'VARCHAR(10)', nullable: true } },
        ],
      };
      const sql = gen.generateMigrationPlan([added], 'db2').flatMap((s) => s.statements).join('\n');
      expect(sql).toMatch(/ADD/i);
      expect(sql).not.toMatch(/REORG/i);
    });

    it('leaves other dialects alone', () => {
      // Only DB2 implements the hook; nobody else should grow a REORG.
      for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle', 'sqlite']) {
        const sql = gen.generateMigrationPlan([droppedColumn], dialect).flatMap((s) => s.statements).join('\n');
        expect(sql, dialect).not.toMatch(/REORG/i);
      }
    });
  });

  it('orders steps drop → create → alter', () => {
    const diffs: TableDiff[] = [
      { ...addedTable('NEW') },
      { tableName: 'OLD', objectType: 'TABLE', status: 'REMOVED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [], targetTable: tableSchema({ name: 'OLD' }) },
    ];
    const plan = gen.generateMigrationPlan(diffs, 'db2');
    expect(plan.map((s) => s.action)).toEqual(['DROP', 'CREATE']);
  });

  it('re-qualifies object names to the target schema regardless of source prefix', () => {
    const plan = gen.generateMigrationPlan([addedTable('CARTER.GPX')], 'db2', { sourceSchema: 'HUY', targetSchema: 'VLAD' });
    const sql = plan.flatMap((s) => s.statements).join('\n');
    expect(sql).toContain('CREATE TABLE VLAD.GPX');
    expect(sql).not.toContain('CARTER.');
  });

  it('emits nothing when there are no changes', () => {
    const plan = gen.generateMigrationPlan([
      { tableName: 'A', objectType: 'TABLE', status: 'UNCHANGED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [] },
    ], 'db2');
    expect(plan).toHaveLength(0);
  });

  it('translates source column types into the target dialect (DB2 → Postgres)', () => {
    const diff: TableDiff = {
      tableName: 'DOC',
      objectType: 'TABLE',
      status: 'ADDED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        name: 'DOC',
        columns: [
          { name: 'ID', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'BODY', type: 'CLOB(1048576)', nullable: true, primaryKey: false },
          { name: 'AMT', type: 'DECIMAL(10,2)', nullable: true, primaryKey: false },
        ],
      }),
    };
    const sql = gen.generateMigrationPlan([diff], 'postgres', { sourceDialect: 'db2' }).flatMap((s) => s.statements).join('\n');
    expect(sql).toContain('BODY text');
    expect(sql).toContain('AMT numeric(10,2)');
    expect(sql).not.toContain('CLOB');
  });

  it('creates the backing sequence before a Postgres serial table (cross-schema)', () => {
    const diff: TableDiff = {
      tableName: 'demo_b.PRODUCTS',
      objectType: 'TABLE',
      status: 'ADDED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        name: 'demo_b.PRODUCTS',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true, defaultValue: "nextval('demo_b.products_id_seq'::regclass)" },
          { name: 'name', type: 'varchar(200)', nullable: false, primaryKey: false },
        ],
      }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', {
      sourceDialect: 'postgres', sourceSchema: 'demo_b', targetSchema: 'app',
    }).flatMap((s) => s.statements);
    const createSeqIdx = stmts.findIndex((s) => /CREATE SEQUENCE IF NOT EXISTS app\.products_id_seq;/.test(s));
    const createTblIdx = stmts.findIndex((s) => /CREATE TABLE app\.PRODUCTS/.test(s));
    expect(createSeqIdx).toBeGreaterThanOrEqual(0);
    // sequence must be created BEFORE the table that references it
    expect(createSeqIdx).toBeLessThan(createTblIdx);
    // and the column default must resolve to the same (remapped) sequence
    expect(stmts.some((s) => s.includes("nextval('app.products_id_seq'::regclass)"))).toBe(true);
    expect(stmts.some((s) => /ALTER SEQUENCE app\.products_id_seq OWNED BY app\.PRODUCTS\.id;/.test(s))).toBe(true);
  });

  it('does not emit CREATE SEQUENCE for non-Postgres targets', () => {
    const diff: TableDiff = {
      tableName: 'PRODUCTS', objectType: 'TABLE', status: 'ADDED',
      columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'PRODUCTS', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, identity: true }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'db2').flatMap((s) => s.statements);
    expect(stmts.some((s) => /CREATE SEQUENCE/.test(s))).toBe(false);
  });

  it('is a no-op for same-dialect migrations (raw type preserved)', () => {
    const diff: TableDiff = {
      tableName: 'DOC',
      objectType: 'TABLE',
      status: 'ADDED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'DOC', columns: [{ name: 'BODY', type: 'CLOB', nullable: true, primaryKey: false }] }),
    };
    const sql = gen.generateMigrationPlan([diff], 'db2', { sourceDialect: 'db2' }).flatMap((s) => s.statements).join('\n');
    expect(sql).toContain('BODY CLOB');
  });

  it('emits a manual-review block for procedural objects across dialects', () => {
    const diff: TableDiff = {
      tableName: 'V_ORDERS',
      objectType: 'VIEW',
      status: 'ADDED',
      definition: 'CREATE VIEW V_ORDERS AS SELECT * FROM ORDERS',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', { sourceDialect: 'oracle' }).flatMap((s) => s.statements);
    expect(stmts.some((s) => s.includes('MANUAL REVIEW REQUIRED'))).toBe(true);
    // the raw body must not be emitted as an executable statement
    expect(stmts.some((s) => /^\s*CREATE VIEW/.test(s))).toBe(false);
  });

  it('creates an ADDED function before a MODIFIED table\'s ALTER step adds a trigger that calls it', () => {
    // Regression: a MODIFIED table's ALTER can add a new trigger whose EXECUTE
    // FUNCTION clause calls a function that is itself only ADDED in this same
    // migration. The function must be created before the ALTER runs, not after.
    const modifiedTableWithNewTrigger: TableDiff = {
      tableName: 'CUSTOMERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      triggerDiffs: [{
        name: 'TRG_CUSTOMER_CREATED',
        status: 'ADDED',
        source: { name: 'TRG_CUSTOMER_CREATED', definition: 'CREATE TRIGGER TRG_CUSTOMER_CREATED BEFORE INSERT ON CUSTOMERS FOR EACH ROW EXECUTE FUNCTION TRG_UPDATE_TS()' },
      }],
    };
    const addedFunction: TableDiff = {
      tableName: 'TRG_UPDATE_TS',
      objectType: 'FUNCTION',
      status: 'ADDED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      definition: 'CREATE FUNCTION TRG_UPDATE_TS() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$',
    };
    const steps = gen.generateMigrationPlan([modifiedTableWithNewTrigger, addedFunction], 'postgres');
    const functionStepIndex = steps.findIndex((s) => s.objectType === 'FUNCTION');
    const alterStepIndex = steps.findIndex((s) => s.objectType === 'TABLE' && s.action === 'ALTER');
    expect(functionStepIndex).toBeGreaterThanOrEqual(0);
    expect(alterStepIndex).toBeGreaterThanOrEqual(0);
    expect(functionStepIndex).toBeLessThan(alterStepIndex);
  });

  it('drops a MODIFIED function with a bare name on MySQL (no parenthesized signature)', () => {
    // Regression: MySQL/MariaDB/SQL Server reject ANY parenthesized signature on
    // DROP FUNCTION, even an empty one — only Postgres/Redshift support overloading.
    const diff: TableDiff = {
      tableName: 'FN_GET_DISCOUNT',
      objectType: 'FUNCTION',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      definition: 'CREATE FUNCTION FN_GET_DISCOUNT(p_price DECIMAL(10,2), p_qty INT) RETURNS DECIMAL(10,2) ...',
      sourceTable: tableSchema({
        name: 'FN_GET_DISCOUNT',
        objectType: 'FUNCTION',
        parameters: [
          { name: 'p_price', type: 'decimal(10,2)', mode: 'IN' },
          { name: 'p_qty', type: 'int', mode: 'IN' },
        ],
      }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'mysql').flatMap((s) => s.statements);
    expect(stmts).toContain('DROP FUNCTION IF EXISTS FN_GET_DISCOUNT;');
    expect(stmts.some((s) => /DROP FUNCTION IF EXISTS FN_GET_DISCOUNT\(/.test(s))).toBe(false);
  });

  it('drops a MODIFIED function with its parameter signature on Postgres', () => {
    const diff: TableDiff = {
      tableName: 'FN_GET_DISCOUNT',
      objectType: 'FUNCTION',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      definition: 'CREATE FUNCTION FN_GET_DISCOUNT(p_price numeric, p_qty integer) RETURNS numeric ...',
      sourceTable: tableSchema({
        name: 'FN_GET_DISCOUNT',
        objectType: 'FUNCTION',
        parameters: [
          { name: 'p_price', type: 'numeric', mode: 'IN' },
          { name: 'p_qty', type: 'integer', mode: 'IN' },
        ],
      }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts).toContain('DROP FUNCTION IF EXISTS FN_GET_DISCOUNT(numeric, integer);');
  });

  it('drops then recreates a modified trigger', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      triggerDiffs: [{ name: 'TRG', status: 'MODIFIED', source: { name: 'TRG', definition: 'CREATE TRIGGER TRG ...' } }],
    };
    const stmts = gen.generateMigrationPlan([diff], 'db2').flatMap((s) => s.statements);
    expect(stmts).toContain('DROP TRIGGER TRG;');
    expect(stmts.some((s) => s.includes('CREATE TRIGGER TRG'))).toBe(true);
  });

  it('guards Postgres column changes with a correct pg_depend/pg_rewrite view block', () => {
    const diff: TableDiff = {
      tableName: 'app.ORDERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'TOTAL', status: 'MODIFIED', source: { type: 'numeric(12,2)', nullable: false }, target: { type: 'numeric(10,2)', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', { targetSchema: 'app' }).flatMap((s) => s.statements);
    const preIdx = stmts.findIndex((s) => s.includes('$fs_pre$'));
    const alterIdx = stmts.findIndex((s) => /ALTER COLUMN TOTAL TYPE/i.test(s));
    const postIdx = stmts.findIndex((s) => s.includes('$fs_post$'));
    // pre-drop → alter → post-recreate ordering
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(preIdx);
    expect(postIdx).toBeGreaterThan(alterIdx);
    // the discovery query MUST hop pg_depend -> pg_rewrite -> pg_class, else it finds
    // zero views (objid is a rewrite-rule oid, not the view's pg_class oid).
    const pre = stmts[preIdx];
    expect(pre).toContain('pg_rewrite');
    expect(pre).toContain('rw.ev_class');
    expect(pre).toMatch(/refobjid = 'app\.ORDERS'::regclass/);
    // recreate must re-RAISE on failure (never swallow) so the whole migration rolls
    // back, but with a clear Fox message rather than a bare catalog error.
    expect(stmts[postIdx]).toMatch(/RAISE EXCEPTION 'Fox:/);
  });

  it('guards a Postgres DROP COLUMN (not just type changes) but skips ADD-only changes', () => {
    const removed: TableDiff = {
      tableName: 'app.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'OLD_COL', status: 'REMOVED', target: { type: 'integer', nullable: true } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'app.ORDERS', columns: [] }),
    };
    const addOnly: TableDiff = {
      tableName: 'app.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'NEW_COL', status: 'ADDED', source: { type: 'integer', nullable: true } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'app.ORDERS', columns: [] }),
    };
    const removedStmts = gen.generateMigrationPlan([removed], 'postgres').flatMap((s) => s.statements);
    const addStmts = gen.generateMigrationPlan([addOnly], 'postgres').flatMap((s) => s.statements);
    // DROP COLUMN can be blocked by a dependent view -> must be guarded
    expect(removedStmts.some((s) => s.includes('$fs_pre$'))).toBe(true);
    // ADD COLUMN is never blocked by a view -> no need for the view dance
    expect(addStmts.some((s) => s.includes('$fs_pre$'))).toBe(false);
  });

  it('applies a changed column DEFAULT and creates the referenced sequence (Postgres)', () => {
    const diff: TableDiff = {
      tableName: 'app.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [
        { name: 'id', status: 'MODIFIED',
          source: { type: 'integer', nullable: false, defaultValue: "nextval('order_seq'::regclass)" },
          target: { type: 'integer', nullable: false, defaultValue: "nextval('orders_id_seq'::regclass)" } },
      ],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'app.ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', { targetSchema: 'app' }).flatMap((s) => s.statements);
    expect(stmts.some((s) => /CREATE SEQUENCE IF NOT EXISTS app\.order_seq;/.test(s))).toBe(true);
    expect(stmts.some((s) => /ALTER COLUMN id SET DEFAULT nextval\('order_seq'::regclass\)/i.test(s))).toBe(true);
  });

  it('drops a column DEFAULT when the source no longer has one', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [
        { name: 'status', status: 'MODIFIED',
          source: { type: 'varchar(20)', nullable: false },
          target: { type: 'varchar(20)', nullable: false, defaultValue: "'PENDING'" } },
      ],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts.some((s) => /ALTER COLUMN status DROP DEFAULT;/.test(s))).toBe(true);
  });

  it('does NOT emit a raw DEFAULT across dialects — flags it for review instead', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [
        { name: 'created_at', status: 'MODIFIED',
          source: { type: 'TIMESTAMP', nullable: false, defaultValue: 'SYSDATE' },
          target: { type: 'timestamp', nullable: false, defaultValue: 'now()' } },
      ],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', { sourceDialect: 'oracle' }).flatMap((s) => s.statements);
    expect(stmts.some((s) => /-- review:.*default 'SYSDATE'/i.test(s))).toBe(true);
    expect(stmts.some((s) => /SET DEFAULT SYSDATE/i.test(s))).toBe(false);
  });

  it('drops an index BEFORE dropping the column it covers (avoids cascade "index does not exist")', () => {
    const diff: TableDiff = {
      tableName: 'demo_b.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [
        { name: 'CUSTOMER_ID', status: 'REMOVED', target: { type: 'integer', nullable: false } },
      ],
      indexDiffs: [
        { name: 'IDX_B_ORDERS_CUSTOMER', status: 'REMOVED', target: { columns: ['CUSTOMER_ID'], unique: false } },
      ],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'demo_b.ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres', { targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    const dropIdxIdx = stmts.findIndex((s) => /DROP INDEX .*IDX_B_ORDERS_CUSTOMER/i.test(s));
    const dropColIdx = stmts.findIndex((s) => /DROP COLUMN CUSTOMER_ID/i.test(s));
    expect(dropIdxIdx).toBeGreaterThanOrEqual(0);
    expect(dropColIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdxIdx).toBeLessThan(dropColIdx);
  });

  it('non-destructive mode adds + modifies but never drops', () => {
    const removedTable: TableDiff = {
      tableName: 'OLD_T', objectType: 'TABLE', status: 'REMOVED',
      columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [], targetTable: tableSchema({ name: 'OLD_T' }),
    };
    const modified: TableDiff = {
      tableName: 'app.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [
        { name: 'USER_ID', status: 'ADDED', source: { type: 'integer', nullable: false } },
        { name: 'CUSTOMER_ID', status: 'REMOVED', target: { type: 'integer', nullable: false } },
        { name: 'TOTAL', status: 'MODIFIED', source: { type: 'numeric(10,2)', nullable: true }, target: { type: 'numeric(12,2)', nullable: false } },
      ],
      indexDiffs: [
        { name: 'IDX_ORDERS_USER', status: 'ADDED', source: { columns: ['USER_ID'], unique: false } },
        { name: 'IDX_B_ORDERS_CUSTOMER', status: 'REMOVED', target: { columns: ['CUSTOMER_ID'], unique: false } },
      ],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'app.ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([removedTable, modified], 'postgres', { targetSchema: 'app', nonDestructive: true })
      .flatMap((s) => s.statements);
    const joined = stmts.join('\n');
    // adds + modifies happen
    expect(joined).toMatch(/ADD COLUMN USER_ID/i);
    expect(joined).toMatch(/CREATE INDEX IDX_ORDERS_USER/i);
    expect(joined).toMatch(/ALTER COLUMN TOTAL TYPE/i);
    // nothing in the target is dropped (the only DROP TABLE allowed is the view-guard's
    // internal ON COMMIT DROP scratch table, never a real object like OLD_T)
    expect(joined).not.toMatch(/DROP COLUMN/i);
    expect(joined).not.toMatch(/DROP INDEX/i);
    expect(joined).not.toMatch(/DROP TABLE OLD_T/i);
    expect(joined).not.toMatch(/DROP TABLE app\./i);
  });

  it('the same diffs DO drop in normal (destructive) mode', () => {
    const modified: TableDiff = {
      tableName: 'app.ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'CUSTOMER_ID', status: 'REMOVED', target: { type: 'integer', nullable: false } }],
      indexDiffs: [{ name: 'IDX_B_ORDERS_CUSTOMER', status: 'REMOVED', target: { columns: ['CUSTOMER_ID'], unique: false } }],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'app.ORDERS', columns: [] }),
    };
    const stmts = gen.generateMigrationPlan([modified], 'postgres', { targetSchema: 'app' }).flatMap((s) => s.statements).join('\n');
    expect(stmts).toMatch(/DROP COLUMN CUSTOMER_ID/i);
    expect(stmts).toMatch(/DROP INDEX/i);
  });

  it('does NOT emit pg_depend guard blocks for non-Postgres targets', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'TOTAL', status: 'MODIFIED', source: { type: 'DECIMAL(12,2)', nullable: false }, target: { type: 'DECIMAL(10,2)', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
    };
    const stmts = gen.generateMigrationPlan([diff], 'db2').flatMap((s) => s.statements);
    expect(stmts.some((s) => s.includes('pg_depend'))).toBe(false);
    expect(stmts.some((s) => s.includes('_fs_vdep'))).toBe(false);
  });

  it('CockroachDB emits DROP VIEW before structural ALTER when a dependent target view exists', () => {
    const modified: TableDiff = {
      tableName: 'ORDER_ITEMS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'QTY', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'smallint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'smallint', nullable: false, primaryKey: false }] }),
    };
    const removedView: TableDiff = {
      tableName: 'V_ORDER_SUMMARY',
      objectType: 'VIEW',
      status: 'REMOVED',
      definition: 'SELECT oi.qty FROM demo_b.order_items oi',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: 'SELECT oi.qty FROM demo_b.order_items oi',
        columns: [],
      }),
    };
    const stmts = gen.generateMigrationPlan(
      [modified, removedView],
      'cockroachdb',
      { targetSchema: 'demo_b', nonDestructive: true },
      [modified, removedView]
    ).flatMap((s) => s.statements).join('\n');
    expect(stmts).toMatch(/DROP VIEW IF EXISTS demo_b\.v_order_summary/i);
    expect(stmts).toMatch(/ALTER COLUMN QTY TYPE/i);
    // Non-destructive REMOVED view is recreated from the target definition.
    expect(stmts).toMatch(/CREATE OR REPLACE VIEW demo_b\.v_order_summary/i);
    // No Postgres DO-block guard.
    expect(stmts).not.toMatch(/pg_depend|ON COMMIT DROP|_fs_vdep/i);
  });

  it('CockroachDB does not DROP views that only mention the table name as a column or keyword', () => {
    const modifiedStatus: TableDiff = {
      tableName: 'STATUS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'ID', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'bigint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'status', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'status', columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: false }] }),
    };
    // Column named `status` — must not count as a dependency on table `status`.
    const columnOnlyView: TableDiff = {
      tableName: 'V_PRODUCTS',
      objectType: 'VIEW',
      status: 'UNCHANGED',
      definition: 'SELECT id, status FROM demo_b.products',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({
        name: 'v_products',
        objectType: 'VIEW',
        definition: 'SELECT id, status FROM demo_b.products',
        columns: [],
      }),
    };
    const modifiedOrder: TableDiff = {
      tableName: 'ORDER',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'ID', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'bigint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order', columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: false }] }),
    };
    // `ORDER BY` must not match table `order`.
    const orderByView: TableDiff = {
      tableName: 'V_P',
      objectType: 'VIEW',
      status: 'UNCHANGED',
      definition: 'SELECT id FROM demo_b.products ORDER BY id',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({
        name: 'v_p',
        objectType: 'VIEW',
        definition: 'SELECT id FROM demo_b.products ORDER BY id',
        columns: [],
      }),
    };
    const realDep: TableDiff = {
      tableName: 'V_STATUS',
      objectType: 'VIEW',
      status: 'UNCHANGED',
      definition: 'SELECT id FROM demo_b.status',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({
        name: 'v_status',
        objectType: 'VIEW',
        definition: 'SELECT id FROM demo_b.status',
        columns: [],
      }),
    };

    const falseColumn = gen.generateMigrationPlan(
      [modifiedStatus],
      'cockroachdb',
      { targetSchema: 'demo_b' },
      [modifiedStatus, columnOnlyView]
    ).flatMap((s) => s.statements).join('\n');
    expect(falseColumn).toMatch(/ALTER COLUMN ID TYPE/i);
    expect(falseColumn).not.toMatch(/DROP VIEW/i);

    const falseOrderBy = gen.generateMigrationPlan(
      [modifiedOrder],
      'cockroachdb',
      { targetSchema: 'demo_b' },
      [modifiedOrder, orderByView]
    ).flatMap((s) => s.statements).join('\n');
    expect(falseOrderBy).toMatch(/ALTER COLUMN ID TYPE/i);
    expect(falseOrderBy).not.toMatch(/DROP VIEW/i);

    const real = gen.generateMigrationPlan(
      [modifiedStatus],
      'cockroachdb',
      { targetSchema: 'demo_b' },
      [modifiedStatus, realDep]
    ).flatMap((s) => s.statements).join('\n');
    expect(real).toMatch(/DROP VIEW IF EXISTS demo_b\.v_status/i);
  });

  it('CockroachDB does not DROP a body-less dependent (no recreate DDL)', () => {
    const modified: TableDiff = {
      tableName: 'ORDER_ITEMS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'QTY', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'smallint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'smallint', nullable: false, primaryKey: false }] }),
    };
    // Compare omitted the routine body — without DDL we must not DROP it.
    const fnNoBody: TableDiff = {
      tableName: 'FN_QTY',
      objectType: 'FUNCTION',
      status: 'UNCHANGED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({ name: 'fn_qty', objectType: 'FUNCTION' }),
    };
    const stmts = gen.generateMigrationPlan(
      [modified],
      'cockroachdb',
      { targetSchema: 'demo_b' },
      [modified, fnNoBody]
    ).flatMap((s) => s.statements).join('\n');
    expect(stmts).toMatch(/ALTER COLUMN QTY TYPE/i);
    expect(stmts).not.toMatch(/DROP FUNCTION/i);
    expect(stmts).not.toMatch(/DROP VIEW/i);
  });

  it('CockroachDB finds the dependency in the three-part name it actually reports', () => {
    // Every other CockroachDB fixture here writes `demo_b.order_items`, and
    // that is not what the engine returns. `information_schema.views` on
    // CockroachDB v26.3.0 qualifies with the database as well:
    //
    //   SELECT ... FROM foxdb.demo_b.orders AS o
    //     JOIN foxdb.demo_b.order_items AS oi ON oi.order_id = o.id
    //
    // the reference pattern allowed one optional qualifier, so it matched
    // `demo_b.order_items` and missed `foxdb.demo_b.order_items`. The
    // dependency went unseen, the view was never dropped around the ALTER, and
    // the migration died at apply time on the live engine:
    // "cannot alter type of column \"qty\" because view \"v_order_summary\"
    // depends on it".
    const crdbViewDef =
      'SELECT o.id, oi.qty FROM foxdb.demo_b.orders AS o ' +
      'JOIN foxdb.demo_b.order_items AS oi ON oi.order_id = o.id';
    const modified: TableDiff = {
      tableName: 'ORDER_ITEMS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'QTY', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'smallint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'smallint', nullable: false, primaryKey: false }] }),
    };
    const dependentView: TableDiff = {
      tableName: 'V_ORDER_SUMMARY',
      objectType: 'VIEW',
      status: 'MODIFIED',
      definition: crdbViewDef,
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: crdbViewDef,
        columns: [],
      }),
      targetTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: crdbViewDef,
        columns: [],
      }),
    };
    const plan = gen.generateMigrationPlan(
      [modified, dependentView],
      'cockroachdb',
      { targetSchema: 'demo_b', nonDestructive: true },
      [modified, dependentView]
    );
    const alterSql = plan
      .filter((s) => s.action === 'ALTER')
      .flatMap((s) => s.statements)
      .join('\n');

    expect(alterSql).toMatch(/ALTER COLUMN QTY TYPE/i);
    // The view must come out of the way first, or the ALTER cannot run.
    expect(alterSql, 'dependent view not dropped before the ALTER').toMatch(/DROP VIEW/i);
    expect(alterSql.indexOf('DROP VIEW')).toBeLessThan(alterSql.search(/ALTER COLUMN QTY TYPE/i));
  });

  it('CockroachDB does not temporary-DROP a destructively removed dependent', () => {
    const modified: TableDiff = {
      tableName: 'ORDER_ITEMS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'QTY', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'smallint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'smallint', nullable: false, primaryKey: false }] }),
    };
    const removedView: TableDiff = {
      tableName: 'V_ORDER_SUMMARY',
      objectType: 'VIEW',
      status: 'REMOVED',
      definition: 'SELECT oi.qty FROM demo_b.order_items oi',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: 'SELECT oi.qty FROM demo_b.order_items oi',
        columns: [],
      }),
    };
    // Destructive: view is intentionally dropped in the DROP phase — ALTER must
    // not emit a second temporary DROP/CREATE pair for it.
    const plan = gen.generateMigrationPlan(
      [modified, removedView],
      'cockroachdb',
      { targetSchema: 'demo_b', nonDestructive: false },
      [modified, removedView]
    );
    const alterSql = plan
      .filter((s) => s.action === 'ALTER')
      .flatMap((s) => s.statements)
      .join('\n');
    expect(alterSql).toMatch(/ALTER COLUMN QTY TYPE/i);
    expect(alterSql).not.toMatch(/DROP VIEW/i);
    expect(alterSql).not.toMatch(/CREATE OR REPLACE VIEW/i);
  });

  it('CockroachDB recreates unchecked MODIFIED dependents from target DDL', () => {
    const modified: TableDiff = {
      tableName: 'ORDER_ITEMS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'QTY', status: 'MODIFIED', source: { type: 'integer', nullable: false }, target: { type: 'smallint', nullable: false } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'integer', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'order_items', columns: [{ name: 'qty', type: 'smallint', nullable: false, primaryKey: false }] }),
    };
    const uncheckedView: TableDiff = {
      tableName: 'V_ORDER_SUMMARY',
      objectType: 'VIEW',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: 'SELECT oi.qty AS source_qty FROM demo_b.order_items oi',
        columns: [],
      }),
      targetTable: tableSchema({
        name: 'v_order_summary',
        objectType: 'VIEW',
        definition: 'SELECT oi.qty AS target_qty FROM demo_b.order_items oi',
        columns: [],
      }),
    };
    // Only the table is selected; the MODIFIED view is context-only.
    const stmts = gen.generateMigrationPlan(
      [modified],
      'cockroachdb',
      { targetSchema: 'demo_b' },
      [modified, uncheckedView]
    ).flatMap((s) => s.statements).join('\n');
    expect(stmts).toMatch(/DROP VIEW IF EXISTS demo_b\.v_order_summary/i);
    expect(stmts).toMatch(/target_qty/);
    expect(stmts).not.toMatch(/source_qty/);
  });

  it('includes USING cast in Postgres ALTER COLUMN TYPE', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: 'amount', status: 'MODIFIED', source: { type: 'numeric(15,2)', nullable: true }, target: { type: 'numeric(10,2)', nullable: true } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDERS', columns: [{ name: 'amount', type: 'numeric(15,2)', nullable: true, primaryKey: false }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts.some((s) => /ALTER COLUMN amount TYPE.*USING amount::/i.test(s))).toBe(true);
  });

  it('SQL Server drops/creates a unique-constraint index via ALTER TABLE CONSTRAINT, not DROP/CREATE INDEX', () => {
    const diff: TableDiff = {
      tableName: 'CUSTOMERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [
        { name: 'UQ__CUSTOMER__AB6E', status: 'REMOVED', target: { columns: ['EMAIL'], unique: true, constraint: true } },
        { name: 'UQ_EMAIL', status: 'ADDED', source: { columns: ['EMAIL'], unique: true, constraint: true } },
      ],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'CUSTOMERS', columns: [{ name: 'EMAIL', type: 'VARCHAR(255)', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'CUSTOMERS', columns: [{ name: 'EMAIL', type: 'VARCHAR(255)', nullable: false, primaryKey: false }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'sqlserver', { targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    expect(stmts).toContain('ALTER TABLE demo_b.CUSTOMERS DROP CONSTRAINT UQ__CUSTOMER__AB6E;');
    expect(stmts).toContain('ALTER TABLE demo_b.CUSTOMERS ADD CONSTRAINT UQ_EMAIL UNIQUE (EMAIL);');
    expect(stmts.some((s) => /DROP INDEX|CREATE\s+UNIQUE\s+INDEX/i.test(s))).toBe(false);
  });

  it('SQL Server still uses DROP/CREATE INDEX for a plain (non-constraint) unique index', () => {
    const diff: TableDiff = {
      tableName: 'CUSTOMERS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [{ name: 'IX_EMAIL', status: 'REMOVED', target: { columns: ['EMAIL'], unique: true } }],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'CUSTOMERS', columns: [{ name: 'EMAIL', type: 'VARCHAR(255)', nullable: false, primaryKey: false }] }),
      targetTable: tableSchema({ name: 'CUSTOMERS', columns: [{ name: 'EMAIL', type: 'VARCHAR(255)', nullable: false, primaryKey: false }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'sqlserver', { targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    expect(stmts).toContain('DROP INDEX IX_EMAIL ON demo_b.CUSTOMERS;');
    expect(stmts.some((s) => /DROP CONSTRAINT/i.test(s))).toBe(false);
  });

  it('emits RESTART WITH for a MODIFIED sequence start value (and Oracle omits it)', () => {
    const seqDiff = (start: string): TableDiff => ({
      tableName: 'ORDER_SEQ', objectType: 'SEQUENCE', status: 'MODIFIED',
      columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDER_SEQ', objectType: 'SEQUENCE', sequence: { start, increment: '1' } }),
      targetTable: tableSchema({ name: 'ORDER_SEQ', objectType: 'SEQUENCE', sequence: { start: '1', increment: '1' } }),
    });
    const ss = gen.generateMigrationPlan([seqDiff('1000')], 'sqlserver', { targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    expect(ss.some((s) => /ALTER SEQUENCE .*RESTART WITH 1000/.test(s))).toBe(true);
    // Oracle can't RESTART portably → no RESTART clause
    const ora = gen.generateMigrationPlan([seqDiff('1000')], 'oracle', { targetSchema: 'DEMO_B' }).flatMap((s) => s.statements);
    expect(ora.some((s) => /ALTER SEQUENCE/.test(s))).toBe(true);
    expect(ora.some((s) => /RESTART/i.test(s))).toBe(false);
  });

  it('renders a MODIFIED MariaDB sequence ALTER with single-token NOCYCLE/NOCACHE (MariaDB rejects "NO CYCLE"/"NO CACHE")', () => {
    const diff: TableDiff = {
      tableName: 'ORDER_SEQ', objectType: 'SEQUENCE', status: 'MODIFIED',
      columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDER_SEQ', objectType: 'SEQUENCE', sequence: { start: '1000', increment: '1', minValue: '1', maxValue: '9223372036854775806', cycle: false, cache: 0 } }),
      targetTable: tableSchema({ name: 'ORDER_SEQ', objectType: 'SEQUENCE', sequence: { start: '1', increment: '1', cycle: true, cache: 1000 } }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'mariadb', { sourceSchema: 'demo_a', targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    const alter = stmts.find((s) => /ALTER SEQUENCE/.test(s))!;
    expect(alter).toContain('NOCYCLE');
    expect(alter).toContain('NOCACHE');
    expect(alter).not.toMatch(/NO CYCLE|NO CACHE/);
  });

  it('SQL Server changes a column default by dropping the named DF constraint then re-adding', () => {
    const diff: TableDiff = {
      tableName: 'ORDER_ITEMS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'qty', status: 'MODIFIED',
        source: { type: 'int', nullable: false, defaultValue: '1' },
        target: { type: 'int', nullable: false, defaultValue: '0' } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'ORDER_ITEMS', columns: [{ name: 'qty', type: 'int', nullable: false, primaryKey: false, defaultValue: '1' }] }),
      targetTable: tableSchema({ name: 'ORDER_ITEMS', columns: [{ name: 'qty', type: 'int', nullable: false, primaryKey: false, defaultValue: '0' }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'sqlserver', { targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    expect(stmts.some((s) => /sys\.default_constraints/.test(s) && /DROP CONSTRAINT/.test(s))).toBe(true);
    expect(stmts.some((s) => /ADD DEFAULT 1 FOR qty/.test(s))).toBe(true);
    expect(stmts.some((s) => /^-- review:/.test(s))).toBe(false);
  });

  it('re-qualifies a backtick-quoted nextval() default to the target schema on SET DEFAULT', () => {
    const diff: TableDiff = {
      tableName: 'ORDERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'ID', status: 'MODIFIED',
        source: { type: 'bigint(20)', nullable: false, defaultValue: 'nextval(`demo_a`.`order_seq`)' },
        target: { type: 'bigint(20)', nullable: false, defaultValue: 'nextval(`demo_b`.`order_seq`)' } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'orders', columns: [{ name: 'id', type: 'bigint(20)', nullable: false, primaryKey: true, defaultValue: 'nextval(`demo_a`.`order_seq`)' }] }),
      targetTable: tableSchema({ name: 'orders', columns: [{ name: 'id', type: 'bigint(20)', nullable: false, primaryKey: true, defaultValue: 'nextval(`demo_b`.`order_seq`)' }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'mariadb', { sourceSchema: 'demo_a', targetSchema: 'demo_b' }).flatMap((s) => s.statements);
    // Must reference the TARGET schema, never the source one, in the emitted default.
    expect(stmts.some((s) => /SET DEFAULT nextval\(`demo_b`\.`order_seq`\)/.test(s))).toBe(true);
    expect(stmts.some((s) => s.includes('demo_a'))).toBe(false);
  });

  it('renders COLLATE on CREATE TABLE and ADD COLUMN when a column carries a collation', () => {
    const added: TableDiff = {
      tableName: 'CUSTOMERS', objectType: 'TABLE', status: 'ADDED',
      columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'customers', columns: [{ name: 'name', type: 'varchar(150)', nullable: false, primaryKey: false, collation: 'utf8mb4_unicode_ci' }] }),
    };
    const createSql = gen.generateMigrationPlan([added], 'mysql').flatMap((s) => s.statements).join('\n');
    expect(createSql).toMatch(/name varchar\(150\) COLLATE utf8mb4_unicode_ci NOT NULL/);

    const addCol: TableDiff = {
      tableName: 'CUSTOMERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'NICKNAME', status: 'ADDED', source: { type: 'varchar(50)', nullable: true, collation: 'utf8mb4_unicode_ci' } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'customers', columns: [{ name: 'nickname', type: 'varchar(50)', nullable: true, primaryKey: false, collation: 'utf8mb4_unicode_ci' }] }),
      targetTable: tableSchema({ name: 'customers', columns: [] }),
    };
    const addSql = gen.generateMigrationPlan([addCol], 'mysql').flatMap((s) => s.statements).join('\n');
    expect(addSql).toMatch(/ADD NICKNAME varchar\(50\) COLLATE utf8mb4_unicode_ci/);
  });

  it('emits a dialect-correct COLLATE clause when modifying a column collation, per dialect', () => {
    const diffFor = (type: string): TableDiff => ({
      tableName: 'CUSTOMERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'NAME', status: 'MODIFIED',
        source: { type, nullable: false, collation: 'target_collation' },
        target: { type, nullable: false, collation: 'source_collation' } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'customers', columns: [{ name: 'name', type, nullable: false, primaryKey: false, collation: 'target_collation' }] }),
      targetTable: tableSchema({ name: 'customers', columns: [{ name: 'name', type, nullable: false, primaryKey: false, collation: 'source_collation' }] }),
    });

    const mysqlSql = gen.generateMigrationPlan([diffFor('varchar(150)')], 'mysql').flatMap((s) => s.statements).join('\n');
    expect(mysqlSql).toMatch(/MODIFY COLUMN NAME varchar\(150\) COLLATE target_collation/);

    const pgSql = gen.generateMigrationPlan([diffFor('character varying(150)')], 'postgres').flatMap((s) => s.statements).join('\n');
    expect(pgSql).toMatch(/TYPE character varying\(150\) COLLATE "target_collation" USING/);

    const ssSql = gen.generateMigrationPlan([diffFor('nvarchar(150)')], 'sqlserver').flatMap((s) => s.statements).join('\n');
    expect(ssSql).toMatch(/ALTER COLUMN NAME nvarchar\(150\) COLLATE target_collation/);
  });

  it('strips collation across a cross-dialect migration (collation names are not portable)', () => {
    const diff: TableDiff = {
      tableName: 'CUSTOMERS', objectType: 'TABLE', status: 'MODIFIED',
      columnDiffs: [{ name: 'NAME', status: 'MODIFIED',
        source: { type: 'character varying(150)', nullable: false, collation: 'en_US.utf8' },
        target: { type: 'varchar(150)', nullable: false } }],
      indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: tableSchema({ name: 'customers', columns: [{ name: 'name', type: 'character varying(150)', nullable: false, primaryKey: false, collation: 'en_US.utf8' }] }),
      targetTable: tableSchema({ name: 'customers', columns: [{ name: 'name', type: 'varchar(150)', nullable: false, primaryKey: false }] }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'mysql', { sourceDialect: 'postgres', targetDialect: 'mysql' }).flatMap((s) => s.statements);
    expect(stmts.some((s) => s.includes('en_US.utf8') || s.includes('COLLATE'))).toBe(false);
  });
});

describe('SqlGeneratorModule materialized views (MQT)', () => {
  const mv = tableSchema({
    name: 'mv_test',
    objectType: 'MQT',
    definition: 'SELECT 1 AS id;',
    columns: [{ name: 'id', type: 'integer', nullable: true, primaryKey: false }],
  });

  it('renders a Postgres matview as CREATE MATERIALIZED VIEW, not a plain CREATE TABLE', () => {
    const diff: TableDiff = { tableName: 'MV_TEST', objectType: 'MQT', status: 'ADDED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [], sourceTable: mv };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts.some((s) => /CREATE MATERIALIZED VIEW mv_test AS/.test(s))).toBe(true);
    expect(stmts.some((s) => /^CREATE TABLE/.test(s))).toBe(false);
  });

  it('falls back to a plain CREATE TABLE for a dialect without matview support (DB2)', () => {
    const diff: TableDiff = { tableName: 'MV_TEST', objectType: 'MQT', status: 'ADDED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [], sourceTable: mv };
    const stmts = gen.generateMigrationPlan([diff], 'db2').flatMap((s) => s.statements);
    expect(stmts.some((s) => /^CREATE TABLE mv_test/.test(s))).toBe(true);
    expect(stmts.some((s) => /CREATE MATERIALIZED VIEW/.test(s))).toBe(false);
  });

  it('drops and recreates a Postgres matview when its query changes (no in-place ALTER)', () => {
    const diff: TableDiff = {
      tableName: 'MV_TEST', objectType: 'MQT', status: 'MODIFIED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [],
      sourceTable: mv,
      targetTable: tableSchema({ name: 'mv_test', objectType: 'MQT', definition: 'SELECT 1 AS id, 2 AS other;', columns: mv.columns }),
    };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts[0]).toBe('DROP MATERIALIZED VIEW IF EXISTS mv_test;');
    expect(stmts.some((s) => /CREATE MATERIALIZED VIEW mv_test AS/.test(s))).toBe(true);
  });

  it('drops a Postgres matview with DROP MATERIALIZED VIEW, not DROP TABLE', () => {
    const diff: TableDiff = { tableName: 'MV_TEST', objectType: 'MQT', status: 'REMOVED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [], targetTable: mv };
    const stmts = gen.generateMigrationPlan([diff], 'postgres').flatMap((s) => s.statements);
    expect(stmts).toEqual(['DROP MATERIALIZED VIEW IF EXISTS mv_test;']);
  });
});

describe('SqlGeneratorModule FK dependency order (Kahn)', () => {
  it('creates parent before child when child has FK to parent', () => {
    const parent = tableSchema({
      name: 'parent',
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
    });
    const child = tableSchema({
      name: 'child',
      columns: [{ name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false }],
      foreignKeys: [
        {
          name: 'fk_child',
          columns: ['parent_id'],
          referencedTable: 'parent',
          referencedColumns: ['id'],
        },
      ],
    });
    const diffs: TableDiff[] = [
      {
        tableName: 'CHILD',
        objectType: 'TABLE',
        status: 'ADDED',
        columnDiffs: [],
        indexDiffs: [],
        foreignKeyDiffs: [],
        sourceTable: child,
      },
      {
        tableName: 'PARENT',
        objectType: 'TABLE',
        status: 'ADDED',
        columnDiffs: [],
        indexDiffs: [],
        foreignKeyDiffs: [],
        sourceTable: parent,
      },
    ];
    const names = gen.generateMigrationPlan(diffs, 'postgres').map((s) => s.objectName);
    expect(names.indexOf('PARENT')).toBeLessThan(names.indexOf('CHILD'));
  });

  it('emits review comment when FK cycle remains', () => {
    const a = tableSchema({
      name: 'a',
      columns: [{ name: 'b_id', type: 'INTEGER', nullable: true, primaryKey: false }],
      foreignKeys: [
        { name: 'fk_a_b', columns: ['b_id'], referencedTable: 'b', referencedColumns: ['id'] },
      ],
    });
    const b = tableSchema({
      name: 'b',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'a_id', type: 'INTEGER', nullable: true, primaryKey: false },
      ],
      foreignKeys: [
        { name: 'fk_b_a', columns: ['a_id'], referencedTable: 'a', referencedColumns: ['b_id'] },
      ],
    });
    const diffs: TableDiff[] = [
      {
        tableName: 'A',
        objectType: 'TABLE',
        status: 'ADDED',
        columnDiffs: [],
        indexDiffs: [],
        foreignKeyDiffs: [],
        sourceTable: a,
      },
      {
        tableName: 'B',
        objectType: 'TABLE',
        status: 'ADDED',
        columnDiffs: [],
        indexDiffs: [],
        foreignKeyDiffs: [],
        sourceTable: b,
      },
    ];
    const stmts = gen.generateMigrationPlan(diffs, 'postgres').flatMap((s) => s.statements);
    expect(stmts.some((s) => s.includes('-- review: FK cycle'))).toBe(true);
  });
});

describe('SqlGeneratorModule foreign key hardening', () => {
  it('emits review comment instead of REFERENCES t () when referencedColumns empty', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'child',
        columns: [{ name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false }],
        foreignKeys: [
          {
            name: 'fk_child_parent',
            columns: ['parent_id'],
            referencedTable: 'parent',
            referencedColumns: [],
          },
        ],
      })
    );
    expect(ddl).toContain('-- review: skip FK fk_child_parent');
    expect(ddl).not.toContain('REFERENCES parent ()');
  });

  it('emits review comment when referencedColumns length mismatches columns', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'child',
        columns: [
          { name: 'a', type: 'INTEGER', nullable: true, primaryKey: false },
          { name: 'b', type: 'INTEGER', nullable: true, primaryKey: false },
        ],
        foreignKeys: [
          {
            name: 'fk_bad',
            columns: ['a', 'b'],
            referencedTable: 'parent',
            referencedColumns: ['id'],
          },
        ],
      })
    );
    expect(ddl).toContain('-- review: skip FK fk_bad');
    expect(ddl).not.toMatch(/REFERENCES parent \(/);
  });

  it('emits valid ADD FK when columns and referencedColumns align', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'child',
        columns: [{ name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false }],
        foreignKeys: [
          {
            name: 'fk_ok',
            columns: ['parent_id'],
            referencedTable: 'parent',
            referencedColumns: ['id'],
          },
        ],
      })
    );
    expect(ddl).toContain(
      'ALTER TABLE child ADD CONSTRAINT fk_ok FOREIGN KEY (parent_id) REFERENCES parent (id);'
    );
  });
});

describe('CREATE INDEX identifier', () => {
  it('uses the index its own name, not compare\'s uppercased match key', () => {
    // CLAUDE.md: "The compare key is not an identifier." The generator spread
    // the source IndexInfo then overwrote `name` with the key, so a revert
    // emitted IDX_CUSTOMERS_EMAIL for idx_customers_email — a different index
    // on any dialect that does not fold case, and a phantom rename next compare.
    const gen = new SqlGeneratorModule();
    const steps = gen.generateMigrationPlan(
      [
        {
          tableName: 'CUSTOMERS',
          objectType: 'TABLE',
          status: 'MODIFIED',
          columnDiffs: [],
          foreignKeyDiffs: [],
          indexDiffs: [
            {
              name: 'IDX_CUSTOMERS_EMAIL',
              status: 'ADDED',
              source: { name: 'idx_customers_email', columns: ['email'], unique: false },
            },
          ],
          sourceTable: {
            name: 'customers',
            objectType: 'TABLE',
            columns: [],
            indices: [],
            foreignKeys: [],
          },
          targetTable: {
            name: 'customers',
            objectType: 'TABLE',
            columns: [],
            indices: [],
            foreignKeys: [],
          },
        },
      ],
      'postgres'
    );
    const sql = steps.flatMap((s) => s.statements).join('\n');
    expect(sql).toMatch(/idx_customers_email/);
    expect(sql).not.toMatch(/IDX_CUSTOMERS_EMAIL/);
  });
});


describe('role membership speaks each engine’s own syntax', () => {
  // The generator emitted Db2's `GRANT ROLE x TO USER y` for every dialect.
  // Verified against PostgreSQL 16 and MySQL 8: that is a syntax error on both,
  // so every role-membership migration produced an unrunnable script outside
  // Db2. Each form below was then run against its own live server.
  const roleDiff = (member: string): TableDiff =>
    ({
      tableName: 'foxrole',
      objectType: 'ROLE',
      status: 'MODIFIED',
      columnDiffs: [
        { name: member, status: 'ADDED', source: { name: member, type: 'USER' } },
        { name: 'gone', status: 'REMOVED', target: { name: 'gone', type: 'USER' } },
      ],
      indexDiffs: [],
      foreignKeyDiffs: [],
      triggerDiffs: [],
    }) as unknown as TableDiff;

  const sqlFor = (dialect: string, member: string) =>
    new SqlGeneratorModule().generateMigrationSql(
      [roleDiff(member)],
      dialect,
      { sourceSchema: 's', sourceDialect: dialect, targetSchema: 's', nonDestructive: false } as never,
      []
    );

  it('uses the SQL standard where the engine takes it', () => {
    for (const d of ['postgres', 'mysql', 'mariadb', 'oracle']) {
      const sql = sqlFor(d, 'foxmember');
      expect(sql, d).toContain('GRANT foxrole TO foxmember;');
      expect(sql, d).toContain('REVOKE foxrole FROM gone;');
      // Db2's shape must not leak into the others.
      expect(sql, d).not.toContain('GRANT ROLE');
    }
  });

  it('uses ALTER ROLE on SQL Server, which has no GRANT form for membership', () => {
    const sql = sqlFor('sqlserver', 'foxmember');
    expect(sql).toContain('ALTER ROLE foxrole ADD MEMBER foxmember;');
    expect(sql).toContain('ALTER ROLE foxrole DROP MEMBER gone;');
    expect(sql).not.toMatch(/GRANT foxrole/);
  });

  it('keeps Db2’s own shape, which names the member kind', () => {
    const sql = sqlFor('db2', 'FOXMEMBER');
    expect(sql).toContain('GRANT ROLE foxrole TO USER FOXMEMBER;');
    expect(sql).toContain('REVOKE ROLE foxrole FROM USER gone;');
  });
});

describe('ClickHouse CREATE TABLE uses ENGINE / ORDER BY, not a PRIMARY KEY constraint', () => {
  const coupons = tableSchema({
    name: 'coupons',
    primaryKey: { name: 'PRIMARY_KEY', columns: ['id'] },
    columns: [
      { name: 'id', type: 'Int32', nullable: false, primaryKey: true },
      { name: 'code', type: 'String', nullable: false, primaryKey: false },
      { name: 'discount_pct', type: 'Decimal(5, 2)', nullable: false, primaryKey: false },
      { name: 'valid_until', type: 'Date', nullable: true, primaryKey: false },
    ],
  });

  it('maps a logical primary key to MergeTree ORDER BY', () => {
    const ddl = gen.generateObjectDdl(coupons, 'clickhouse');
    expect(ddl).toContain('CREATE TABLE coupons (');
    expect(ddl).toContain('id Int32');
    expect(ddl).toMatch(/\) ENGINE = MergeTree ORDER BY id;/);
    expect(ddl).not.toMatch(/PRIMARY KEY/);
    expect(ddl).not.toMatch(/CONSTRAINT PRIMARY_KEY/);
  });

  it('maps a composite primary key to ORDER BY (cols)', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        name: 'order_coupons',
        primaryKey: { name: 'PRIMARY_KEY', columns: ['order_id', 'coupon_id'] },
        columns: [
          { name: 'order_id', type: 'Int32', nullable: false, primaryKey: true },
          { name: 'coupon_id', type: 'Int32', nullable: false, primaryKey: true },
          { name: 'applied_at', type: 'DateTime', nullable: false, primaryKey: false },
        ],
      }),
      'clickhouse'
    );
    expect(ddl).toMatch(/\) ENGINE = MergeTree ORDER BY \(order_id, coupon_id\);/);
    expect(ddl).not.toMatch(/CONSTRAINT/);
    expect(ddl).not.toMatch(/PRIMARY KEY \(order_id, coupon_id\)/);
  });

  it('keeps a captured engine and sorting key', () => {
    const ddl = gen.generateObjectDdl(
      tableSchema({
        ...coupons,
        engine: 'ReplacingMergeTree',
        orderBy: ['id', 'code'],
      }),
      'clickhouse'
    );
    expect(ddl).toMatch(/\) ENGINE = ReplacingMergeTree PRIMARY KEY id ORDER BY \(id, code\);/);
  });

  it('does not change Postgres / DB2 CREATE TABLE shape', () => {
    const pg = gen.generateObjectDdl(coupons, 'postgres');
    expect(pg).toContain('CONSTRAINT PRIMARY_KEY PRIMARY KEY (id)');
    expect(pg).not.toMatch(/ENGINE/);
    const db2 = gen.generateObjectDdl(coupons, 'db2');
    expect(db2).toContain('CONSTRAINT PRIMARY_KEY PRIMARY KEY (id)');
    expect(db2).not.toMatch(/ENGINE/);
  });

  it('emits the same ENGINE / ORDER BY form from a migration plan', () => {
    const diff: TableDiff = {
      tableName: 'COUPONS',
      objectType: 'TABLE',
      status: 'ADDED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: coupons,
    };
    const sql = gen
      .generateMigrationPlan([diff], 'clickhouse', { targetSchema: 'demo_b' })
      .flatMap((s) => s.statements)
      .join('\n');
    expect(sql).toMatch(/CREATE TABLE demo_b\.coupons \(/);
    expect(sql).toMatch(/ENGINE = MergeTree ORDER BY id;/);
    expect(sql).not.toMatch(/PRIMARY KEY \(id\)/);
  });

  it('reviews an in-place key change instead of ALTER TABLE ADD PRIMARY KEY', () => {
    const diff: TableDiff = {
      tableName: 'COUPONS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        name: 'coupons',
        primaryKey: { name: 'PRIMARY_KEY', columns: ['id', 'code'] },
        columns: coupons.columns,
        engine: 'MergeTree',
        orderBy: ['id', 'code'],
      }),
      targetTable: tableSchema({
        name: 'coupons',
        primaryKey: { name: 'PRIMARY_KEY', columns: ['id'] },
        columns: coupons.columns,
        engine: 'MergeTree',
        orderBy: ['id'],
      }),
    };
    const sql = gen.generateMigrationPlan([diff], 'clickhouse').flatMap((s) => s.statements).join('\n');
    expect(sql).toMatch(/-- review:.*PRIMARY KEY is part of the ENGINE clause/i);
    expect(sql).not.toMatch(/ALTER TABLE .* ADD .*PRIMARY KEY/i);
  });

  it('reviews an ORDER BY change without emitting ALTER TABLE ADD PRIMARY KEY', () => {
    const diff: TableDiff = {
      tableName: 'COUPONS',
      objectType: 'TABLE',
      status: 'MODIFIED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      sourceTable: tableSchema({
        ...coupons,
        engine: 'MergeTree',
        orderBy: ['id', 'code'],
      }),
      targetTable: tableSchema({
        ...coupons,
        engine: 'MergeTree',
        orderBy: ['id'],
      }),
    };
    const sql = gen.generateMigrationPlan([diff], 'clickhouse').flatMap((s) => s.statements).join('\n');
    expect(sql).toMatch(/-- review:.*ENGINE \/ ORDER BY cannot be altered in place/i);
    expect(sql).not.toMatch(/ALTER TABLE .* ADD .*PRIMARY KEY/i);
  });

  it('drops a ClickHouse table with DROP TABLE IF EXISTS', () => {
    const diff: TableDiff = {
      tableName: 'LEGACY_AUDIT_LOG',
      objectType: 'TABLE',
      status: 'REMOVED',
      columnDiffs: [],
      indexDiffs: [],
      foreignKeyDiffs: [],
      targetTable: tableSchema({ name: 'legacy_audit_log', columns: coupons.columns }),
    };
    const sql = gen
      .generateMigrationPlan([diff], 'clickhouse', { targetSchema: 'demo_b' })
      .flatMap((s) => s.statements)
      .join('\n');
    expect(sql).toMatch(/DROP TABLE IF EXISTS demo_b\.legacy_audit_log;/);
  });
});
