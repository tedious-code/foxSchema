import type { SqlDialect, ColumnSpec } from '../../modules/dialect/sql-dialect.interface.js';
import type { IndexInfo } from '../../interfaces/schema.interface.js';
import { makeDialectTypeFns, plain, sized, decimalAs } from '../../modules/dialect/type-mapping.js';

const types = makeDialectTypeFns({
  label: 'SQLite',
  // SQLite uses type affinity, not strict types — map to the closest affinity keyword.
  parseMap: {
    boolean: 'boolean',
    bool: 'boolean',
    tinyint: 'smallint',
    smallint: 'smallint',
    int: 'integer',
    integer: 'integer',
    mediumint: 'integer',
    bigint: 'bigint',
    decimal: 'decimal',
    numeric: 'decimal',
    real: 'double',
    double: 'double',
    'double precision': 'double',
    float: 'double',
    char: 'char',
    varchar: 'varchar',
    'character varying': 'varchar',
    text: 'text',
    clob: 'text',
    blob: 'blob',
    date: 'date',
    datetime: 'timestamp',
    timestamp: 'timestamp',
  },
  renderMap: {
    boolean: plain('INTEGER'),
    smallint: plain('INTEGER'),
    integer: plain('INTEGER'),
    bigint: plain('INTEGER'),
    decimal: decimalAs('NUMERIC'),
    real: plain('REAL'),
    double: plain('REAL'),
    char: plain('TEXT'),
    varchar: sized('VARCHAR'),
    text: plain('TEXT'),
    binary: plain('BLOB'),
    varbinary: plain('BLOB'),
    blob: plain('BLOB'),
    // SQLite has no dedicated temporal/uuid/json/xml types — stored as TEXT
    date: plain('TEXT'),
    time: plain('TEXT'),
    timestamp: plain('TEXT'),
    timestamptz: plain('TEXT'),
    uuid: plain('TEXT'),
    json: plain('TEXT'),
    xml: plain('TEXT'),
  },
});

export const sqliteSqlDialect: SqlDialect = {
  identityClause(_c: ColumnSpec): string {
    // INTEGER PRIMARY KEY is implicitly autoincrement in SQLite — no extra keyword
    return '';
  },

  addColumnStatement(tableName: string, colDef: string): string {
    return `ALTER TABLE ${tableName} ADD COLUMN ${colDef};`;
  },

  modifyColumnStatements(tableName: string, colName: string, col: ColumnSpec): string[] {
    // SQLite has no ALTER COLUMN for type/nullability changes — table must be recreated.
    const nullNote = col.nullable ? 'nullable' : 'NOT NULL';
    return [
      `-- review: SQLite cannot change a column type or nullability in-place.`,
      `-- Recreate ${tableName} to apply: ${colName} ${col.type} ${nullNote}`,
    ];
  },

  dropColumnStatement(tableName: string, colName: string): string {
    return `ALTER TABLE ${tableName} DROP COLUMN ${colName};`;
  },

  setDefaultStatements(tableName: string, colName: string, _defaultValue: string | undefined): string[] {
    // SQLite can't ALTER a column default in place; the table must be rebuilt.
    return [`-- review: ${colName}: SQLite cannot change a column default in place — recreate ${tableName} to apply it`];
  },

  dropPrimaryKeyStatements(tableName: string, _pkName: string | undefined): string[] {
    // SQLite has no ALTER TABLE DROP PRIMARY KEY; must recreate the table
    return [`-- SQLite: recreate ${tableName} to change primary key`];
  },

  dropForeignKeyStatement(tableName: string, fkName: string): string {
    // SQLite cannot drop a constraint in place — the table must be recreated.
    // Emit a review note rather than invalid SQL.
    return `-- review: SQLite cannot DROP a foreign key (${fkName}) in place — recreate ${tableName} to remove it`;
  },

  dropIndexStatement(indexName: string, _qualifiedTable: string): string {
    return `DROP INDEX IF EXISTS ${indexName};`;
  },

  /**
   * SQLite takes the schema on the *index* name, never on the table:
   * `CREATE INDEX main.idx ON customers(email)` is valid, while
   * `CREATE INDEX idx ON main.customers(email)` is `near ".": syntax error`.
   * Every other dialect qualifies the table, so the shared generator does too —
   * this hook moves the qualifier across.
   */
  createIndexStatement(index: IndexInfo, qualifiedTable: string): string {
    const dot = qualifiedTable.lastIndexOf('.');
    const schema = dot < 0 ? '' : qualifiedTable.slice(0, dot);
    const table = dot < 0 ? qualifiedTable : qualifiedTable.slice(dot + 1);
    const name = schema ? `${schema}.${index.name}` : index.name;
    const unique = index.unique ? ' UNIQUE' : '';
    const where = index.filter?.trim() ? ` WHERE ${index.filter.trim()}` : '';
    return `CREATE${unique} INDEX IF NOT EXISTS ${name} ON ${table} (${index.columns.join(', ')})${where};`;
  },

  dropTriggerStatement(triggerName: string, _qualifiedTable: string): string {
    return `DROP TRIGGER IF EXISTS ${triggerName};`;
  },

  /**
   * SQLite has no `CREATE OR REPLACE VIEW` — the generator's default emitted
   * `near "OR": syntax error`. `IF NOT EXISTS` keeps a re-run of the script
   * harmless, matching how this dialect emits indexes.
   */
  createViewStatement(name: string, body: string): string {
    return `CREATE VIEW IF NOT EXISTS ${name} AS\n${body}`;
  },

  /**
   * SQLite has no `ALTER VIEW` either, so a changed view is dropped and
   * recreated. Views hold no data, so this loses nothing.
   */
  alterViewStatement(name: string, body: string): string {
    return `DROP VIEW IF EXISTS ${name};\nCREATE VIEW ${name} AS\n${body}`;
  },

  ...types,
};
