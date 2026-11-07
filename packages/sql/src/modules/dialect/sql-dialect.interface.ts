import type { TableSchema, IndexInfo } from '../../interfaces/index.js';

/** Minimal column info available in both full schema and diff contexts. */
export interface ColumnSpec {
  type: string;
  nullable: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  identity?: boolean;
  identityGeneration?: string;
  collation?: string;
}

/**
 * Dialect-neutral type categories. Every provider parses its native types into
 * one of these and renders them back into its own syntax, so a type can travel
 * from one dialect to another (DB2 VARCHAR(255) → Postgres varchar(255)).
 */
export type CanonicalBase =
  | 'boolean'
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'real'
  | 'double'
  | 'char'
  | 'varchar'
  | 'text'
  | 'binary'
  | 'varbinary'
  | 'blob'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'uuid'
  | 'json'
  | 'xml'
  | 'unknown';

/** A native column type normalized into the canonical model. */
export interface CanonicalType {
  base: CanonicalBase;
  length?: number; // char / varchar / binary / temporal fractional-seconds precision
  precision?: number; // decimal
  scale?: number; // decimal
  /** Original native type string — used as fallback and in review comments. */
  raw: string;
}

/** Result of rendering a canonical type into a dialect's native syntax. */
export interface RenderedType {
  sql: string;
  /** Set when the mapping was inexact (e.g. no direct target equivalent). */
  warning?: string;
}

export interface SqlDialect {
  /** Clause appended after the column type for auto-increment/identity columns. Empty string = no clause. */
  identityClause(c: ColumnSpec): string;

  /** Full ALTER TABLE ... ADD [COLUMN] statement. */
  addColumnStatement(tableName: string, colDef: string): string;

  /**
   * Full ALTER TABLE ... MODIFY / ALTER COLUMN statement(s). Returns one or more statements.
   * `currentNullable` is the column's existing nullability in the target (when known),
   * so a dialect can skip re-stating NULL/NOT NULL when it hasn't changed — Oracle
   * rejects `MODIFY col ... NOT NULL` on a column that is already NOT NULL (ORA-01442).
   */
  modifyColumnStatements(tableName: string, colName: string, col: ColumnSpec, currentNullable?: boolean): string[];

  /** Full ALTER TABLE ... DROP [COLUMN] statement. */
  dropColumnStatement(tableName: string, colName: string): string;

  /**
   * Statement(s) to change a column's DEFAULT. `defaultValue` undefined/empty
   * means drop the default. Dialects that can't express this in place return a
   * `-- review:` comment instead of invalid SQL.
   */
  setDefaultStatements(tableName: string, colName: string, defaultValue: string | undefined): string[];

  /** Statement(s) to drop an existing primary key before adding a new one. */
  dropPrimaryKeyStatements(tableName: string, pkName: string | undefined): string[];

  /**
   * Add a primary key. Default: `ALTER TABLE t ADD [CONSTRAINT name] PRIMARY KEY (cols)`.
   * Override when that form is invalid (ClickHouse: `-- review:` recreate).
   */
  addPrimaryKeyStatements?(tableName: string, quotedColumns: string[], pkName: string | undefined): string[];

  /**
   * Emit `PRIMARY KEY (cols)` inside CREATE TABLE. Default true.
   * ClickHouse only allows CHECK/ASSUME there.
   */
  inlinePrimaryKeyConstraint?: boolean;

  /**
   * Clauses after the CREATE TABLE column list. ClickHouse: ` ENGINE = MergeTree ORDER BY …`.
   *
   * Both arrays arrive ready to emit, and an implementation must use them
   * rather than reading names off `table`: identifiers there are raw catalog
   * values, and a column is named whatever somebody created, so emitting one
   * unquoted lets it carry DDL out of the clause.
   *
   * `quotedOrderBy` is identifier-quoted, except when
   * `table.orderByFromCatalog` says the entries are the engine's own rendering
   * of the sorting key — those are already valid SQL and may be expressions
   * such as `cityHash64(id)`, so they pass through verbatim.
   * `quotedPrimaryKey` is always identifier-quoted: a primary key is a column
   * list, never an expression.
   */
  createTableSuffix?(table: TableSchema, quotedOrderBy: string[], quotedPrimaryKey: string[]): string;

