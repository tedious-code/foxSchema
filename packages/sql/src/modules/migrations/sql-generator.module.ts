import { type TableDiff, type ColumnDiff } from '../../interfaces/index.js';
import { type TableSchema, type DbObjectType } from '../../interfaces/index.js';
import type { IndexInfo } from '../../interfaces/index.js';
import type { SqlDialect, ColumnSpec } from '../dialect/sql-dialect.interface.js';
import { resolveDialect, tryResolveDialect } from '../dialect/registry.js';
import { dialectSupportsFk, type FkFeatureSupport } from '../dialect/fk-support.js';
import { compareKey } from '../schema-diff/compare-key.js';
import { escapeRegExp } from '../../cores/escape-regexp.js';

/** One key per (type, name) pair; NUL cannot occur in either part. */
const selectionKey = (d: Pick<TableDiff, 'objectType' | 'tableName'>): string =>
  `${d.objectType}\u0000${d.tableName}`;

export interface MigrationStep {
  /**
   * Always a single line: the script heads each step with
   * `-- <action> <type>: <objectName>`, and a line break in a name would end
   * that comment and leave the rest of the name executable. See
   * `flattenIdentifier`.
   */
  objectName: string;
  objectType: DbObjectType;
  action: 'DROP' | 'CREATE' | 'ALTER';
  /** Individual executable statements, in order. Trailing semicolons are display-only. */
  statements: string[];
  /** When set, the executor skips all statements and emits SKIPPED status with this reason. */
  skipped?: string;
}

export interface SchemaMapping {
  /** Schema the objects were read from (e.g. MY). */
  sourceSchema?: string;
  /** Schema the migration deploys into (e.g. HUY). */
  targetSchema?: string;
  /** Dialect the source objects were read from. Enables cross-dialect type translation. */
  sourceDialect?: string;
  /** Dialect the migration deploys into. Defaults to the dialect passed to generate*(). */
  targetDialect?: string;
  /**
   * Non-destructive (additive) mode: emit ADD/MODIFY but never DROP. Objects,
   * columns and indexes that exist only in the target are left untouched instead
   * of being removed. Safer — the target keeps its extra structure.
   */
  nonDestructive?: boolean;
  /**
   * Server version string of the TARGET database (e.g. "19.3.0.0.0" for Oracle 19c,
   * "11.5.8.0" for DB2 11.5). Populated after a successful test-connection.
   * Passed to dialect drop hooks so they can emit version-safe DDL.
   */
  targetServerVersion?: string;
}

const PROCEDURAL_TYPES: ReadonlySet<DbObjectType> = new Set(['VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER']);
// Routines (FUNCTION/PROCEDURE) don't need ALTER'd columns to exist to be created —
// nothing validates their bodies against table structure at creation time. Anything
// that might CALL them (a trigger added during ALTER, another routine) does need
// them to exist first, so they're created before the ALTER phase, not after it —
// unlike VIEW/TRIGGER, which are ordered after ALTER (see generateMigrationPlan).
const ROUTINE_TYPES: ReadonlySet<DbObjectType> = new Set(['FUNCTION', 'PROCEDURE']);

/**
 * True when a name can be written into SQL exactly as it is.
 *
 * Deliberately conservative: letters, digits, underscore, `$` and `#` (Oracle
 * and DB2 allow the last two bare), never starting with a digit. Anything else
 * — a space, a dot, punctuation, a quote character, a non-ASCII letter — has to
 * be quoted or the statement is a syntax error.
 */
/**
 * Words that must be quoted to be usable as an identifier.
 *
 * The union across the supported engines, not any single one's list: a column
 * called `key` is fine in SQLite and a syntax error in MySQL, and the generator
 * emits for whichever dialect it was handed. Quoting a word one engine happens
 * not to reserve costs nothing — the name is quoted exactly as the catalog
 * spelled it, so it still resolves to the same object.
 *
 * Deliberately not exhaustive. It covers the clause keywords and the ones that
 * turn up as real column names; a full per-dialect list is a bigger job and
 * would only add words nobody names a column after.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BETWEEN', 'BOTH', 'BY',
  'CASE', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER',
  'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'FALSE', 'FETCH', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GRANT',
  'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO',
  'IS', 'JOIN', 'KEY', 'LEADING', 'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT',
  'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REFERENCES',
  'RENAME', 'REVOKE', 'RIGHT', 'ROW', 'ROWS', 'SELECT', 'SESSION_USER', 'SET',
  'SOME', 'TABLE', 'THEN', 'TO', 'TRAILING', 'TRUE', 'UNION', 'UNIQUE',
  'UPDATE', 'USER', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WITH',
]);

function isBareIdentifier(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name)) return false;
  return !RESERVED_WORDS.has(name.toUpperCase());
}

/** ANSI quoting, correct everywhere except MySQL's default mode. */
function ansiQuoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Already wrapped, **and wrapped correctly** — by an earlier pass here, or by
 * the catalog that handed it over. Such a name is passed through, because
 * quoting it again nests the quotes and breaks the statement, and `bareName`
 * genuinely is applied twice on some paths (the primary-key name reaches it
 * once on the way in and once on the way out).
 *
 * Matching the delimiters alone is not enough, and the difference is a DDL
 * injection. Names come from introspecting a source database, so a column may
 * be called whatever somebody created — including something that merely
 * *looks* wrapped:
 *
 *     "a" INTEGER); DROP TABLE victim; --"
 *
 * That starts and ends with `"`, so a shape check called it quoted and emitted
 * it verbatim, and `CREATE TABLE … ("a" INTEGER); DROP TABLE victim; --" …)`
 * is a valid CREATE followed by a valid DROP. A source schema the user does not
 * control — a vendor database, a restored dump, a shared or multi-tenant one —
 * could therefore put arbitrary DDL into the migration they run on their target.
 *
 * So the body is checked too. Every dialect here escapes the closing delimiter
 * by doubling it (`""`, ```` `` ````, `]]`), so with the doubled pairs removed a
 * surviving delimiter means the body closes the identifier early and whatever
 * follows is not part of the name. That name is not well-formed, and `ident`
 * sends it to the dialect's quoter to be escaped from scratch instead.
 */
/**
 * An identifier with its line breaks turned into spaces.
 *
 * A line break cannot be escaped inside a quoted identifier — to name that
 * column the generated SQL has to carry the break literally — and the script
 * writes names into `--` comments, which end at the first one. A table named
 *
 *     x⏎DROP TABLE victim; --
 *
 * therefore closed its `-- review:` note and left the rest of itself on the
 * next line as a statement of its own, which the migration then ran. Several
 * notes carry a name (review notes, manual-review blocks, the per-step
 * header), so this is fixed here, at the one point every name passes through,
 * rather than at each of them.
 *
 * The trade-off is deliberate: a name that really does contain a line break is
 * emitted with spaces instead, so that object needs a hand-written migration.
 * Such a name is pathological — and the alternative is executing DDL that a
 * source schema chose.
 */
function flattenIdentifier(name: string): string {
  return /[\r\n]/.test(name) ? name.replace(/[\r\n]+/g, ' ') : name;
}

/**
 * A whole `--` note on one line, for the review notes that quote a name the
 * generator did not put through `ident` — an index, constraint or trigger name,
 * or a type-translation warning that repeats one. Same reason as
 * `flattenIdentifier`: the note ends at the first line break, and anything
 * after it is a statement.
 */
function oneLineComment(text: string): string {
  return /[\r\n]/.test(text) ? text.replace(/[\r\n]+/g, ' ') : text;
}

/**
 * A statement that opens with `--` stays commented to its last line.
 *
 * The backstop behind `flattenIdentifier` and `oneLineComment`. Those cover the
 * names and notes this module writes, but a dialect hook builds its own review
 * notes out of values the generator never quotes — ClickHouse's ENGINE / ORDER BY
 * note repeats the sorting key, SQLite's column note repeats the type — and a
 * line break in any of them ends the note and leaves the rest executable.
 * Catching it once here covers every hook, including ones added later.
 *
 * Safe because a comment and code never share a statement: the per-step
 * `-- ACTION TYPE: name` header is emitted separately, not pushed as part of
 * one. Checked over 1056 statements across every dialect, same- and
 * cross-dialect, where nothing opening with `--` carried a non-comment line, so
 * this is a no-op on valid output. A statement that does not open with `--` is
 * never touched, so real DDL cannot be commented out.
 */
function keepCommentCommented(statement: string): string {
  const lines = statement.split(/\r\n|\r|\n/);
  const isComment = (line: string) => !line.trim() || line.trimStart().startsWith('--');
  if (lines.length < 2 || !lines[0]!.trimStart().startsWith('--')) return statement;
  if (lines.every(isComment)) return statement;
  return lines.map((line, i) => (i === 0 || isComment(line) ? line : `-- ${line}`)).join('\n');
}

function isWellFormedQuotedIdentifier(name: string): boolean {
  if (name.length < 2) return false;
  const open = name[0]!;
  if (open !== '"' && open !== '`' && open !== '[') return false;
  // `[` is closed by `]`; the others close with the character that opened them.
  const close = open === '[' ? ']' : open;
  if (name[name.length - 1] !== close) return false;
  const body = name.slice(1, -1);
  return !body.split(close + close).join('').includes(close);
}

export class SqlGeneratorModule {
  /** Table keys left in an FK cycle after Kahn sort (uppercase bare names). */
  private fkCycleKeys = new Set<string>();

