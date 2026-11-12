import type { SqlDialect, ColumnSpec } from '../../modules/dialect/sql-dialect.interface.js';
import type { TableSchema } from '../../interfaces/index.js';
import {
  makeDialectTypeFns,
  plain,
  sized,
  decimalAs,
  temporalAs,
  withDefaultTemporalFsp,
} from '../../modules/dialect/type-mapping.js';

/** A name in double quotes, embedded quotes doubled. */
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

const types = makeDialectTypeFns({
  label: 'PostgreSQL',
  parseMap: {
    boolean: 'boolean',
    bool: 'boolean',
    smallint: 'smallint',
    int2: 'smallint',
    integer: 'integer',
    int: 'integer',
    int4: 'integer',
    bigint: 'bigint',
    int8: 'bigint',
    numeric: 'decimal',
    decimal: 'decimal',
    real: 'real',
    float4: 'real',
    'double precision': 'double',
    float8: 'double',
    character: 'char',
    char: 'char',
    bpchar: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
    bytea: 'blob',
    date: 'date',
    time: 'time',
    'time without time zone': 'time',
    'time with time zone': 'time',
    timestamp: 'timestamp',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    timestamptz: 'timestamptz',
    uuid: 'uuid',
    json: 'json',
    jsonb: 'json',
    xml: 'xml',
  },
  renderMap: {
    boolean: plain('boolean'),
    smallint: plain('smallint'),
    integer: plain('integer'),
    bigint: plain('bigint'),
    decimal: decimalAs('numeric'),
    real: plain('real'),
    double: plain('double precision'),
    char: sized('char'),
    varchar: sized('varchar'),
    text: plain('text'),
    binary: plain('bytea'),
    varbinary: plain('bytea'),
    blob: plain('bytea'),
    date: plain('date'),
    time: temporalAs('time'),
    timestamp: temporalAs('timestamp'),
    timestamptz: temporalAs('timestamptz'),
    uuid: plain('uuid'),
    json: plain('jsonb'),
    xml: plain('xml'),
  },
});