  /**
   * ENGINE / ORDER BY changed. Omit when the dialect has no table engine.
   * ClickHouse cannot ALTER those in place — returns `-- review:` to recreate.
   */
  engineChangeStatements?(
    tableName: string,
    source: TableSchema,
    target: TableSchema
  ): string[];

  /** Parse a native type string (e.g. "VARCHAR(255)") into the canonical model. */
  parseType(raw: string): CanonicalType;

  /** Render a canonical type into this dialect's native syntax. */
  renderType(t: CanonicalType): RenderedType;

  /**
   * Extract a backing sequence name from a column default expression
   * (e.g. `nextval('schema.seq'::regclass)` → `seq`). Return null if this
   * dialect doesn't need pre-created backing sequences for serial columns.
   * When non-null, the generator creates the sequence before the table/column.
   */
  serialSequenceFromDefault?(defaultValue: string): string | null;

  /**
   * Return a SQL block that saves and drops all views transitively dependent on
   * `qualifiedTable` so that column ALTER/DROP can proceed without "column used
   * by a view" errors. Called before column changes; pair with
   * `recreateDependentViewsBlock` using the same `qualifiedTable`.
   * Return null if the dialect doesn't need this guard.
   */
  dropDependentViewsBlock?(qualifiedTable: string): string | null;

  /**
   * Return a SQL block that recreates the views saved by `dropDependentViewsBlock`.
   * Must be called with the same `qualifiedTable`. Return null if not applicable.
   */
  recreateDependentViewsBlock?(qualifiedTable: string): string | null;

  /**
   * If defined, the dialect encodes nullability inside the type string rather than
   * via NULL / NOT NULL keywords (e.g. ClickHouse Nullable(T)). Called instead of
   * appending NULL/NOT NULL; returns the full column type string.
   */
  nullableTypeWrapper?(typeSql: string, nullable: boolean): string;

  /**
   * Wrap an identifier that cannot be written bare — a name holding a space,
   * punctuation, or a non-ASCII letter, as read from the live catalog.
   *
   * Omit for ANSI double quotes, which is right for every dialect here except
   * MySQL's default mode (backticks) and SQL Server (brackets). The generator
   * calls this **only** when the name actually needs it, so ordinary names are
   * emitted bare exactly as before.
   */
  quoteIdentifier?(name: string): string;

  /**
   * Statements to run after a table's columns change, before its indexes,
   * keys and triggers are rebuilt.
   *
   * DB2 puts a table into *reorg-pending* after DROP COLUMN and after some type
   * changes: `SELECT` still works, but every write fails with SQL0668N reason
   * code 7 until `REORG TABLE` runs. A migration that skips it reports success
   * and hands back a table nobody can write to — and because reads still work,
   * it can be a while before anyone notices.
   *
   * Omit unless the engine needs it. Runs inside the migration's transaction
   * alongside the ALTERs.
   */
  /**
   * Statements that clean up after this dialect's own `addColumnStatement`.
   *
   * DB2 cannot add a NOT NULL column to a populated table without a default
   * (SQL0193N), so the dialect appends `WITH DEFAULT` to make the ALTER
   * succeed. That leaves the column carrying a default (`''`, `0`) the source
   * column never had — so the very next comparison reports the column as
   * changed, proposes the same migration again, and never converges. Dropping
   * the implicit default afterwards makes the result actually match the source.
   *
   * Omit unless `addColumnStatement` adds something the source did not ask for.
   */
  afterAddColumnStatements?(qualifiedTable: string, colName: string, col: ColumnSpec): string[];

  /**
   * How this engine adds or removes a member of a role.
   *
   * The fallback is the SQL standard — `GRANT role TO member;` — which is what
   * PostgreSQL, MySQL, MariaDB, Oracle and the wire-compatible variants take.
   * The generator previously emitted Db2's `GRANT ROLE role TO USER member;`
   * for every engine, which is a syntax error everywhere else; verified against
   * PostgreSQL 16 and MySQL 8.
   *
   * Override where the shape differs: Db2 names the object kind, and SQL Server
   * has no GRANT form for membership at all (`ALTER ROLE … ADD MEMBER`).
   *
   * `memberType` is the member's own kind (USER, GROUP, ROLE) as the catalog
   * reported it — only Db2 puts it in the statement.
   */
  roleMemberStatement?(
    role: string,
    member: string,
    memberType: string,
    action: 'grant' | 'revoke'
  ): string;