  /**
   * How this dialect wraps an identifier that cannot be written bare. Set from
   * the resolved dialect at each entry point, like `fkCycleKeys` — threading it
   * through all 30-odd `qualify`/`bareName` call sites buys nothing.
   */
  private quoteIdentifier: (name: string) => string = ansiQuoteIdentifier;

  /**
   * Dialect name for the run in progress, for the capability matrices that are
   * keyed by name rather than by strategy object (`dialectSupportsFk`).
   */
  private dialectName = '';

  /** What this dialect can do with foreign keys. Empty name ⇒ the full matrix. */
  private fkSupport(): FkFeatureSupport {
    return dialectSupportsFk(this.dialectName);
  }

  /**
   * A name as it should appear in SQL: bare when that is legal, quoted when it
   * is not.
   *
   * Names come from a live catalog, so they are whatever somebody actually
   * created — `Order Details` (Northwind ships with it), a column called
   * `order id`, a Postgres table created with quotes. Emitting those raw
   * produced SQL that could not parse on any dialect.
   *
   * Quoting only what *needs* it keeps every ordinary name byte-identical to
   * what this generator emitted before, which is why this could be fixed
   * without rewriting the dialect test suites.
   */
  private ident(name: string): string {
    const flat = flattenIdentifier(name);
    if (isBareIdentifier(flat) || isWellFormedQuotedIdentifier(flat)) return flat;
    return this.quoteIdentifier(flat);
  }

  /**
   * A column's real identifier, ready to emit.
   *
   * `ColumnDiff.name` is the uppercased match key, exactly like `tableName` —
   * emitting it renamed `new col` to `NEW COL`. The native casing lives on
   * whichever side of the diff exists.
   */
  private columnIdent(col: ColumnDiff): string {
    return this.ident(col.source?.name ?? col.target?.name ?? col.name);
  }

  /**
   * Source catalog definitions qualify names with the source schema (HUY.GPX_FILE);
   * deploying into a different schema requires rewriting those qualifiers.
   */
  private remapSchema(statement: string, mapping?: SchemaMapping): string {
    const src = mapping?.sourceSchema?.trim();
    const tgt = mapping?.targetSchema?.trim();
    if (!src || !tgt || src.toUpperCase() === tgt.toUpperCase()) return statement;

    const escaped = escapeRegExp(src);
    return statement
      .replace(new RegExp(`"${escaped}"\\.`, 'gi'), `"${tgt}".`)
      .replace(new RegExp(`\\b${escaped}\\.`, 'gi'), `${tgt}.`);
  }

  /** Drops any leading "schema." prefix from an object name, and quotes if needed. */
  private bareName(name: string): string {
    return this.ident(name.replace(/^"?[^".]+"?\./, ''));
  }

  /**
   * Re-qualifies an object's own name to the target schema: strips whatever
   * schema it was read under (often the connection user's, e.g. HUY) and
   * prefixes the chosen target schema so DDL never lands in the wrong place.
   */
  private qualify(name: string, mapping?: SchemaMapping): string {
    const bare = this.bareName(name);
    const tgt = mapping?.targetSchema?.trim();
    return tgt ? `${tgt}.${bare}` : bare;
  }

  /**
   * Rewrites a source-schema qualifier embedded INSIDE a column default expression
   * (most commonly a sequence reference like `nextval(\`schema\`.\`seq\`)` or
   * `nextval('schema.seq')`) to the target schema. Providers read the default
   * verbatim from the source database, so without this the migrated column's
   * default keeps pointing at the source schema — wrong, and on some setups
   * (e.g. a source-only DB user) not even reachable from the target. Handles
   * bracket-, double-quote-, backtick-, and bare-qualified forms.
   */
  private requalifyDefault(defaultValue: string, mapping?: SchemaMapping): string {
    const src = mapping?.sourceSchema?.trim();
    const tgt = mapping?.targetSchema?.trim();
    if (!src || !tgt || src.toUpperCase() === tgt.toUpperCase()) return defaultValue;
    const esc = escapeRegExp(src);
    return defaultValue
      .replace(new RegExp(`\\[${esc}\\]\\s*\\.`, 'gi'), `[${tgt}].`)
      .replace(new RegExp(`"${esc}"\\s*\\.`, 'gi'), `"${tgt}".`)
      .replace(new RegExp('`' + esc + '`\\s*\\.', 'gi'), `\`${tgt}\`.`)
      .replace(new RegExp(`\\b${esc}\\.`, 'gi'), `${tgt}.`);
  }

  /** PK columns from the named constraint, falling back to per-column flags. */
  private primaryKeyColumns(table: TableSchema): string[] {
    if (table.primaryKey?.columns?.length) return table.primaryKey.columns;
    return table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  }

  /**
   * Same-column-set check that ignores identifier case (matching how the compare
   * module already treats these as equal) — used before deciding to touch a
   * table's primary key, so a native-casing difference alone never triggers a
   * DROP+ADD PRIMARY KEY. That's not just noise: on MySQL/MariaDB, rebuilding a
   * table's PK while another table holds an inbound FK to it can fail with
   * errno 150 ("Foreign key constraint is incorrectly formed") on the rename
   * step — a real error for a change that was never actually needed.
   */
  private sameColumnSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((c, i) => c.toUpperCase() === b[i].toUpperCase());
  }

  /** True when source and target dialects are both known and genuinely different. */
  private isCrossDialect(mapping?: SchemaMapping): boolean {
    if (!mapping?.sourceDialect || !mapping?.targetDialect) return false;
    return resolveDialect(mapping.sourceDialect) !== resolveDialect(mapping.targetDialect);
  }

  /**
   * Translate a native column type from the source dialect into the target
   * dialect. No-op (returns the raw type) for same-dialect migrations or when
   * the source dialect is unknown — so existing behavior is unchanged.
   */
  private translateType(rawType: string, mapping?: SchemaMapping): { sql: string; warning?: string } {
    if (!this.isCrossDialect(mapping)) return { sql: rawType };
    const source = resolveDialect(mapping!.sourceDialect!);
    const target = resolveDialect(mapping!.targetDialect!);
    return target.renderType(source.parseType(rawType));
  }

  /**
   * Procedural objects (views/functions/procedures/triggers) carry dialect-
   * specific bodies that can't be reliably auto-translated. Cross-dialect we emit
   * the original as a commented-out review block so the rest of the plan still runs.
   */
  /** Ensure a SQL definition ends with a semicolon — Postgres stores bodies without one. */
  private ensureSemicolon(def: string): string {
    const t = def.trim();
    return t.endsWith(';') ? t : t + ';';
  }

  /**
   * Generic fallback DROP FUNCTION/PROCEDURE — used when the dialect doesn't
   * implement its own `dropFunctionStatement`/`dropProcedureStatement` hook.
   * Only appends a parenthesized parameter-type signature when the dialect
   * opts in via `dropRoutineSignature` (Postgres/Redshift, which support
   * overloading). MySQL/MariaDB/SQL Server reject ANY parenthesized
   * signature — even an empty `()` — so the default is the bare form.
   */
  private dropRoutineSql(type: 'FUNCTION' | 'PROCEDURE', tableName: string, dialect: SqlDialect | undefined, params?: import('../../interfaces/index.js').RoutineParameter[]): string {
    const kw = type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    if (!dialect?.dropRoutineSignature || !params) return `DROP ${kw} IF EXISTS ${tableName};`;
    // Only IN/INOUT params appear in the call signature for DROP purposes
    const sig = params.filter((p) => p.mode === 'IN' || p.mode === 'INOUT').map((p) => p.type).join(', ');
    return `DROP ${kw} IF EXISTS ${tableName}(${sig});`;
  }

  private manualReviewBlock(obj: TableDiff, mapping?: SchemaMapping): string[] {
    const src = (mapping?.sourceDialect ?? '').toUpperCase();
    const tgt = (mapping?.targetDialect ?? '').toUpperCase();
    const lines = [
      `-- ============================================================`,
      `-- MANUAL REVIEW REQUIRED: ${obj.objectType} ${this.bareName(obj.tableName)}`,
      `-- Body is ${src} SQL and was NOT auto-translated to ${tgt}.`,
      `-- Review and adapt before running:`,
    ];
    const body = (obj.sourceTable?.definition ?? obj.definition ?? '').trim();
    for (const ln of (body ? body.split('\n') : ['(no definition available)'])) lines.push(`--   ${ln}`);
    lines.push(`-- ============================================================`);
    return lines;
  }

  private renderColumn(c: ColumnSpec & { name: string }, dialect: SqlDialect, mapping?: SchemaMapping, warnings?: string[]): string {
    const translated = this.translateType(c.type, mapping);
    if (translated.warning) warnings?.push(`${c.name}: ${translated.warning}`);
    let typeSql: string;
    if (dialect.nullableTypeWrapper) {
      // Dialect encodes nullability in the type (e.g. ClickHouse Nullable(T)) — no NOT NULL keyword.
      typeSql = dialect.nullableTypeWrapper(translated.sql, c.nullable);
    } else {
      typeSql = translated.sql + dialect.identityClause(c);
    }
    let def = `${this.ident(c.name)} ${typeSql}`;
    // COLLATE goes right after the type on every dialect that supports a per-column
    // collation (Postgres/MySQL/MariaDB/SQL Server/Oracle 12.2+), before DEFAULT/NOT
    // NULL. Dialects that never populate collation (DB2) simply never hit this.
    if (c.collation) def += dialect.columnCollateClause?.(c.collation) ?? ` COLLATE ${c.collation}`;
    if (!dialect.nullableTypeWrapper) {
      // Oracle requires DEFAULT before NOT NULL; the standard allows either order.
      if (c.defaultValue) def += ` DEFAULT ${this.requalifyDefault(c.defaultValue, mapping)}`;
      if (!c.nullable) def += ` NOT NULL`;
    }
    return def;
  }