function viewDepTag(qualifiedTable: string): string {
  return qualifiedTable.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

/**
 * Postgres `format_type` omits `(6)` when typmod is the default (-1). Bare
 * `timestamp` / `timestamptz` / `time` still store 6 fractional digits.
 */
function parsePostgresType(raw: string) {
  return withDefaultTemporalFsp(types.parseType(raw), 6);
}

export const postgresSqlDialect: SqlDialect = {
  identityClause(c: ColumnSpec): string {
    return c.identity ? ` GENERATED ${c.identityGeneration ?? 'ALWAYS'} AS IDENTITY` : '';
  },

  addColumnStatement(tableName: string, colDef: string): string {
    return `ALTER TABLE ${tableName} ADD COLUMN ${colDef};`;
  },

  createMaterializedViewStatement(name: string, body: string): string {
    // body already ends with ';' (see ensureSemicolon at the call site).
    return `CREATE MATERIALIZED VIEW ${name} AS\n${body}`;
  },

  dropMaterializedViewStatement(name: string): string {
    return `DROP MATERIALIZED VIEW IF EXISTS ${name};`;
  },

  // Postgres's "default" pseudo-collation is a reserved word, and real collation
  // names often contain dots (en_US.utf8) — always double-quote, unlike the other
  // dialects' unquoted default.
  columnCollateClause(collation: string): string {
    return ` COLLATE "${collation}"`;
  },

  modifyColumnStatements(tableName: string, colName: string, col: ColumnSpec): string[] {
    // Postgres refuses ALTER COLUMN TYPE while the column has a DEFAULT it can't
    // auto-cast to the new type ("default for column ... cannot be cast
    // automatically", e.g. varchar 'pending' → enum). Drop the default first,
    // then re-apply the source default after the type change. If the source has
    // no default, the drop still converges (target default shouldn't survive a
    // type change it can't cast into anyway).
    const stmts = [`ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP DEFAULT;`];
    // USING provides an explicit cast so Postgres doesn't rely on implicit coercion,
    // which may not exist for all type pairs (e.g. text → integer requires it).
    // COLLATE goes between the new type and USING.
    const collateClause = col.collation ? this.columnCollateClause!(col.collation) : '';
    stmts.push(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE ${col.type}${collateClause} USING ${colName}::${col.type};`);
    if (col.nullable) {
      stmts.push(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP NOT NULL;`);
    } else {
      stmts.push(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`);
    }
    if (col.defaultValue) {
      // Re-apply the desired default — needed even when source and target
      // defaults compare equal (the generator's default-diff branch only fires
      // on a difference, and we just dropped it above).
      stmts.push(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET DEFAULT ${col.defaultValue};`);
    }
    return stmts;
  },

  dropColumnStatement(tableName: string, colName: string): string {
    return `ALTER TABLE ${tableName} DROP COLUMN ${colName};`;
  },

  setDefaultStatements(tableName: string, colName: string, defaultValue: string | undefined): string[] {
    return defaultValue
      ? [`ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET DEFAULT ${defaultValue};`]
      : [`ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP DEFAULT;`];
  },

  dropPrimaryKeyStatements(tableName: string, pkName: string | undefined): string[] {
    const constraint = pkName ?? `${tableName.replace(/^.*\./, '')}_pkey`;
    return [`ALTER TABLE ${tableName} DROP CONSTRAINT ${constraint};`];
  },

  serialSequenceFromDefault(defaultValue: string): string | null {
    if (!defaultValue) return null;
    const m = defaultValue.match(/nextval\(\s*'([^']+)'(?:::regclass)?\s*\)/i);
    if (!m) return null;
    // Strip any leading schema qualifier from the sequence name
    return m[1].replace(/"/g, '').replace(/^[^.]+\./, '');
  },

  dropDependentViewsBlock(qualifiedTable: string): string {
    const tbl = qualifiedTable.replace(/'/g, "''");
    const tmp = `_fs_vdep_${viewDepTag(qualifiedTable)}`;
    return [
      `DO $fs_pre$ DECLARE r RECORD; BEGIN`,
      `  CREATE TEMP TABLE ${tmp} ON COMMIT DROP AS`,
      `  WITH RECURSIVE deps(viewoid, depth) AS (`,
      `    SELECT rw.ev_class, 1 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid`,
      `    WHERE d.refobjid = '${tbl}'::regclass AND d.deptype = 'n' AND rw.ev_class <> d.refobjid`,
      `    UNION`,
      `    SELECT rw.ev_class, deps.depth + 1 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid`,
      `    JOIN deps ON deps.viewoid = d.refobjid WHERE d.deptype = 'n' AND rw.ev_class <> d.refobjid`,
      `  )`,
      `  SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS vname,`,
      `         pg_get_viewdef(c.oid, true) AS vdef, max(deps.depth) AS depth`,
      `  FROM deps JOIN pg_class c ON c.oid = deps.viewoid JOIN pg_namespace n ON n.oid = c.relnamespace`,
      `  WHERE c.relkind = 'v' GROUP BY c.oid, n.nspname, c.relname;`,
      `  FOR r IN SELECT vname FROM ${tmp} ORDER BY depth DESC LOOP`,
      `    EXECUTE 'DROP VIEW IF EXISTS '||r.vname||' CASCADE';`,
      `  END LOOP;`,
      `END $fs_pre$;`,
    ].join('\n');
  },

  recreateDependentViewsBlock(qualifiedTable: string): string {
    const tmp = `_fs_vdep_${viewDepTag(qualifiedTable)}`;
    return [
      `DO $fs_post$ DECLARE r RECORD; BEGIN`,
      `  FOR r IN SELECT vname, vdef FROM ${tmp} ORDER BY depth ASC LOOP`,
      `    BEGIN`,
      `      EXECUTE 'CREATE VIEW '||r.vname||' AS '||r.vdef;`,
      `    EXCEPTION WHEN OTHERS THEN`,
      `      RAISE EXCEPTION 'Fox: cannot restore dependent view % after the table changes (%). It references a column that was dropped or incompatibly retyped. Include this view in the migration so it gets the new definition, or drop/update it manually, then retry.', r.vname, SQLERRM;`,
      `    END;`,
      `  END LOOP;`,
      `  DROP TABLE ${tmp};`,
      `END $fs_post$;`,
    ].join('\n');
  },

  dropIndexStatement(indexName: string, qualifiedTable: string): string {
    const dot = qualifiedTable.indexOf('.');
    const prefix = dot >= 0 ? qualifiedTable.slice(0, dot + 1) : '';
    return `DROP INDEX IF EXISTS ${prefix}${indexName};`;
  },

  dropTriggerStatement(triggerName: string, qualifiedTable: string): string {
    return `DROP TRIGGER IF EXISTS ${triggerName} ON ${qualifiedTable};`;
  },

  // Postgres supports function/procedure overloading — a signature disambiguates
  // which overload to drop, and is sometimes required when multiple exist.
  dropRoutineSignature: true,

  // Postgres is the only dialect where ALTER SEQUENCE can change the data type.
  alterSequenceAsType: true,

  createTypeStatement(schema: TableSchema): string | null {
    const u = schema.userType ?? {};
    // ENUM — stored by the Postgres provider with metaType='E' and attribute names as labels.
    if (u.metaType === 'E' && u.attributes && u.attributes.length > 0) {
      const vals = u.attributes.map((a) => `'${a.name.replace(/'/g, "''")}'`).join(', ');
      return `CREATE TYPE ${schema.name} AS ENUM (${vals});`;
    }
    // Composite object type — Postgres uses plain "AS (col type, ...)" without MODE DB2SQL.
    if (u.metaType === 'O' && u.attributes && u.attributes.length > 0) {
      const cols = u.attributes.map((a) => `  ${a.name} ${a.type}`).join(',\n');
      return `CREATE TYPE ${schema.name} AS (\n${cols}\n);`;
    }
    // Domain — CREATE DOMAIN with its own rules; PostgreSQL refuses CREATE TYPE … AS basetype.
    if (u.metaType === 'D' && u.sourceType) {
      const d = u.domain ?? {};
      const rules = [
        ...(d.default != null ? [`DEFAULT ${d.default}`] : []),
        ...(d.notNull ? ['NOT NULL'] : []),
        ...(d.checks ?? []).map((c) => `CONSTRAINT ${quoteIdent(c.name)} ${c.expression}`),
      ];
      return `CREATE DOMAIN ${schema.name} AS ${u.sourceType}${rules.map((r) => `\n  ${r}`).join('')};`;
    }
    return null; // fall through to generic renderer
  },

  dropTypeStatement(name: string, type: TableSchema | undefined, ifExists: boolean): string {
    const kind = type?.userType?.metaType === 'D' && type.userType.sourceType ? 'DOMAIN' : 'TYPE';
    return `DROP ${kind}${ifExists ? ' IF EXISTS' : ''} ${name};`;
  },

  ...types,
  parseType: parsePostgresType,
};