  postColumnChangeStatements?(
    qualifiedTable: string,
    changed: { dropped: boolean; retyped: boolean }
  ): string[];

  /**
   * Full ` COLLATE ...` clause (with leading space) for a column's collation, used in
   * CREATE TABLE / ADD COLUMN. Default: ` COLLATE <name>`, unquoted — correct for
   * MySQL/MariaDB/SQL Server/Oracle collation names. Postgres overrides this: its
   * "default" pseudo-collation is a reserved word and collation names may contain
   * dots (e.g. en_US.utf8), so it always double-quotes.
   */
  columnCollateClause?(collation: string): string;

  /**
   * DROP INDEX statement for the dialect. MySQL needs `DROP INDEX name ON table;`
   * rather than the generic `DROP INDEX schema.name;`. `index` (when supplied) carries
   * the metadata being dropped so a dialect can special-case a constraint-backing index
   * (SQL Server: `ALTER TABLE t DROP CONSTRAINT name`).
   */
  dropIndexStatement?(indexName: string, qualifiedTable: string, index?: IndexInfo): string;

  /**
   * CREATE INDEX statement for the dialect. The generic renderer emits
   * `CREATE [UNIQUE] INDEX name ON table (cols)`. A dialect overrides this to render a
   * constraint-backing index as its constraint form (SQL Server: `ALTER TABLE t ADD
   * CONSTRAINT name UNIQUE (cols)`). `index.name` is already bare (unqualified).
   */
  createIndexStatement?(index: IndexInfo, qualifiedTable: string): string;

  /**
   * DROP TRIGGER statement for the dialect. MySQL needs `DROP TRIGGER IF EXISTS name;`.
   */
  dropTriggerStatement?(triggerName: string, qualifiedTable: string): string;

  /**
   * Wrap a trigger body in a full CREATE TRIGGER statement for the dialect.
   * Return null to fall back to emitting `trigger.definition` verbatim (for dialects
   * where the stored definition is already the complete CREATE TRIGGER statement).
   */
  createTriggerStatement?(
    trigger: { name: string; timing?: string; event?: string; definition?: string },
    qualifiedTable: string
  ): string | null;

  /**
   * ALTER TABLE statement to drop a foreign key constraint.
   * Defaults to `ALTER TABLE t DROP CONSTRAINT IF EXISTS name;` (Postgres/SQLite/DB2).
   * MySQL overrides this with `ALTER TABLE t DROP FOREIGN KEY name;` because MySQL
   * uses a separate FK namespace and doesn't support DROP CONSTRAINT IF EXISTS.
   */
  dropForeignKeyStatement?(tableName: string, fkName: string): string;

  /**
   * Statement(s) to execute immediately before `DROP TABLE tableName`.
   * Use to drop inbound FK constraints that would otherwise block the drop
   * (SQL Server does not support DROP TABLE CASCADE).
   * Return an empty array (or omit) if no pre-drop cleanup is needed.
   */
  preDropTableStatements?(tableName: string): string[];

  /**
   * Full CREATE VIEW statement for an added view.
   * Default: `CREATE OR REPLACE VIEW name AS body` (Postgres / MySQL / MariaDB style).
   * SQL Server overrides with `CREATE VIEW name AS body`.
   */
  createViewStatement?(name: string, body: string): string;

  /**
   * Full statement to replace an existing view's definition.
   * Default: `CREATE OR REPLACE VIEW name AS body`.
   * SQL Server overrides with `ALTER VIEW name AS body`.
   */
  alterViewStatement?(name: string, body: string): string;

  /**
   * Full CREATE MATERIALIZED VIEW statement for an MQT-type object whose backing
   * query was captured (currently: Postgres matviews — DB2 MQTs aren't queryable
   * this way). Return undefined/omit to fall back to rendering it as a plain
   * CREATE TABLE (structure-only, no defining query) — DB2's current behavior.
   */
  createMaterializedViewStatement?(name: string, body: string): string;

  /**
   * DROP statement for an MQT-type object. Default: `DROP TABLE IF EXISTS name;`
   * (DB2 MQTs are dropped like any table). Postgres overrides with
   * `DROP MATERIALIZED VIEW IF EXISTS name;` — Postgres rejects DROP TABLE on one.
   */
  dropMaterializedViewStatement?(name: string): string;