  private renderCreateTable(table: TableSchema, dialect: SqlDialect, mapping?: SchemaMapping, warnings?: string[]): string {
    const lines = table.columns.map((c) => `  ${this.renderColumn(c, dialect, mapping, warnings)}`);

    const pkCols = this.primaryKeyColumns(table);
    if (pkCols.length > 0 && dialect.inlinePrimaryKeyConstraint !== false) {
      const pkName = table.primaryKey?.name;
      // MySQL names every PK constraint "PRIMARY" — emitting CONSTRAINT PRIMARY PRIMARY KEY
      // is redundant and confusing. Skip the CONSTRAINT clause for that reserved name.
      const constraintName = pkName && pkName.toUpperCase() !== 'PRIMARY' ? `CONSTRAINT ${this.bareName(pkName)} ` : '';
      lines.push(`  ${constraintName}PRIMARY KEY (${pkCols.map((c) => this.ident(c)).join(', ')})`);
    }

    // A dialect that cannot ALTER a constraint in must declare it here or lose
    // it: for SQLite the CREATE TABLE is the only chance the FK ever gets.
    const fk = this.fkSupport();
    if (!fk.alterAdd && fk.createInline) {
      for (const key of table.foreignKeys ?? []) {
        const cols = (key.columns ?? []).map((c) => this.ident(c));
        const parent = (key.referencedColumns ?? []).map((c) => this.ident(c));
        if (cols.length === 0 || parent.length !== cols.length) continue;
        const named = key.name ? `CONSTRAINT ${this.bareName(key.name)} ` : '';
        lines.push(
          `  ${named}FOREIGN KEY (${cols.join(', ')}) REFERENCES ${this.qualify(key.referencedTable, mapping)} (${parent.join(', ')})`
        );
      }
    }

    let suffix = '';
    if (dialect.createTableSuffix) {
      // A sorting key the engine rendered itself (ClickHouse `sorting_key`) is
      // already valid SQL and may be an expression — `tuple()`, `cityHash64(id)`
      // — so it is emitted verbatim. Anything else is a plain column name and is
      // quoted.
      //
      // Trust comes from `orderByFromCatalog`, never from the text: the previous
      // rule passed any entry containing a paren through unquoted, which a column
      // named `id) ORDER BY (id) --` satisfied, so a source schema could carry
      // DDL out of the ORDER BY clause.
      const quotedOrderBy =
        table.orderByFromCatalog && table.orderBy?.length
          ? [...table.orderBy]
          : (table.orderBy?.length ? table.orderBy : pkCols).map((c) => this.ident(c));
      // A primary key is a column list, so it is always quoted.
      suffix = dialect.createTableSuffix(table, quotedOrderBy, pkCols.map((c) => this.ident(c)));
    }
    return `CREATE TABLE ${this.qualify(table.name, mapping)} (\n${lines.join(',\n')}\n)${suffix};`;
  }

  /**
   * CREATE INDEX for an index, letting the dialect special-case a constraint-backing
   * index (SQL Server renders it as ALTER TABLE ADD CONSTRAINT). `idx.name` must be bare.
   */
  private createIndexSql(idx: IndexInfo, qualifiedTable: string, dialect?: SqlDialect): string {
    // Oracle keeps a function-based index's expression in ALL_IND_EXPRESSIONS
    // and puts a hidden `SYS_NC00006$` placeholder in ALL_IND_COLUMNS, which is
    // what introspection reads. Emitting that name is ORA-00904 ("invalid
    // identifier") — the index cannot be built from what we captured, so say so
    // rather than shipping DDL that cannot run.
    const hidden = idx.columns.find((c) => /^SYS_NC\d+\$$/i.test((c ?? '').trim()));
    if (hidden) {
      return oneLineComment(`-- review: skip index ${idx.name} on ${qualifiedTable} — function-based index; its expression is not captured (column reads as ${hidden})`);
    }
    // Quote the column names *before* handing them to a dialect hook: the hooks
    // build their own column list, so a hook-owning dialect (SQLite, SQL Server)
    // would otherwise emit `ON t (order id)` while the generic path below got
    // this right. `ident` is idempotent, so quoting here is safe either way.
    const quoted: IndexInfo = { ...idx, columns: idx.columns.map((c) => this.ident(c)) };
    if (dialect?.createIndexStatement) return dialect.createIndexStatement(quoted, qualifiedTable);
    const uniqueStr = quoted.unique ? ' UNIQUE' : '';
    const whereClause = quoted.filter?.trim() ? ` WHERE ${quoted.filter.trim()}` : '';
    return `CREATE${uniqueStr} INDEX ${quoted.name} ON ${qualifiedTable} (${quoted.columns.join(', ')})${whereClause};`;
  }

  /**
   * Emit ADD FOREIGN KEY DDL, or a `-- review:` comment when referenced columns
   * are missing / length-mismatched (avoids `REFERENCES t ()`).
   */
  private addForeignKeySql(
    qualifiedTable: string,
    constraintName: string,
    columns: string[],
    referencedTable: string,
    referencedColumns: string[] | undefined,
    multiline = false
  ): string {
    const refCols = referencedColumns ?? [];
    const label = constraintName || '(unnamed)';
    if (columns.length === 0 || refCols.length !== columns.length) {
      return oneLineComment(`-- review: skip FK ${label} — referenced columns missing or length mismatch`);
    }
    // SQLite and ClickHouse have no ALTER TABLE ... ADD CONSTRAINT. The matrix
    // already knew that and only the blueprint UI was reading it, so the
    // migration emitted a statement the engine rejects outright. A note beats
    // DDL that cannot run.
    const fk = this.fkSupport();
    if (!fk.alterAdd) {
      return oneLineComment(`-- review: skip FK ${label} — ${fk.hint}`);
    }
    const cols = columns.map((c) => this.ident(c)).join(', ');
    const parentCols = refCols.map((c) => this.ident(c)).join(', ');
    const fkBody = multiline
      ? `FOREIGN KEY (${cols}) REFERENCES ${referencedTable} (${parentCols})`
      : `FOREIGN KEY (${cols}) REFERENCES ${referencedTable} (${parentCols})`;
    if (multiline) {
      return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} \n  ${fkBody};`;
    }
    return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} ${fkBody};`;
  }

  private renderCreateSequence(table: TableSchema, dialect?: SqlDialect): string {
    const s = table.sequence ?? {};
    const name = table.name;
    let opts = '';
    if (s.dataType) opts += ` AS ${s.dataType}`;
    if (s.start !== undefined) opts += ` START WITH ${s.start}`;
    if (s.increment !== undefined) opts += ` INCREMENT BY ${s.increment}`;
    if (s.minValue !== undefined) opts += ` MINVALUE ${s.minValue}`;
    if (s.maxValue !== undefined) opts += ` MAXVALUE ${s.maxValue}`;
    // `NO CYCLE` on most engines, `NOCYCLE` on Oracle — the spaced form is
    // ORA-03049 there, and it takes the dependent table and views down with it.
    const no = dialect?.unspacedSequenceNoKeywords ? 'NO' : 'NO ';
    opts += s.cycle ? ` CYCLE` : ` ${no}CYCLE`;
    if (s.cache !== undefined) opts += s.cache > 0 ? ` CACHE ${s.cache}` : ` ${no}CACHE`;
    const createSql = `CREATE SEQUENCE ${name}${opts};`;
    return dialect?.wrapCreateSequence?.(name, createSql) ?? `CREATE SEQUENCE IF NOT EXISTS ${name}${opts};`;
  }

  private renderCreateType(table: TableSchema, dialect?: SqlDialect): string {
    // Let the dialect produce its own CREATE TYPE (e.g. Postgres ENUM).
    const dialectSql = dialect?.createTypeStatement?.(table);
    if (dialectSql) return dialectSql;

    const u = table.userType ?? {};
    if (u.attributes && u.attributes.length > 0) {
      const attrs = u.attributes.map((a) => `  ${a.name} ${a.type}`).join(',\n');
      return `CREATE TYPE ${table.name} AS (\n${attrs}\n) MODE DB2SQL;`;
    }
    return `CREATE TYPE ${table.name} AS ${u.sourceType ?? 'VARCHAR(255)'} WITH COMPARISONS;`;
  }

  generateObjectDdl(table: TableSchema, dialectStr = 'db2'): string {
    const dialect = resolveDialect(dialectStr);
    this.quoteIdentifier = dialect.quoteIdentifier ?? ansiQuoteIdentifier;
    this.dialectName = dialectStr;
    if (table.objectType === 'SEQUENCE') return this.renderCreateSequence(table, dialect);
    if (table.objectType === 'TYPE') return this.renderCreateType(table, dialect);
    if (table.objectType !== 'TABLE' && table.objectType !== 'MQT') {
      return table.definition || oneLineComment(`-- No definition available for ${table.objectType} ${table.name}`);
    }

    let sql = this.renderCreateTable(table, dialect) + `\n`;

    for (const idx of table.indices) {
      sql += this.createIndexSql({ ...idx, name: this.bareName(idx.name) }, table.name, dialect) + `\n`;
    }

    for (const fk of table.foreignKeys) {
      sql +=
        this.addForeignKeySql(
          table.name,
          fk.name,
          fk.columns,
          fk.referencedTable,
          fk.referencedColumns
        ) + `\n`;
    }

    for (const trg of table.triggers ?? []) {
      // ensureSemicolon, not a bare trim: a catalog definition can end at `END`
      // with no terminator (SQLite's sqlite_master.sql does), and an
      // unterminated CREATE TRIGGER swallows whatever statement follows it.
      sql += trg.definition
        ? `${this.ensureSemicolon(trg.definition)}\n`
        : `-- Trigger ${flattenIdentifier(trg.name)} (${trg.timing ?? ''} ${trg.event ?? ''}) has no available definition\n`;
    }

    return sql;
  }

  private dropObjectStatements(obj: TableDiff, mapping?: SchemaMapping, dialect?: SqlDialect): string[] {
    const statements: string[] = [];
    // Use the object's native casing (it's the only thing the target DB actually has) —
    // obj.tableName is the uppercased match key from compare.module.ts, not a real identifier.
    const name = this.qualify(obj.targetTable?.name ?? obj.tableName, mapping);
    const ver = mapping?.targetServerVersion;
    if (obj.objectType === 'TABLE') {
      // Drop all inbound FK constraints before dropping the table. Required for SQL Server
      // (no CASCADE support); a no-op for dialects that don't implement the hook.
      statements.push(...(dialect?.preDropTableStatements?.(name) ?? []));
      statements.push(dialect?.dropTableStatement?.(name, ver) ?? `DROP TABLE IF EXISTS ${name};`);
    } else if (obj.objectType === 'MQT') {
      // Default matches the pre-existing (implicit) behavior for dialects without
      // a dedicated hook (DB2 MQTs drop like a table). Postgres overrides with
      // DROP MATERIALIZED VIEW — it rejects DROP TABLE on one.
      statements.push(dialect?.dropMaterializedViewStatement?.(name) ?? `DROP TABLE IF EXISTS ${name};`);
    } else if (obj.objectType === 'VIEW') {
      statements.push(dialect?.dropViewStatement?.(name, ver) ?? `DROP VIEW IF EXISTS ${name};`);
    } else if (obj.objectType === 'FUNCTION') {
      // Dialect hook takes precedence; fall back to signature-aware generic drop.
      statements.push(dialect?.dropFunctionStatement?.(name, ver) ?? this.dropRoutineSql('FUNCTION', name, dialect, obj.targetTable?.parameters));
    } else if (obj.objectType === 'PROCEDURE') {
      statements.push(dialect?.dropProcedureStatement?.(name, ver) ?? this.dropRoutineSql('PROCEDURE', name, dialect, obj.targetTable?.parameters));
    } else if (obj.objectType === 'TRIGGER') {
      statements.push(`DROP TRIGGER IF EXISTS ${name};`);
    } else if (obj.objectType === 'SEQUENCE') {
      statements.push(dialect?.dropSequenceStatement?.(name, ver) ?? `DROP SEQUENCE IF EXISTS ${name};`);
    } else if (obj.objectType === 'TYPE') {
      statements.push(`DROP TYPE IF EXISTS ${name};`);
    } else if (obj.objectType === 'ROLE') {
      statements.push(`DROP ROLE IF EXISTS ${this.bareName(obj.tableName)};`);
    }
    return statements;
  }

  private createObjectStatements(obj: TableDiff, dialect: SqlDialect, mapping?: SchemaMapping): string[] {
    const statements: string[] = [];
    const source = obj.sourceTable;
    // Use the source object's native casing so this matches the casing renderCreateTable
    // emits in the CREATE TABLE statement above — obj.tableName is just the uppercased
    // match key from compare.module.ts and may differ in casing on case-sensitive engines.
    const name = this.qualify(source?.name ?? obj.tableName, mapping);

    if ((obj.objectType === 'TABLE' || obj.objectType === 'MQT') && source) {
      const typeWarnings: string[] = [];
      const cycleKey = compareKey(source.name ?? obj.tableName);
      if (this.fkCycleKeys.has(cycleKey)) {
        const cycleList = [...this.fkCycleKeys].sort().join(', ');
        statements.push(
          oneLineComment(`-- review: FK cycle involving ${cycleList} — create order may fail; break the cycle manually`)
        );
      }
      // Postgres matviews (definition captured + dialect hook available) render as a
      // true CREATE MATERIALIZED VIEW; DB2 MQTs and any other MQT without a captured
      // backing query fall back to the plain CREATE TABLE shape used before this hook
      // existed — same indices/FKs/triggers loops below still apply to either shape.
      const createTable =
        obj.objectType === 'MQT' && source.definition && dialect.createMaterializedViewStatement
          ? dialect.createMaterializedViewStatement(name, this.ensureSemicolon(source.definition))
          : this.renderCreateTable(source, dialect, mapping, typeWarnings);
      for (const w of typeWarnings) statements.push(oneLineComment(`-- review: ${w}`));

      // Postgres serial columns reference a backing sequence in their DEFAULT
      // (nextval('…_seq'::regclass)). That sequence must exist before the table
      // that uses it, or a cross-schema CREATE fails with
      // 'relation "<name>_id_seq" does not exist'. Create it first and tie its
      // lifecycle to the column so it drops with the table.
      const seqOwned: string[] = [];
      if (dialect.serialSequenceFromDefault) {
        const seen = new Set<string>();
        for (const c of source.columns) {
          const seq = dialect.serialSequenceFromDefault(c.defaultValue ?? '');
          if (!seq || seen.has(seq)) continue;
          seen.add(seq);
          statements.push(`CREATE SEQUENCE IF NOT EXISTS ${this.qualify(seq, mapping)};`);
          seqOwned.push(`ALTER SEQUENCE ${this.qualify(seq, mapping)} OWNED BY ${name}.${c.name};`);
        }
      }
      statements.push(createTable);
      statements.push(...seqOwned);

      for (const idx of source.indices) {
        // Index name must be bare — it's created in the (qualified) table's schema.
        // A schema-qualified index name is a syntax error in Postgres/MySQL/SQL Server.
        statements.push(this.createIndexSql({ ...idx, name: this.bareName(idx.name) }, name, dialect));
      }

      for (const fk of source.foreignKeys) {
        statements.push(
          this.addForeignKeySql(
            name,
            this.bareName(fk.name),
            fk.columns,
            this.qualify(fk.referencedTable, mapping),
            fk.referencedColumns,
            true
          )
        );
      }

      for (const trg of source.triggers ?? []) {
        if (!trg.definition) continue;
        const stmt = dialect.createTriggerStatement?.(trg, name) ?? null;
        // See renderCreateTable: an unterminated CREATE TRIGGER swallows the
        // next statement. The dialect hooks already end in `;`; this is a no-op
        // for them and supplies the terminator for a raw catalog definition.
        statements.push(this.ensureSemicolon(stmt ?? trg.definition));
      }
    } else if (obj.objectType === 'SEQUENCE' && source) {
      statements.push(this.renderCreateSequence({ ...source, name }, dialect));
    } else if (obj.objectType === 'TYPE' && source) {
      statements.push(this.renderCreateType({ ...source, name }, dialect));
    } else if (obj.objectType === 'ROLE') {
      const roleName = this.bareName(obj.tableName);
      statements.push(`CREATE ROLE ${roleName};`);
      for (const m of obj.columnDiffs) {
        const info = m.source ?? m.target;
        if (info) statements.push(`GRANT ROLE ${roleName} TO ${info.type} ${m.name};`);
      }
    } else if (PROCEDURAL_TYPES.has(obj.objectType) && this.isCrossDialect(mapping)) {
      statements.push(...this.manualReviewBlock(obj, mapping));
    } else if (obj.definition) {
      if (obj.objectType === 'VIEW') {
        const body = this.ensureSemicolon(obj.definition);
        statements.push(dialect.createViewStatement?.(name, body) ?? `CREATE OR REPLACE VIEW ${name} AS\n${body}`);
      } else {
        statements.push(this.ensureSemicolon(obj.definition));
      }
    }
    return statements;
  }