  /**
   * Wrap the standard `CREATE SEQUENCE IF NOT EXISTS name ...` into a dialect-safe form.
   * Called with the qualified name and the full `CREATE SEQUENCE name ...;` string.
   * SQL Server has no `IF NOT EXISTS` for sequences — it uses an OBJECT_ID guard instead.
   * Default: returns `CREATE SEQUENCE IF NOT EXISTS name ...;`.
   */
  wrapCreateSequence?(qualifiedName: string, createSql: string): string;

  /**
   * Oracle spells the negative sequence options as single keywords —
   * `NOCYCLE`, `NOCACHE`. The spaced `NO CYCLE` / `NO CACHE` that Postgres and
   * DB2 accept is **ORA-03049** there, which kills the CREATE SEQUENCE and then
   * everything that depends on it: the table whose default calls the sequence,
   * and the views over that table.
   */
  unspacedSequenceNoKeywords?: boolean;

  /**
   * Wrap the standard `ALTER SEQUENCE name ...;` into a dialect-safe form.
   * Called with the qualified name and the full `ALTER SEQUENCE name ...;` string.
   * MariaDB needs the CYCLE/CACHE negatives collapsed to the single tokens
   * `NOCYCLE`/`NOCACHE` (the generic renderer emits `NO CYCLE`/`NO CACHE`, which
   * MariaDB rejects with a syntax error) — the same normalization wrapCreateSequence
   * applies on the CREATE path. Default: returns the statement unchanged.
   */
  wrapAlterSequence?(qualifiedName: string, alterSql: string): string;

  // ── Version-aware DROP hooks ────────────────────────────────────────────────
  // Each hook receives the server version string detected at connect time.
  // When the version is undefined the hook should fall back to the modern syntax.
  // Default (no hook): generator emits `DROP <OBJECT> IF EXISTS name;`.
  // Oracle pre-23c and old DB2 cannot use IF EXISTS — they override with a
  // PL/SQL / SQL-PL anonymous block that swallows the "does not exist" error.

  /** Version-safe DROP TABLE statement. */
  dropTableStatement?(name: string, version?: string): string;
  /** Version-safe DROP VIEW statement. */
  dropViewStatement?(name: string, version?: string): string;
  /** Version-safe DROP SEQUENCE statement. */
  dropSequenceStatement?(name: string, version?: string): string;
  /** Version-safe DROP FUNCTION statement (no parameter signature — use for dialects where name alone identifies the routine). */
  dropFunctionStatement?(name: string, version?: string): string;
  /** Version-safe DROP PROCEDURE statement. */
  dropProcedureStatement?(name: string, version?: string): string;

  /**
   * Whether the generator's generic DROP FUNCTION/PROCEDURE fallback should
   * append a parenthesized parameter-type signature — `DROP FUNCTION name(int, text);`
   * — to disambiguate overloads. Postgres and Redshift support function
   * overloading and accept (sometimes require) this form. MySQL/MariaDB and
   * SQL Server do NOT support overloading and reject ANY parenthesized
   * signature after the routine name, even an empty `()` — so this must
   * default to false/omitted (the safe form: bare `DROP FUNCTION name;`).
   */
  dropRoutineSignature?: boolean;

  /**
   * Whether ALTER SEQUENCE may include an `AS <datatype>` clause to change the
   * sequence's data type. Postgres supports it; SQL Server rejects it outright
   * ("Argument 'AS' cannot be used in an ALTER SEQUENCE statement") and
   * Oracle/DB2/MariaDB have no such clause. Default: omit the clause.
   */
  alterSequenceAsType?: boolean;

  /**
   * Full CREATE TYPE statement for a user-defined type (ENUM, composite, domain).
   * Return null to fall back to the generic DB2-style renderer.
   * Implement in dialects that have their own type syntax (e.g. Postgres ENUM).
   */
  createTypeStatement?(schema: TableSchema): string | null;

  /**
   * The `ALTER SEQUENCE` clause that re-aligns the sequence's next value, returned with
   * a leading space (e.g. ` RESTART WITH 1000`). Defaults to ` RESTART WITH <start>`.
   * Oracle overrides this (different syntax / not supported pre-18c) to return '' so no
   * invalid clause is emitted.
   */
  alterSequenceRestart?(start: string): string;
}