  /**
   * Matches a view/routine body that references `tableName` as a relation
   * (schema-qualified or bare); null when the name is empty. Used by the generate-time dependent-view
   * fallback for dialects that cannot run Postgres's pg_depend DO-block guard
   * (e.g. CockroachDB).
   *
   * Matches names in relation position (FROM / JOIN / UPDATE / INTO / TABLE /
   * USING / REFERENCES) so column identifiers and SQL keywords like
   * `ORDER BY` / `GROUP BY` do not false-positive when the table is named
   * `status`, `order`, `group`, etc.
   */
  private tableReferencePattern(tableName: string): RegExp | null {
    const bare = tableName.replace(/^.*\./, '').replace(/"/g, '');
    if (!bare) return null;
    const escaped = escapeRegExp(bare);
    // Up to two qualifiers, then the bare table (optionally quoted).
    //
    // Two, not one: CockroachDB reports view bodies qualified by the database
    // as well as the schema —
    //   `... JOIN foxdb.demo_b.order_items AS oi ...`
    // — and with a single optional qualifier this matched `demo_b.order_items`
    // but not `foxdb.demo_b.order_items`. The dependency went unseen, so the
    // view was not dropped around the ALTER and the migration failed on the
    // live engine with "cannot alter type of column ... because view ...
    // depends on it". SQL Server can qualify the same way.
    //
    // Only the bare name is ever compared (see `bare` above), so widening this
    // cannot miss a dependency — at worst it drops and recreates a view that
    // referenced a same-named table elsewhere, which is the safe direction:
    // an unnecessary recreate costs nothing, a missed one fails the migration.
    const relation = String.raw`(?:(?:"[^"]+"|[\w]+)\s*\.\s*){0,2}"?${escaped}"?\b`;
    // No `g` flag, so `.test` keeps no lastIndex state and the pattern can be
    // reused across every candidate body.
    return new RegExp(
      String.raw`\b(?:from|join|update|into|table|using|references)\s+${relation}`,
      'i'
    );
  }

  private alterObjectStatements(
    obj: TableDiff,
    dialect: SqlDialect,
    mapping?: SchemaMapping,
    contextDiffs: TableDiff[] = [],
    /** `selectionKey` of each object selected for this deploy — unchecked dependents restore target DDL. */
    selectedKeys: ReadonlySet<string> = new Set()
  ): string[] {
    const statements: string[] = [];
    // The table already exists in the target — reference it with the casing it
    // actually has there, not the uppercased compare-module match key.
    const tableName = this.qualify(obj.targetTable?.name ?? obj.tableName, mapping);

    if (obj.objectType === 'TABLE') {
      // Some dialects (Postgres) reject ALTER/DROP COLUMN on tables that a view
      // depends on. The dialect provides drop/recreate blocks to handle this at
      // apply-time. ADD COLUMN never triggers this — only MODIFIED/REMOVED columns.
      const hasStructuralColumnChanges = obj.columnDiffs.some(
        (c) => c.status === 'MODIFIED' || (c.status === 'REMOVED' && !mapping?.nonDestructive)
      );
      const dropViewsBlock = hasStructuralColumnChanges
        ? (dialect.dropDependentViewsBlock?.(tableName) ?? null)
        : null;
      if (dropViewsBlock) statements.push(dropViewsBlock);

      // Dialects without a runtime guard (CockroachDB — no PL/pgSQL FOR/EXECUTE /
      // CREATE TABLE AS inside DO) get explicit DROP/CREATE statements for views
      // and routines that reference this table. Cockroach also rejects ALTER COLUMN
      // TYPE when a function depends on the column — same generate-time treatment.
      //
      // Only DROP a dependent when we also have DDL to recreate it. Prefer source
      // DDL only for dependents that are themselves selected for deploy; otherwise
      // restore the target body so unchecked MODIFIED objects are not rewritten.
      type DependentRecreate = { dep: TableDiff; rawDef: string; useSource: boolean };
      // Built once per table, not once per candidate body.
      const refPattern = !dropViewsBlock && hasStructuralColumnChanges
        ? this.tableReferencePattern(tableName)
        : null;
      const references = (def: string | undefined) => !!def && !!refPattern?.test(def);
      const dependentsToRecreate: DependentRecreate[] = refPattern
        ? contextDiffs.flatMap((d): DependentRecreate[] => {
            if (d.objectType !== 'VIEW' && d.objectType !== 'MQT'
              && d.objectType !== 'FUNCTION' && d.objectType !== 'PROCEDURE') {
              return [];
            }
            // ADDED views/MQTs are created AFTER the ALTER phase — they don't exist
            // on the target yet. ADDED routines are created BEFORE ALTER, so they do.
            if (d.status === 'ADDED' && (d.objectType === 'VIEW' || d.objectType === 'MQT')) {
              return [];
            }
            const isSelected = selectedKeys.has(selectionKey(d));
            // Intentionally removed (destructive): DROP phase already handled it —
            // do not temporarily drop/recreate around ALTER.
            if (d.status === 'REMOVED' && !mapping?.nonDestructive && isSelected) {
              return [];
            }
            const targetDef = d.targetTable?.definition ?? (d.status === 'REMOVED' ? d.definition : undefined);
            const sourceDef = d.sourceTable?.definition ?? (d.status !== 'REMOVED' ? d.definition : undefined);
            if (!references(targetDef) && !references(sourceDef)) {
              return [];
            }
            const useSource = isSelected && !!sourceDef?.trim();
            const rawDef = (useSource ? sourceDef : (targetDef ?? sourceDef))?.trim();
            // No body available → skip DROP so we never leave the object missing.
            if (!rawDef) return [];
            return [{ dep: d, rawDef, useSource }];
          })
        : [];
      for (const { dep } of dependentsToRecreate) {
        const depName = this.qualify(dep.targetTable?.name ?? dep.sourceTable?.name ?? dep.tableName, mapping);
        const ver = mapping?.targetServerVersion;
        if (dep.objectType === 'MQT') {
          statements.push(
            dialect.dropMaterializedViewStatement?.(depName) ?? `DROP MATERIALIZED VIEW IF EXISTS ${depName};`
          );
        } else if (dep.objectType === 'VIEW') {
          statements.push(dialect.dropViewStatement?.(depName) ?? `DROP VIEW IF EXISTS ${depName};`);
        } else if (dep.objectType === 'FUNCTION') {
          statements.push(
            dialect.dropFunctionStatement?.(depName, ver)
            ?? this.dropRoutineSql('FUNCTION', depName, dialect, dep.targetTable?.parameters ?? dep.sourceTable?.parameters)
          );
        } else if (dep.objectType === 'PROCEDURE') {
          statements.push(
            dialect.dropProcedureStatement?.(depName, ver)
            ?? this.dropRoutineSql('PROCEDURE', depName, dialect, dep.targetTable?.parameters ?? dep.sourceTable?.parameters)
          );
        }
      }

      // Drop FK constraints FIRST — before indexes and column drops. Dropping a
      // column cascades to any FK whose source columns include it, so an explicit
      // DROP CONSTRAINT afterwards fails with "does not exist". Dropping indexes
      // also requires the column to still exist if the FK holds a reference.
      if (!mapping?.nonDestructive) {
        for (const fk of obj.foreignKeyDiffs.filter((f) => f.status === 'REMOVED' || f.status === 'MODIFIED')) {
          if (fk.name) {
            const fkName = this.bareName(fk.name);
            statements.push(
              dialect.dropForeignKeyStatement?.(tableName, fkName) ??
              `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${fkName};`
            );
          }
        }
      }

      // Drop obsolete indexes BEFORE column changes. Dropping a column cascades to
      // any index on it (Postgres/others), so an explicit DROP INDEX afterwards would
      // fail with "index does not exist". Doing it first also frees columns being retyped.
      // Non-destructive: keep target-only indexes (REMOVED); MODIFIED are still
      // dropped here and recreated below (that's a change, not a removal).
      for (const idx of obj.indexDiffs.filter((i) => i.status === 'MODIFIED' || (i.status === 'REMOVED' && !mapping?.nonDestructive))) {
        const dropIdx: IndexInfo | undefined = idx.target ? { ...idx.target, name: this.bareName(idx.name) } : undefined;
        statements.push(
          dialect.dropIndexStatement?.(this.bareName(idx.name), tableName, dropIdx) ??
          `DROP INDEX ${this.qualify(idx.name, mapping)};`
        );
      }

      for (const col of obj.columnDiffs.filter((c) => c.status === 'ADDED')) {
        if (!col.source) continue;
        const translated = this.translateType(col.source.type, mapping);
        if (translated.warning) statements.push(oneLineComment(`-- review: ${col.name}: ${translated.warning}`));
        // A serial column added to an existing table needs its sequence first.
        const seq = dialect.serialSequenceFromDefault?.(col.source.defaultValue ?? '');
        if (seq) statements.push(`CREATE SEQUENCE IF NOT EXISTS ${this.qualify(seq, mapping)};`);
        let addTypeSql: string;
        if (dialect.nullableTypeWrapper) {
          addTypeSql = dialect.nullableTypeWrapper(translated.sql, col.source.nullable);
        } else {
          addTypeSql = translated.sql;
        }
        // Pre-quoted here rather than inside each dialect's hook: the hooks all
        // interpolate the name they are given, so quoting at the one call site
        // fixes ADD COLUMN on all 14 at once. `ident` is idempotent, so a hook
        // that already quotes is unaffected.
        let colDef = `${this.columnIdent(col)} ${addTypeSql}`;
        if (col.source.collation) colDef += dialect.columnCollateClause?.(col.source.collation) ?? ` COLLATE ${col.source.collation}`;
        if (!dialect.nullableTypeWrapper) {
          // Oracle requires DEFAULT before NOT NULL; the standard allows either order.
          if (col.source.defaultValue) colDef += ` DEFAULT ${this.requalifyDefault(col.source.defaultValue, mapping)}`;
          if (!col.source.nullable) colDef += ` NOT NULL`;
        }
        statements.push(dialect.addColumnStatement(tableName, colDef));
        // Let the dialect clean up after its own workaround (DB2's implicit
        // `WITH DEFAULT`), or the migration never converges.
        statements.push(
          ...(dialect.afterAddColumnStatements?.(tableName, this.columnIdent(col), col.source) ?? [])
        );
      }

      // A type change can also leave a table needing maintenance (see
      // `postColumnChangeStatements`), so it is tracked alongside the drops.
      let retypedColumns = false;
      for (const col of obj.columnDiffs.filter((c) => c.status === 'MODIFIED')) {
        if (!col.source) continue;
        if (col.target && col.source.type !== col.target.type) retypedColumns = true;
        const translated = this.translateType(col.source.type, mapping);
        if (translated.warning) statements.push(oneLineComment(`-- review: ${col.name}: ${translated.warning}`));
        // Cross-dialect: the raw default AND collation are source-dialect vocabulary
        // (collation names don't map across engines any more than default expressions
        // do) — strip both so a hook never emits either verbatim into the target
        // dialect. The default-diff branch below flags a default for manual review;
        // collation differences are simply never compared cross-dialect (see
        // CompareModule.collationChanged), so there's nothing to flag here.
        const colSpec = this.isCrossDialect(mapping)
          ? { ...col.source, type: translated.sql, defaultValue: undefined, collation: undefined }
          : { ...col.source, type: translated.sql };
        statements.push(...dialect.modifyColumnStatements(tableName, this.columnIdent(col), colSpec, col.target?.nullable));

        // The compare flags a column as MODIFIED when only its DEFAULT differs, but
        // the type/nullability statements above don't carry the default — apply it
        // explicitly so the migration actually converges.
        const srcDef = col.source.defaultValue;
        const tgtDef = col.target?.defaultValue;
        if ((srcDef ?? '') !== (tgtDef ?? '')) {
          if (this.isCrossDialect(mapping) && srcDef) {
            // A default expression is source-dialect SQL; don't risk emitting it
            // verbatim into another dialect — flag it for review instead.
            statements.push(oneLineComment(`-- review: ${col.name}: default '${srcDef}' is ${(mapping?.sourceDialect ?? '').toUpperCase()} syntax — set it manually for ${(mapping?.targetDialect ?? '').toUpperCase()}`));
          } else {
            // A new serial/sequence default needs its backing sequence to exist first.
            const seqForDefault = dialect.serialSequenceFromDefault?.(srcDef ?? '');
            if (seqForDefault) statements.push(`CREATE SEQUENCE IF NOT EXISTS ${this.qualify(seqForDefault, mapping)};`);
            const requalifiedDef = srcDef !== undefined ? this.requalifyDefault(srcDef, mapping) : srcDef;
            statements.push(...dialect.setDefaultStatements(tableName, this.columnIdent(col), requalifiedDef));
          }
        }
      }

      const droppedColumns =
        !mapping?.nonDestructive && obj.columnDiffs.some((c) => c.status === 'REMOVED');
      if (!mapping?.nonDestructive) {
        for (const col of obj.columnDiffs.filter((c) => c.status === 'REMOVED')) {
          statements.push(dialect.dropColumnStatement(tableName, this.columnIdent(col)));
        }
      }

      // Before the keys and indexes are rebuilt, not after: an engine that
      // needs maintenance here (DB2's REORG) rejects those rebuilds too while
      // the table is pending.
      if (droppedColumns || retypedColumns) {
        statements.push(
          ...(dialect.postColumnChangeStatements?.(tableName, {
            dropped: droppedColumns,
            retyped: retypedColumns,
          }) ?? [])
        );
      }

      const srcPk = obj.sourceTable ? this.primaryKeyColumns(obj.sourceTable) : [];
      const tgtPk = obj.targetTable ? this.primaryKeyColumns(obj.targetTable) : [];
      if (!this.sameColumnSet(srcPk, tgtPk)) {
        if (tgtPk.length > 0) {
          const pkName = obj.targetTable?.primaryKey?.name
            ? this.bareName(obj.targetTable.primaryKey.name)
            : undefined;
          statements.push(...dialect.dropPrimaryKeyStatements(tableName, pkName));
        }
        if (srcPk.length > 0) {
          const pkName = obj.sourceTable?.primaryKey?.name;
          if (dialect.addPrimaryKeyStatements) {
            statements.push(
              ...dialect.addPrimaryKeyStatements(
                tableName,
                srcPk.map((c) => this.ident(c)),
                pkName ? this.bareName(pkName) : undefined
              )
            );
          } else {
            // MySQL/MariaDB always name the PK constraint "PRIMARY" — emitting
            // CONSTRAINT PRIMARY PRIMARY KEY is invalid syntax. Skip the CONSTRAINT
            // clause for that reserved name (mirrors renderCreateTable's guard).
            const constraint = pkName && pkName.toUpperCase() !== 'PRIMARY' ? `CONSTRAINT ${this.bareName(pkName)} ` : '';
            statements.push(`ALTER TABLE ${tableName} ADD ${constraint}PRIMARY KEY (${srcPk.join(', ')});`);
          }
        }
      }

      if (obj.sourceTable && obj.targetTable && dialect.engineChangeStatements) {
        statements.push(...dialect.engineChangeStatements(tableName, obj.sourceTable, obj.targetTable));
      }

      for (const idx of obj.indexDiffs.filter((i) => i.status === 'ADDED' || i.status === 'MODIFIED')) {
        const srcIdx = idx.source;
        if (!srcIdx) continue;
        // Bare index name (its schema follows the qualified table) — a qualified
        // index name is a syntax error in Postgres/MySQL/SQL Server.
        //
        // `idx.name` is compare's uppercased match key, not an identifier, so
        // it would create IDX_CUSTOMERS_EMAIL where the source has
        // idx_customers_email — a different index on any dialect that does not
        // fold case, and a phantom rename on the next compare. The source's own
        // name is the identifier; the key is only the fallback for a source
        // that somehow carries none.
        const indexName = this.bareName(srcIdx.name || idx.name);
        statements.push(this.createIndexSql({ ...srcIdx, name: indexName }, tableName, dialect));
      }

      // Add new / recreate modified FK constraints (after all column changes are done).
      for (const fk of obj.foreignKeyDiffs.filter((f) => f.status === 'ADDED' || f.status === 'MODIFIED')) {
        const info = fk.source;
        if (!info) continue;
        statements.push(
          this.addForeignKeySql(
            tableName,
            this.bareName(fk.name),
            info.columns,
            this.qualify(info.referencedTable, mapping),
            info.referencedColumns
          )
        );
      }

      // trg.name is the uppercased compare-key match name, not a real identifier — use
      // the native-cased name from the actual side being touched. Several engines
      // (MariaDB/MySQL on Linux) treat trigger names case-sensitively, so a DROP TRIGGER
      // IF EXISTS issued with the wrong case silently no-ops instead of erroring, leaving
      // the table permanently flagged as modified on every future compare.
      for (const trg of (obj.triggerDiffs ?? []).filter((t) => t.status === 'MODIFIED' || (t.status === 'REMOVED' && !mapping?.nonDestructive))) {
        const dropName = trg.target?.name ?? trg.name;
        statements.push(
          dialect.dropTriggerStatement?.(this.bareName(dropName), tableName) ??
          `DROP TRIGGER ${this.qualify(dropName, mapping)};`
        );
      }
      for (const trg of (obj.triggerDiffs ?? []).filter((t) => t.status === 'ADDED' || t.status === 'MODIFIED')) {
        if (!trg.source?.definition) continue;
        const trgSpec = { name: trg.source.name, timing: trg.source.timing, event: trg.source.event, definition: trg.source.definition };
        const stmt = dialect.createTriggerStatement?.(trgSpec, tableName) ?? null;
        statements.push(this.ensureSemicolon(stmt ?? trg.source.definition));
      }

      // Recreate any views dropped by the dialect's dropDependentViewsBlock above.
      if (dropViewsBlock) {
        const recreateBlock = dialect.recreateDependentViewsBlock?.(tableName);
        if (recreateBlock) statements.push(recreateBlock);
      }

      // Generate-time recreate for every dependent we dropped above (same set /
      // same DDL resolved before the DROP so we never drop without a CREATE).
      for (const { dep, rawDef, useSource } of dependentsToRecreate) {
        const depName = this.qualify(
          (useSource ? dep.sourceTable?.name : undefined) ?? dep.targetTable?.name ?? dep.sourceTable?.name ?? dep.tableName,
          mapping
        );
        const body = this.ensureSemicolon(rawDef);
        if (dep.objectType === 'MQT' && dialect.createMaterializedViewStatement) {
          statements.push(dialect.createMaterializedViewStatement(depName, body));
        } else if (dep.objectType === 'VIEW') {
          statements.push(
            dialect.createViewStatement?.(depName, body) ?? `CREATE OR REPLACE VIEW ${depName} AS\n${body}`
          );
        } else {
          // FUNCTION / PROCEDURE — stored definition is already a full CREATE statement.
          statements.push(body);
        }
      }
    } else if (obj.objectType === 'SEQUENCE' && obj.sourceTable) {
      const s = obj.sourceTable.sequence ?? {};
      let alter = `ALTER SEQUENCE ${tableName}`;
      // Only Postgres can change a sequence's data type via ALTER SEQUENCE ... AS.
      // SQL Server rejects it outright ("Argument 'AS' cannot be used"), and
      // Oracle/DB2/MariaDB have no such clause either — gate behind the flag.
      if (s.dataType && dialect.alterSequenceAsType) alter += ` AS ${s.dataType}`;
      // Re-align the sequence's next value. The CREATE path uses START WITH; ALTER uses
      // RESTART WITH (SQL Server/Postgres/DB2/MariaDB). Oracle's syntax differs and older
      // versions can't restart, so it opts out via the hook — without this clause a
      // start-value difference (e.g. 1 vs 1000) never converges after a deploy.
      if (s.start !== undefined) {
        alter += dialect.alterSequenceRestart?.(s.start) ?? ` RESTART WITH ${s.start}`;
      }
      if (s.increment !== undefined) alter += ` INCREMENT BY ${s.increment}`;
      if (s.minValue !== undefined) alter += ` MINVALUE ${s.minValue}`;
      if (s.maxValue !== undefined) alter += ` MAXVALUE ${s.maxValue}`;
      const noAlter = dialect?.unspacedSequenceNoKeywords ? 'NO' : 'NO ';
      alter += s.cycle ? ` CYCLE` : ` ${noAlter}CYCLE`;
      if (s.cache !== undefined) alter += s.cache > 0 ? ` CACHE ${s.cache}` : ` ${noAlter}CACHE`;
      const alterSql = alter + `;`;
      statements.push(dialect.wrapAlterSequence?.(tableName, alterSql) ?? alterSql);
    } else if (obj.objectType === 'TYPE' && obj.sourceTable) {
      statements.push(`DROP TYPE ${tableName};`);
      statements.push(this.renderCreateType({ ...obj.sourceTable, name: tableName }, dialect));
    } else if (obj.objectType === 'MQT' && obj.sourceTable?.definition && dialect.createMaterializedViewStatement) {
      // Materialized views can't be altered in place when their backing query
      // changes — drop and recreate (mirroring the TYPE branch above). Dialects
      // without createMaterializedViewStatement (DB2) fall through to the
      // generic TABLE-shaped handling further down, unchanged from before.
      statements.push(dialect.dropMaterializedViewStatement?.(tableName) ?? `DROP TABLE IF EXISTS ${tableName};`);
      statements.push(dialect.createMaterializedViewStatement(tableName, this.ensureSemicolon(obj.sourceTable.definition)));
      for (const idx of obj.sourceTable.indices) {
        statements.push(this.createIndexSql({ ...idx, name: this.bareName(idx.name) }, tableName, dialect));
      }
    } else if (obj.objectType === 'ROLE') {
      const roleName = this.bareName(obj.tableName);
      // `GRANT ROLE x TO USER y` is Db2's shape and a syntax error on
      // PostgreSQL, MySQL, MariaDB and Oracle, which take the SQL standard
      // `GRANT x TO y`. SQL Server has no GRANT form for membership at all.
      // The hook picks; the fallback is the standard.
      const membership = (member: string, memberType: string, action: 'grant' | 'revoke'): string =>
        dialect.roleMemberStatement?.(roleName, member, memberType, action) ??
        (action === 'grant'
          ? `GRANT ${roleName} TO ${member};`
          : `REVOKE ${roleName} FROM ${member};`);

      for (const m of obj.columnDiffs) {
        if (m.status === 'ADDED' && m.source) {
          statements.push(membership(m.name, m.source.type, 'grant'));
        } else if (m.status === 'REMOVED' && m.target) {
          statements.push(membership(m.name, m.target.type, 'revoke'));
        }
      }
    } else if (PROCEDURAL_TYPES.has(obj.objectType) && this.isCrossDialect(mapping)) {
      statements.push(...this.manualReviewBlock(obj, mapping));
    } else if (obj.definition) {
      const src = obj.sourceTable;
      if (obj.objectType === 'VIEW') {
        const body = this.ensureSemicolon(obj.definition);
        if (dialect.alterViewStatement) {
          // SQL Server: ALTER VIEW replaces in place without a prior DROP.
          statements.push(dialect.alterViewStatement(tableName, body));
        } else {
          // All other dialects support CREATE OR REPLACE VIEW which handles
          // replacement atomically — no prior DROP needed.
          statements.push(`CREATE OR REPLACE VIEW ${tableName} AS\n${body}`);
        }
      } else {
        // Dialect hook takes precedence (Oracle/DB2 version-aware exception blocks);
        // fall back to the generic drop, same pattern as the DROP phase above.
        const ver = mapping?.targetServerVersion;
        if (obj.objectType === 'FUNCTION') {
          statements.push(dialect.dropFunctionStatement?.(tableName, ver) ?? this.dropRoutineSql('FUNCTION', tableName, dialect, src?.parameters));
        } else if (obj.objectType === 'PROCEDURE') {
          statements.push(dialect.dropProcedureStatement?.(tableName, ver) ?? this.dropRoutineSql('PROCEDURE', tableName, dialect, src?.parameters));
        } else if (obj.objectType === 'TRIGGER') {
          statements.push(`DROP TRIGGER IF EXISTS ${tableName};`);
        }
        statements.push(this.ensureSemicolon(obj.definition));
      }
    }

    return statements;
  }

  /**
   * Sort newly-added TABLE objects in FK dependency order so referenced tables are
   * always created before the tables that reference them. Non-TABLE objects (views,
   * procedures, etc.) are appended after all tables.
   *
   * Uses Kahn's algorithm; if a cycle remains, those tables are appended with a
   * `-- review:` notice on the first table in the residual set.
   */
  private sortAddedByDependency(added: TableDiff[]): TableDiff[] {
    const tables = added.filter((o) => o.objectType === 'TABLE');
    const others = added.filter((o) => o.objectType !== 'TABLE');
    if (tables.length === 0) return [...others];

    const byKey = new Map<string, TableDiff>(
      tables.map((t) => [compareKey(t.tableName), t])
    );
    // Edge: child → parent (child depends on parent). Indegree counts parents
    // that must be created first for each child... Kahn wants indegree = number
    // of unmet prerequisites, so we model edges parent→child (parent before child).
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // parent → children
    for (const key of byKey.keys()) {
      indegree.set(key, 0);
      dependents.set(key, []);
    }
    for (const obj of tables) {
      const child = compareKey(obj.tableName);
      for (const fk of obj.sourceTable?.foreignKeys ?? []) {
        const parent = compareKey(fk.referencedTable);
        if (!byKey.has(parent) || parent === child) continue;
        dependents.get(parent)!.push(child);
        indegree.set(child, (indegree.get(child) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [key, deg] of indegree) {
      if (deg === 0) queue.push(key);
    }
    queue.sort(); // stable-ish for tests

    const result: TableDiff[] = [];
    const placed = new Set<string>();
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (placed.has(key)) continue;
      placed.add(key);
      const obj = byKey.get(key);
      if (obj) result.push(obj);
      for (const child of dependents.get(key) ?? []) {
        const next = (indegree.get(child) ?? 1) - 1;
        indegree.set(child, next);
        if (next === 0) queue.push(child);
      }
    }

    // Residual cycle — append remaining tables; createObjectStatements emits review.
    const residual = tables.filter((t) => !placed.has(compareKey(t.tableName)));
    this.fkCycleKeys = new Set(residual.map((t) => compareKey(t.tableName)));
    result.push(...residual);

    return [...result, ...others];
  }

  // For DROP ordering: if A has an FK to B, A must be dropped before B.
  // This is the reverse of ADD ordering (where B is created before A).
  // We run the same DFS as sortAddedByDependency against targetTable FKs, then reverse.
  private sortRemovedByDependency(removed: TableDiff[]): TableDiff[] {
    const tables    = removed.filter((o) => o.objectType === 'TABLE');
    const sequences = removed.filter((o) => o.objectType === 'SEQUENCE');
    const types     = removed.filter((o) => o.objectType === 'TYPE');
    // Views, functions, procedures, triggers — reference tables but don't own them.
    const others    = removed.filter((o) => !['TABLE', 'SEQUENCE', 'TYPE'].includes(o.objectType));

    const byKey = new Map<string, TableDiff>(
      tables.map((t) => [t.tableName.toUpperCase(), t])
    );
    const visited = new Set<string>();
    const addOrder: TableDiff[] = [];

    const visit = (obj: TableDiff) => {
      const key = obj.tableName.toUpperCase();
      if (visited.has(key)) return;
      visited.add(key);
      for (const fk of obj.targetTable?.foreignKeys ?? []) {
        const refKey = compareKey(fk.referencedTable);
        const dep = byKey.get(refKey);
        if (dep) visit(dep);
      }
      addOrder.push(obj);
    };

    for (const t of tables) visit(t);

    // Drop order:
    // 1. Views / routines / triggers first (they reference tables but don't own anything)
    // 2. Tables in FK-safe order (dropping a table auto-drops its owned sequences in Postgres)
    // 3. Sequences last — IF EXISTS is a no-op when already dropped by a table drop
    // 4. Types last — columns that reference them are gone after the table drops above
    return [...others, ...addOrder.reverse(), ...sequences, ...types];
  }

  /** Build a CREATE step for an ADDED procedural object (routine, view, or trigger). */
  private createProceduralStep(obj: TableDiff, dialect: SqlDialect, m: SchemaMapping): MigrationStep {
    const stmts = this.createObjectStatements(obj, dialect, m);
    const noDefRoutine =
      stmts.length === 0 &&
      !obj.definition &&
      !this.isCrossDialect(m);
    return {
      objectName: flattenIdentifier(obj.tableName),
      objectType: obj.objectType,
      action: 'CREATE',
      statements: stmts,
      ...(noDefRoutine ? { skipped: `No definition available — grant SHOW_ROUTINE privilege and re-compare` } : {}),
    };
  }

  /**
   * Why this engine cannot be migrated to, or null when it can.
   *
   * `resolveDialect` answers Db2 for a name it does not know, and both entry
   * points below call it. Nothing errored: a Redis target produced a script
   * headed `-- Dialect: REDIS` whose body was Db2 DDL — labelled correctly
   * while being wrong, which is the worst version of this failure.
   *
   * The UI and the compare service already refuse earlier. This is the layer
   * that cannot be bypassed by a stale selection or a caller nobody has
   * written yet, because it sits on the two functions that actually produce
   * statements.
   */
  private migrationRefusal(dialectStr: string): string | null {
    if (tryResolveDialect(dialectStr)) return null;
    return (
      `Fox Schema has no SQL dialect for "${dialectStr || 'this engine'}", so it cannot ` +
      'generate a migration for it. Nothing here is safe to run against that target.'
    );
  }

  generateMigrationPlan(
    diffs: TableDiff[],
    dialectStr: string,
    mapping?: SchemaMapping,
    /**
     * Full compare result (including UNCHANGED / unselected objects). Used only to
     * discover target views that depend on tables being altered when the dialect
     * has no runtime dependent-view guard. Defaults to `diffs`.
     */
    contextDiffs?: TableDiff[]
  ): MigrationStep[] {
    // An empty plan rather than a throw: this runs inside a render path, and a
    // migration that does nothing is the safe failure. The preview below says
    // why, in the place the reader is already looking.
    if (this.migrationRefusal(dialectStr)) return [];
    const dialect = resolveDialect(dialectStr);
    this.quoteIdentifier = dialect.quoteIdentifier ?? ansiQuoteIdentifier;
    this.dialectName = dialectStr;
    // Pin the target dialect into the mapping so the render helpers can detect a
    // cross-dialect migration and translate column types accordingly.
    const m: SchemaMapping = { ...mapping, targetDialect: mapping?.targetDialect ?? dialectStr };
    const steps: MigrationStep[] = [];
    const depContext = contextDiffs ?? diffs;
    
    // Non-destructive mode never drops objects that exist only in the target.
    if (!m.nonDestructive) {
      for (const obj of this.sortRemovedByDependency(diffs.filter((d) => d.status === 'REMOVED'))) {
        steps.push({ objectName: flattenIdentifier(obj.tableName), objectType: obj.objectType, action: 'DROP', statements: this.dropObjectStatements(obj, m, dialect) });
      }
    }

    // Structural ADDED objects (TABLE, SEQUENCE, TYPE, ROLE) come before MODIFIED so
    // that new tables can be referenced by FK constraints added in ALTER steps.
    const addedStructural = diffs.filter((d) => d.status === 'ADDED' && !PROCEDURAL_TYPES.has(d.objectType));
    // Sequences, types and roles ahead of tables. `sortAddedByDependency` only
    // knows about foreign keys, so a table whose column default calls a
    // sequence (`DEFAULT order_seq.NEXTVAL`) was created before the sequence
    // existed — ORA-02289 on Oracle, which then took out every view over that
    // table. None of these can depend on a table, so first is always safe.
    const supporting = addedStructural.filter((d) => d.objectType !== 'TABLE' && d.objectType !== 'MQT');
    const tables = addedStructural.filter((d) => d.objectType === 'TABLE' || d.objectType === 'MQT');
    for (const obj of [...supporting, ...this.sortAddedByDependency(tables)]) {
      const stmts = this.createObjectStatements(obj, dialect, m);
      steps.push({ objectName: flattenIdentifier(obj.tableName), objectType: obj.objectType, action: 'CREATE', statements: stmts });
    }

    // ADDED routines (FUNCTION, PROCEDURE) come before MODIFIED — a MODIFIED table's
    // ALTER step can add a new TRIGGER that calls a newly-added function, so the
    // function must already exist by then. See ROUTINE_TYPES comment.
    const addedRoutines = diffs.filter((d) => d.status === 'ADDED' && ROUTINE_TYPES.has(d.objectType));
    for (const obj of this.sortAddedByDependency(addedRoutines)) {
      steps.push(this.createProceduralStep(obj, dialect, m));
    }

    // MODIFIED (ALTER TABLE, etc.) — must run before ADDED views/triggers so that
    // views referencing newly-added columns see them when created.
    const selectedKeys = new Set(diffs.map(selectionKey));
    for (const obj of diffs.filter((d) => d.status === 'MODIFIED')) {
      steps.push({
        objectName: flattenIdentifier(obj.tableName),
        objectType: obj.objectType,
        action: 'ALTER',
        statements: this.alterObjectStatements(obj, dialect, m, depContext, selectedKeys),
      });
    }

    // ADDED views/triggers come last so they can reference columns and tables that
    // were added/modified in the steps above (and, for triggers, routines created
    // just before the ALTER phase above).
    const addedViewsAndTriggers = diffs.filter((d) => d.status === 'ADDED' && PROCEDURAL_TYPES.has(d.objectType) && !ROUTINE_TYPES.has(d.objectType));
    for (const obj of this.sortAddedByDependency(addedViewsAndTriggers)) {
      steps.push(this.createProceduralStep(obj, dialect, m));
    }

    // Collect MODIFIED objects whose statements were entirely skipped (all changes
    // were removals, suppressed by non-destructive mode). Callers can surface these
    // as informational notes rather than silently hiding them.
    const skippedInNonDestructive: string[] = m.nonDestructive
      ? steps.filter((s) => s.action === 'ALTER' && s.statements.length === 0).map((s) => s.objectName)
      : [];

    const actionable = steps
      .filter((s) => s.statements.length > 0)
      .map((s) => ({
        ...s,
        statements: s.statements.map((st) => keepCommentCommented(this.remapSchema(st, m))),
      }));

    // Attach skipped list so generateMigrationSql can report it.
    (actionable as any).__skipped = skippedInNonDestructive;
    return actionable;
  }

  generateMigrationSql(
    diffs: TableDiff[],
    dialectStr: string,
    mapping?: SchemaMapping,
    contextDiffs?: TableDiff[]
  ): string {
    const refused = this.migrationRefusal(dialectStr);
    if (refused) {
      // Comments only. There is nothing to copy into a terminal and nothing
      // for an execute path to split into statements.
      return (
        `-- =========================================================================\n` +
        `-- Fox Generated Migration Script\n` +
        `-- =========================================================================\n` +
        `-- ${refused}\n`
      );
    }
    let sql = `-- =========================================================================\n`;
    sql += `-- Fox Generated Migration Script\n`;
    sql += `-- Dialect: ${dialectStr.toUpperCase()}\n`;
    if (mapping?.sourceSchema) {
      sql += `-- Source Schema: ${mapping.sourceSchema.toUpperCase()}\n`;
    }
    if (mapping?.targetSchema) {
      sql += `-- Target Schema: ${mapping.targetSchema.toUpperCase()}\n`;
    }
    const crossDialect = this.isCrossDialect({ ...mapping, targetDialect: mapping?.targetDialect ?? dialectStr });
    if (crossDialect) {
      sql += `-- Cross-dialect: ${(mapping?.sourceDialect ?? '').toUpperCase()} -> ${dialectStr.toUpperCase()}\n`;
      sql += `-- Column types were translated; review any '-- review:' notes and MANUAL REVIEW blocks below.\n`;
    }
    if (mapping?.nonDestructive) {
      sql += `-- Non-destructive mode: ADD/MODIFY only — nothing in the target is dropped.\n`;
    }
    sql += `-- Created At: ${new Date().toISOString()}\n`;
    sql += `-- =========================================================================\n\n`;

    const steps = this.generateMigrationPlan(diffs, dialectStr, mapping, contextDiffs);
    const skipped: string[] = (steps as any).__skipped ?? [];

    if (steps.length === 0) {
      if (skipped.length > 0) {
        // Objects were selected but all their changes were removals — suppressed by non-destructive mode.
        sql += `-- Nothing to apply: every selected change is a removal and non-destructive mode is ON.\n`;
        sql += `-- The following objects have target-only columns / indexes / constraints that won't be dropped:\n`;
        for (const name of skipped) sql += `--   ${name}\n`;
        sql += `--\n-- To remove these differences: disable non-destructive mode and re-run.`;
        return sql;
      }
      return sql + `-- No schema changes detected. Target database is in sync with source.`;
    }

    const sections: Array<{ action: MigrationStep['action']; title: string }> = [
      { action: 'DROP', title: 'DROP REMOVED OBJECTS' },
      { action: 'CREATE', title: 'CREATE ADDED OBJECTS' },
      { action: 'ALTER', title: 'ALTER MODIFIED OBJECTS' },
    ];

    for (const section of sections) {
      const sectionSteps = steps.filter((s) => s.action === section.action);
      if (sectionSteps.length === 0) continue;

      sql += `-- -------------------------------------------------------------------------\n`;
      sql += `-- ${section.title}\n`;
      sql += `-- -------------------------------------------------------------------------\n`;
      for (const step of sectionSteps) {
        sql += `-- ${step.action} ${step.objectType}: ${step.objectName}\n`;
        sql += step.statements.join('\n') + `\n\n`;
      }
    }

    return sql;
  }
}
