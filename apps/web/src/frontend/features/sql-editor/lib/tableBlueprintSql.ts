import { resolveDialect } from '@/shared/lib/migration-validation';
import type { ColumnInfo, TableSchema } from '@/shared/lib/types';
import {
  dialectSupportsFk,
  dialectFamily,
  dialectSupportsIndex,
  escapeRegExp,
  type CanonicalBase,
  type CanonicalType,
  type IndexFeatureSupport,
  quoteIdentifierIfNeeded,
} from '@foxschema/ui-shared';

/** Quote an identifier when it is not a plain SQL name. */
export function quoteIdent(name: string, dialect: string): string {
  return quoteIdentifierIfNeeded(name, dialect);
}

/**
 * Quote a possibly schema-qualified table ref (`schema.table` → `"schema"."table"`).
 * Never wraps the whole `a.b` string as one identifier.
 */
export function quoteTableRef(name: string, dialect: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed
    .split('.')
    .map((part) => quoteIdent(part.replace(/^["`\[\]]+|["`\[\]]+$/g, ''), dialect))
    .join('.');
}

/** Prefix `schema.` when the name is bare and the dialect uses schemas. */
export function qualifyTableName(
  tableName: string,
  schema: string | undefined,
  dialectName: string
): string {
  const name = tableName.trim();
  if (!name) return name;
  if (name.includes('.')) return name;
  const sch = schema?.trim();
  if (!sch) return name;
  const d = dialectName.toLowerCase();
  if (d === 'sqlite' || d === 'clickhouse') return name;
  return `${sch}.${name}`;
}

/** True when a statement is only a review/comment (not executable DDL). */
export function isReviewOnlySql(stmt: string): boolean {
  const lines = stmt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((l) => l.startsWith('--'));
}

/** Executable statements only (drops pure `-- review:` / comment blocks). */
export function executableSqlStatements(stmts: string[]): string[] {
  return stmts.filter((s) => !isReviewOnlySql(s));
}

/** Qualify then quote a table reference for DDL. */
export function qualifiedQuotedTable(
  tableName: string,
  schema: string | undefined,
  dialectName: string
): string {
  return quoteTableRef(qualifyTableName(tableName, schema, dialectName), dialectName);
}

/**
 * Align referenced columns to local FK columns by name (e.g. `test1_id2` → `id2`),
 * falling back to PK order when counts match.
 */
export function matchFkReferencedColumns(
  localColumns: string[],
  pkColumns: string[],
  refColumnNames: string[]
): string[] {
  if (localColumns.length === 0) return [];
  const pool = pkColumns.length > 0 ? pkColumns : refColumnNames;
  const used = new Set<string>();
  const matched: string[] = [];

  const findHit = (local: string, candidates: string[]): string | undefined => {
    const l = local.toLowerCase();
    const exact = candidates.find((c) => !used.has(c) && c.toLowerCase() === l);
    if (exact) return exact;
    // Suffix match only with an underscore boundary (`test1_id2` → `id2`).
    // Bare endsWith would map `paid` → `id` incorrectly.
    return candidates.find((c) => {
      if (used.has(c)) return false;
      const r = c.toLowerCase();
      return r.length >= 1 && l.endsWith(`_${r}`);
    });
  };

  for (const local of localColumns) {
    const hit =
      findHit(local, pool) ??
      (pkColumns.length > 0 ? findHit(local, refColumnNames) : undefined);
    if (!hit) break;
    used.add(hit);
    matched.push(hit);
  }

  if (matched.length === localColumns.length) return matched;
  if (pkColumns.length === localColumns.length) return [...pkColumns];
  return [];
}

/** Swap a name one step within an ordered list. */
export function moveOrderedName(list: string[], name: string, dir: -1 | 1): string[] {
  const i = list.indexOf(name);
  if (i < 0) return list;
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * Reorder a local FK column and keep `referencedColumns` aligned by index.
 * When lengths already match, both arrays move in lockstep; otherwise
 * `resync` (if provided) rebuilds referenced columns from the new local order.
 */
export function moveFkColumnsLockstep(
  columns: string[],
  referencedColumns: string[],
  name: string,
  dir: -1 | 1,
  resync?: (cols: string[]) => string[]
): { columns: string[]; referencedColumns: string[] } {
  const i = columns.indexOf(name);
  if (i < 0) return { columns, referencedColumns };
  const j = i + dir;
  if (j < 0 || j >= columns.length) return { columns, referencedColumns };

  const nextColumns = moveOrderedName(columns, name, dir);
  if (referencedColumns.length === columns.length) {
    const nextRefs = [...referencedColumns];
    [nextRefs[i], nextRefs[j]] = [nextRefs[j]!, nextRefs[i]!];
    return { columns: nextColumns, referencedColumns: nextRefs };
  }
  if (resync) {
    return { columns: nextColumns, referencedColumns: resync(nextColumns) };
  }
  return { columns: nextColumns, referencedColumns };
}

export type BlueprintColumnOp =
  | { kind: 'add'; column: ColumnInfo }
  | { kind: 'modify'; name: string; previous: ColumnInfo; next: ColumnInfo }
  | { kind: 'drop'; name: string };

function toSpec(c: ColumnInfo) {
  return {
    type: c.type,
    nullable: c.nullable,
    defaultValue: c.defaultValue,
    primaryKey: c.primaryKey,
    identity: c.identity,
    identityGeneration: c.identityGeneration,
    collation: c.collation,
  };
}

/**
 * Auto-increment / identity is only valid on integer (and long/bigint) types.
 * Matches common dialect spellings: int, integer, bigint, long, smallint, serial, …
 * Excludes boolean/bit and decimal with scale.
 */
export function isIntegerAutoIncrementType(type: string): boolean {
  if (isBooleanBitType(type)) return false;
  const t = type.trim().toLowerCase();
  if (!t) return false;
  const base = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Integers / longs only — not decimal, numeric, boolean, or floats
  return (
    /^(tiny|small|medium|big)?int\d*$/.test(base) ||
    base === 'integer' ||
    base === 'bigint' ||
    base === 'long' ||
    base === 'longint' ||
    base === 'int2' ||
    base === 'int4' ||
    base === 'int8' ||
    base === 'serial' ||
    base === 'bigserial' ||
    base === 'smallserial'
  );
}

/** Boolean / bit family (defaults are dialect-specific literals). */
export function isBooleanBitType(type: string): boolean {
  const t = type.trim().toLowerCase();
  const base = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (base === 'boolean' || base === 'bool' || base === 'bit') return true;
  // MySQL conventional boolean
  if (base === 'tinyint' && /\(\s*1\s*\)/.test(t)) return true;
  return false;
}

export type ColumnTypeKind =
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'text'
  | 'datetime'
  | 'binary'
  | 'other';

/** Classify a native type string for coloring / editors. */
export function classifyColumnType(type: string): ColumnTypeKind {
  if (isBooleanBitType(type)) return 'boolean';
  if (isIntegerAutoIncrementType(type)) return 'integer';
  const t = type.trim().toLowerCase();
  const base = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (
    base === 'decimal' ||
    base === 'numeric' ||
    base === 'number' ||
    base === 'money' ||
    base === 'smallmoney' ||
    base === 'real' ||
    base === 'float' ||
    base === 'double' ||
    base === 'double precision' ||
    base === 'float4' ||
    base === 'float8'
  ) {
    return 'decimal';
  }
  if (
    base === 'date' ||
    base === 'time' ||
    base === 'timestamp' ||
    base === 'timestamptz' ||
    base === 'datetime' ||
    base === 'datetime2' ||
    base === 'smalldatetime' ||
    base === 'datetimeoffset' ||
    base.includes('timestamp') ||
    base.includes('time')
  ) {
    return 'datetime';
  }
  if (
    base === 'char' ||
    base === 'nchar' ||
    base === 'varchar' ||
    base === 'nvarchar' ||
    base === 'character' ||
    base === 'character varying' ||
    base === 'text' ||
    base === 'ntext' ||
    base === 'clob' ||
    base === 'bpchar' ||
    base.endsWith('text')
  ) {
    return 'text';
  }
  if (
    base === 'binary' ||
    base === 'varbinary' ||
    base === 'blob' ||
    base === 'bytea' ||
    base === 'image' ||
    base.endsWith('blob')
  ) {
    return 'binary';
  }
  return 'other';
}

/** Tailwind classes for type-kind badges / row accents. */
export function columnTypeKindClasses(kind: ColumnTypeKind): {
  badge: string;
  bar: string;
  label: string;
} {
  switch (kind) {
    case 'integer':
      return {
        badge: 'bg-sky-950/50 text-sky-300 border-sky-500/40',
        bar: 'border-sky-500',
        label: 'Integer',
      };
    case 'decimal':
      return {
        badge: 'bg-cyan-950/50 text-cyan-300 border-cyan-500/40',
        bar: 'border-cyan-500',
        label: 'Decimal',
      };
    case 'boolean':
      return {
        badge: 'bg-emerald-950/50 text-emerald-300 border-emerald-500/40',
        bar: 'border-emerald-500',
        label: 'Boolean',
      };
    case 'text':
      return {
        badge: 'bg-amber-950/50 text-amber-200 border-amber-500/40',
        bar: 'border-amber-500',
        label: 'Text',
      };
    case 'datetime':
      return {
        badge: 'bg-violet-950/50 text-violet-300 border-violet-500/40',
        bar: 'border-violet-500',
        label: 'Date/time',
      };
    case 'binary':
      return {
        badge: 'bg-rose-950/50 text-rose-300 border-rose-500/40',
        bar: 'border-rose-500',
        label: 'Binary',
      };
    default:
      return {
        badge: 'bg-slate-800 text-slate-400 border-slate-600',
        bar: 'border-slate-500',
        label: 'Other',
      };
  }
}

export type TypeSizeShape =
  | { kind: 'none' }
  | { kind: 'length'; length: number | undefined }
  | { kind: 'decimal'; precision: number | undefined; scale: number | undefined };

/** Parse length or precision/scale from a type string. */
export function parseTypeSize(type: string): TypeSizeShape {
  const kind = classifyColumnType(type);
  const m = type.match(/\(\s*([^)]+)\s*\)/);
  if (kind === 'text' || kind === 'binary') {
    if (!m) return { kind: 'length', length: undefined };
    if (/^max$/i.test(m[1].trim())) return { kind: 'length', length: undefined };
    const n = Number(m[1].trim());
    return { kind: 'length', length: Number.isFinite(n) ? n : undefined };
  }
  if (kind === 'decimal') {
    if (!m) return { kind: 'decimal', precision: undefined, scale: undefined };
    const parts = m[1].split(',').map((p) => p.trim());
    const precision = parts[0] && !Number.isNaN(Number(parts[0])) ? Number(parts[0]) : undefined;
    const scale =
      parts[1] !== undefined && !Number.isNaN(Number(parts[1])) ? Number(parts[1]) : undefined;
    return { kind: 'decimal', precision, scale };
  }
  return { kind: 'none' };
}

/** Rebuild type string with new length or precision/scale. */
export function applyTypeSize(
  type: string,
  size: { length?: number; precision?: number; scale?: number }
): string {
  const base = type.replace(/\s*\([^)]*\)\s*$/, '').trim() || type.trim();
  const shape = parseTypeSize(type);
  if (shape.kind === 'length') {
    if (size.length === undefined || size.length <= 0) return base;
    return `${base}(${Math.floor(size.length)})`;
  }
  if (shape.kind === 'decimal') {
    const p = size.precision;
    if (p === undefined || p <= 0) return base;
    if (size.scale === undefined) return `${base}(${Math.floor(p)})`;
    return `${base}(${Math.floor(p)},${Math.floor(size.scale)})`;
  }
  return type;
}

export type BooleanDefaultOption = { value: string; label: string };

/**
 * Dialect-appropriate default literals for boolean / bit columns.
 * Empty string in UI = no DEFAULT clause.
 */
export function dialectBooleanDefaultOptions(dialectName: string): BooleanDefaultOption[] {
  const d = dialectName.toLowerCase();
  if (d === 'postgres' || d === 'cockroachdb' || d === 'yugabytedb') {
    return [
      { value: '', label: '(none)' },
      { value: 'TRUE', label: 'TRUE' },
      { value: 'FALSE', label: 'FALSE' },
      { value: 'NULL', label: 'NULL' },
    ];
  }
  if (dialectFamily(d) === 'mysql') {
    return [
      { value: '', label: '(none)' },
      { value: '1', label: '1 (true)' },
      { value: '0', label: '0 (false)' },
      { value: 'TRUE', label: 'TRUE' },
      { value: 'FALSE', label: 'FALSE' },
      { value: 'NULL', label: 'NULL' },
    ];
  }
  if (d === 'sqlserver' || d === 'azuresql' || d === 'sqlite') {
    return [
      { value: '', label: '(none)' },
      { value: '1', label: '1' },
      { value: '0', label: '0' },
      { value: 'NULL', label: 'NULL' },
    ];
  }
  if (d === 'oracle' || d === 'db2') {
    // Often NUMBER(1) / SMALLINT stand-ins; still offer 1/0 and NULL
    return [
      { value: '', label: '(none)' },
      { value: '1', label: '1' },
      { value: '0', label: '0' },
      { value: 'NULL', label: 'NULL' },
    ];
  }
  return [
    { value: '', label: '(none)' },
    { value: 'TRUE', label: 'TRUE' },
    { value: 'FALSE', label: 'FALSE' },
    { value: '1', label: '1' },
    { value: '0', label: '0' },
    { value: 'NULL', label: 'NULL' },
  ];
}

/** Column-level constraints this dialect can emit in CREATE / ADD. */
export function dialectColumnConstraints(dialectName: string): {
  notNull: boolean;
  unique: boolean;
  hint: string;
} {
  const d = dialectName.toLowerCase();
  if (d === 'clickhouse') {
    return {
      notNull: true,
      unique: false,
      hint: 'ClickHouse: nullability is type-level (Nullable); no column UNIQUE.',
    };
  }
  return {
    notNull: true,
    unique: true,
    hint: 'NOT NULL and UNIQUE are supported as column constraints.',
  };
}

/** Apply identity only when the column type allows it. */
export function withAutoIncrement(
  column: ColumnInfo,
  enabled: boolean
): ColumnInfo {
  if (!enabled) {
    return { ...column, identity: false, identityGeneration: undefined };
  }
  if (!isIntegerAutoIncrementType(column.type)) {
    return { ...column, identity: false, identityGeneration: undefined };
  }
  return {
    ...column,
    identity: true,
    nullable: false,
    identityGeneration: column.identityGeneration ?? 'ALWAYS',
  };
}

/** Dialect-specific identity / auto-increment UI + clause preview. */
export type IdentitySupport = {
  supported: boolean;
  /** Short label for the checkbox */
  label: string;
  /** GENERATED … options (Postgres / Oracle / DB2 / Yugabyte / Cockroach) */
  generations?: Array<'ALWAYS' | 'BY DEFAULT'>;
  hint: string;
  /** Clause fragment shown next to the control */
  clauseHint: string;
};

export function dialectIdentitySupport(dialectName: string): IdentitySupport {
  const d = dialectName.toLowerCase();
  if (dialectFamily(d) === 'mysql') {
    return {
      supported: true,
      label: 'Auto increment',
      clauseHint: 'AUTO_INCREMENT',
      hint: 'Only for int / integer / bigint / long types; usually also the primary key.',
    };
  }
  if (dialectFamily(d) === 'sqlserver') {
    return {
      supported: true,
      label: 'Auto increment',
      clauseHint: 'IDENTITY(1,1)',
      hint: 'Only for int / bigint / long. SQL Server IDENTITY(1,1).',
    };
  }
  if (d === 'redshift') {
    return {
      supported: true,
      label: 'Auto increment',
      clauseHint: 'IDENTITY(0,1)',
      hint: 'Redshift identity column.',
    };
  }
  if (
    d === 'postgres' ||
    d === 'cockroachdb' ||
    d === 'yugabytedb' ||
    d === 'oracle' ||
    d === 'db2'
  ) {
    return {
      supported: true,
      label: 'Auto increment',
      clauseHint: 'GENERATED … AS IDENTITY',
      generations: ['ALWAYS', 'BY DEFAULT'],
      hint: 'Only for int / bigint / long. GENERATED ALWAYS or BY DEFAULT AS IDENTITY.',
    };
  }
  if (d === 'sqlite') {
    return {
      supported: true,
      label: 'Auto increment',
      clauseHint: 'AUTOINCREMENT',
      hint: 'Only for INTEGER. SQLite PRIMARY KEY AUTOINCREMENT.',
    };
  }
  return {
    supported: true,
    label: 'Auto increment',
    clauseHint: resolveDialect(dialectName).identityClause({ type: 'integer', nullable: false, identity: true }) || 'identity',
    hint: 'Toggles the dialect identity clause in generated SQL.',
  };
}

/** Canonical templates rendered through each dialect's `renderType` for the dropdown. */
const TYPE_TEMPLATES: CanonicalType[] = [
  { base: 'boolean', raw: 'boolean' },
  { base: 'smallint', raw: 'smallint' },
  { base: 'integer', raw: 'integer' },
  { base: 'bigint', raw: 'bigint' },
  { base: 'decimal', raw: 'decimal', precision: 10, scale: 2 },
  { base: 'decimal', raw: 'decimal', precision: 18, scale: 0 },
  { base: 'real', raw: 'real' },
  { base: 'double', raw: 'double' },
  { base: 'char', raw: 'char', length: 1 },
  { base: 'varchar', raw: 'varchar', length: 50 },
  { base: 'varchar', raw: 'varchar', length: 255 },
  { base: 'varchar', raw: 'varchar', length: 1000 },
  { base: 'text', raw: 'text' },
  { base: 'binary', raw: 'binary', length: 16 },
  { base: 'varbinary', raw: 'varbinary', length: 255 },
  { base: 'blob', raw: 'blob' },
  { base: 'date', raw: 'date' },
  { base: 'time', raw: 'time' },
  { base: 'timestamp', raw: 'timestamp' },
  { base: 'timestamptz', raw: 'timestamptz' },
  { base: 'uuid', raw: 'uuid' },
  { base: 'json', raw: 'json' },
  { base: 'xml', raw: 'xml' },
];

const TYPE_GROUP: Partial<Record<CanonicalBase, string>> = {
  boolean: 'Numeric / boolean',
  smallint: 'Numeric / boolean',
  integer: 'Numeric / boolean',
  bigint: 'Numeric / boolean',
  decimal: 'Numeric / boolean',
  real: 'Numeric / boolean',
  double: 'Numeric / boolean',
  char: 'Text',
  varchar: 'Text',
  text: 'Text',
  binary: 'Binary',
  varbinary: 'Binary',
  blob: 'Binary',
  date: 'Date / time',
  time: 'Date / time',
  timestamp: 'Date / time',
  timestamptz: 'Date / time',
  uuid: 'Other',
  json: 'Other',
  xml: 'Other',
};

export type DialectDataTypeOption = {
  value: string;
  label: string;
  group: string;
  kind: ColumnTypeKind;
  /** True when this type can take auto-increment. */
  integerLike: boolean;
};

/**
 * Dialect-native data types for blueprint dropdowns, derived from each dialect's
 * `renderType` map (so Postgres gets `integer`/`varchar`, MySQL `int`/`varchar(255)`, etc.).
 */
export function listDialectDataTypes(dialectName: string): DialectDataTypeOption[] {
  const dialect = resolveDialect(dialectName);
  const seen = new Set<string>();
  const out: DialectDataTypeOption[] = [];

  for (const tmpl of TYPE_TEMPLATES) {
    const rendered = dialect.renderType(tmpl);
    const value = (rendered.sql || '').trim();
    if (!value) continue;
    // Skip "left as-is" unknowns that didn't map.
    if (rendered.warning && /no .+ equivalent/i.test(rendered.warning) && value === tmpl.raw) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      value,
      label: value,
      group: TYPE_GROUP[tmpl.base] ?? 'Other',
      kind: classifyColumnType(value),
      integerLike: isIntegerAutoIncrementType(value),
    });
  }

  // Prefer integer-like types first within each group for create UX.
  const groupOrder = ['Numeric / boolean', 'Text', 'Binary', 'Date / time', 'Other'];
  out.sort((a, b) => {
    const gi = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
    if (gi !== 0) return gi;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/** Default column type for a new column in this dialect (varchar(255) or closest). */
export function defaultDialectColumnType(dialectName: string): string {
  const types = listDialectDataTypes(dialectName);
  const varchar =
    types.find((t) => /^varchar\(255\)$/i.test(t.value)) ||
    types.find((t) => /^varchar/i.test(t.value)) ||
    types.find((t) => t.group === 'Text');
  return varchar?.value ?? 'varchar(255)';
}

/** Build `name type [identity] [COLLATE …] [DEFAULT …] [NOT NULL] [UNIQUE]` for ADD / CREATE. */
export function buildColumnDef(
  column: ColumnInfo & { unique?: boolean },
  dialectName: string
): string {
  const dialect = resolveDialect(dialectName);
  const name = quoteIdent(column.name, dialectName);
  const d = dialectName.toLowerCase();
  const identityOk = !!column.identity && isIntegerAutoIncrementType(column.type);
  const spec = { ...toSpec(column), identity: identityOk };
  let typeSql: string;
  if (dialect.nullableTypeWrapper) {
    typeSql = dialect.nullableTypeWrapper(column.type, column.nullable);
  } else if (d === 'sqlite' && identityOk) {
    typeSql = column.type;
  } else {
    typeSql = column.type + dialect.identityClause(spec);
  }
  let def = `${name} ${typeSql}`;
  if (column.collation) {
    def += dialect.columnCollateClause?.(column.collation) ?? ` COLLATE ${column.collation}`;
  }
  if (!dialect.nullableTypeWrapper) {
    if (column.defaultValue) {
      const defVal = column.defaultValue.trim().toUpperCase() === 'NULL' ? 'NULL' : column.defaultValue;
      def += ` DEFAULT ${defVal}`;
    }
    if (!column.nullable) def += ` NOT NULL`;
  }
  if (column.unique && dialectColumnConstraints(dialectName).unique) {
    def += ` UNIQUE`;
  }
  // SQLite AUTOINCREMENT is only valid as `INTEGER PRIMARY KEY AUTOINCREMENT`
  // (handled in createTableBody). Do not append a bare AUTOINCREMENT here.
  return def;
}

function columnCoreChanged(a: ColumnInfo, b: ColumnInfo): boolean {
  return (
    a.type !== b.type ||
    a.nullable !== b.nullable ||
    !!a.identity !== !!b.identity ||
    (a.identityGeneration ?? '') !== (b.identityGeneration ?? '') ||
    (a.collation ?? '') !== (b.collation ?? '')
  );
}

function defaultChanged(a: ColumnInfo, b: ColumnInfo): boolean {
  return (a.defaultValue ?? '') !== (b.defaultValue ?? '');
}

export function pkColumnsFromTable(table: TableSchema): string[] {
  if (table.primaryKey?.columns?.length) return [...table.primaryKey.columns];
  return (table.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name);
}

export function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * DROP + ADD PRIMARY KEY when the column set (or order) changes.
 * Supports single and composite keys.
 */
export function generatePkAlterSql(
  tableName: string,
  dialectName: string,
  previous: string[],
  next: string[],
  pkName?: string,
  schema?: string
): string[] {
  if (sameStringList(previous, next)) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(tableName, schema, dialectName);
  const stmts: string[] = [];
  if (previous.length > 0) {
    const qPk =
      pkName && pkName.toUpperCase() !== 'PRIMARY'
        ? quoteIdent(pkName, dialectName)
        : pkName;
    stmts.push(...dialect.dropPrimaryKeyStatements(qTable, qPk));
  }
  if (next.length > 0) {
    const cols = next.map((c) => quoteIdent(c, dialectName)).join(', ');
    const constraint =
      pkName && pkName.toUpperCase() !== 'PRIMARY'
        ? `CONSTRAINT ${quoteIdent(pkName, dialectName)} `
        : '';
    stmts.push(`ALTER TABLE ${qTable} ADD ${constraint}PRIMARY KEY (${cols});`);
  }
  return stmts;
}

/**
 * Generate same-dialect ALTER statements for pending blueprint column ops.
 * Order: drops, modifies, adds.
 */
export function generateBlueprintAlterSql(
  tableName: string,
  dialectName: string,
  ops: BlueprintColumnOp[],
  schema?: string
): string[] {
  if (ops.length === 0) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(tableName, schema, dialectName);
  const stmts: string[] = [];

  for (const op of ops) {
    if (op.kind !== 'drop') continue;
    stmts.push(dialect.dropColumnStatement(qTable, quoteIdent(op.name, dialectName)));
  }

  for (const op of ops) {
    if (op.kind !== 'modify') continue;
    const qName = quoteIdent(op.name, dialectName);
    const core = columnCoreChanged(op.previous, op.next);
    const def = defaultChanged(op.previous, op.next);
    if (core) {
      stmts.push(
        ...dialect.modifyColumnStatements(qTable, qName, toSpec(op.next), op.previous.nullable)
      );
      if (op.next.defaultValue) {
        stmts.push(...dialect.setDefaultStatements(qTable, qName, op.next.defaultValue));
      } else if (op.previous.defaultValue) {
        stmts.push(...dialect.setDefaultStatements(qTable, qName, undefined));
      }
    } else if (def) {
      stmts.push(...dialect.setDefaultStatements(qTable, qName, op.next.defaultValue));
    }
  }

  for (const op of ops) {
    if (op.kind !== 'add') continue;
    stmts.push(dialect.addColumnStatement(qTable, buildColumnDef(op.column, dialectName)));
  }

  return stmts;
}

/** Diff original columns vs draft to produce pending ops (excludes unchanged). */
export function diffBlueprintColumns(
  original: ColumnInfo[],
  draft: ColumnInfo[],
  droppedNames: Set<string>
): BlueprintColumnOp[] {
  const ops: BlueprintColumnOp[] = [];
  const origByName = new Map(original.map((c) => [c.name, c]));
  const draftNames = new Set(draft.map((c) => c.name));

  for (const name of droppedNames) {
    if (origByName.has(name)) ops.push({ kind: 'drop', name });
  }

  for (const col of draft) {
    const prev = origByName.get(col.name);
    if (!prev) {
      if (!droppedNames.has(col.name)) ops.push({ kind: 'add', column: col });
      continue;
    }
    if (droppedNames.has(col.name)) continue;
    if (columnCoreChanged(prev, col) || defaultChanged(prev, col)) {
      ops.push({ kind: 'modify', name: col.name, previous: prev, next: col });
    }
  }

  for (const prev of original) {
    if (!draftNames.has(prev.name) && !droppedNames.has(prev.name)) {
      ops.push({ kind: 'drop', name: prev.name });
    }
  }

  return ops;
}

function createTableBody(
  columns: ColumnInfo[],
  pkColumns: string[],
  dialectName: string,
  pkName?: string,
  foreignKeys?: BlueprintFkDraft[],
  schema?: string
): string {
  const d = dialectName.toLowerCase();
  const sqliteIdentityPkCol =
    d === 'sqlite' && pkColumns.length === 1
      ? columns.find(
          (c) =>
            c.name === pkColumns[0] &&
            !!c.identity &&
            isIntegerAutoIncrementType(c.type)
        )
      : undefined;

  const lines = columns.map((c) => {
    if (sqliteIdentityPkCol && c.name === sqliteIdentityPkCol.name) {
      // SQLite requires AUTOINCREMENT on the column PRIMARY KEY, not a table PK.
      return `  ${quoteIdent(c.name, dialectName)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
    return `  ${buildColumnDef(c, dialectName)}`;
  });
  if (pkColumns.length > 0 && !sqliteIdentityPkCol) {
    const cols = pkColumns.map((c) => quoteIdent(c, dialectName)).join(', ');
    const constraint =
      pkName && pkName.toUpperCase() !== 'PRIMARY'
        ? `CONSTRAINT ${quoteIdent(pkName, dialectName)} `
        : '';
    lines.push(`  ${constraint}PRIMARY KEY (${cols})`);
  }
  for (const fk of foreignKeys ?? []) {
    const line = formatForeignKeyConstraintLine(fk, dialectName, schema);
    if (line) lines.push(`  ${line}`);
  }
  return `(\n${lines.join(',\n')}\n)`;
}

/**
 * CREATE TABLE with existence guard (IF NOT EXISTS or dialect equivalent).
 * Optional `foreignKeys` are inlined when the dialect supports CREATE-table FKs
 * (required for SQLite, which cannot ALTER ADD CONSTRAINT).
 */
export function generateCreateTableSql(
  tableName: string,
  columns: ColumnInfo[],
  pkColumns: string[],
  dialectName: string,
  pkName?: string,
  foreignKeys?: BlueprintFkDraft[],
  schema?: string,
  opts?: { ifNotExists?: boolean }
): string[] {
  const name = tableName.trim();
  if (!name || columns.length === 0) return [];
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const support = dialectFkConstraintSupport(dialectName);
  const inlineFks = support.createInline ? foreignKeys : undefined;
  const body = createTableBody(columns, pkColumns, dialectName, pkName, inlineFks, schema);
  const d = dialectName.toLowerCase();
  const objectIdName = qualifyTableName(name, schema, dialectName);
  const ifNotExists = opts?.ifNotExists !== false;

  if (!ifNotExists) {
    return [`CREATE TABLE ${qTable} ${body};`];
  }
  if (dialectFamily(d) === 'sqlserver') {
    const escaped = objectIdName.replace(/'/g, "''");
    return [
      `IF OBJECT_ID(N'${escaped}', N'U') IS NULL\nCREATE TABLE ${qTable} ${body};`,
    ];
  }
  if (d === 'oracle') {
    // Oracle 23c+ supports IF NOT EXISTS; older versions ignore and may error on re-run.
    return [`CREATE TABLE IF NOT EXISTS ${qTable} ${body};`];
  }
  if (d === 'db2') {
    // DB2 has no CREATE TABLE IF NOT EXISTS — emit plain CREATE (Apply fails if exists).
    return [
      `-- review: DB2 has no CREATE TABLE IF NOT EXISTS — fails if ${name} already exists`,
      `CREATE TABLE ${qTable} ${body};`,
    ];
  }
  return [`CREATE TABLE IF NOT EXISTS ${qTable} ${body};`];
}

/**
 * DROP TABLE with existence guard via dialect hook when available.
 */
export function generateDropTableSql(
  tableName: string,
  dialectName: string,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  if (dialect.dropTableStatement) {
    return [dialect.dropTableStatement(qTable)];
  }
  return [`DROP TABLE IF EXISTS ${qTable};`];
}

/** Combine column ALTERs + PK change for an existing table. */
export function generateTableBlueprintSql(args: {
  tableName: string;
  dialect: string;
  columnOps: BlueprintColumnOp[];
  previousPk: string[];
  nextPk: string[];
  pkName?: string;
  schema?: string;
}): string[] {
  const colStmts = generateBlueprintAlterSql(
    args.tableName,
    args.dialect,
    args.columnOps,
    args.schema
  );
  const pkStmts = generatePkAlterSql(
    args.tableName,
    args.dialect,
    args.previousPk,
    args.nextPk,
    args.pkName,
    args.schema
  );
  // PK drop before column drops that remove PK cols; PK add after column adds.
  // Practical order: column drops that aren't PK-only → drop PK → column mods/adds → add PK
  // Simpler stable order used here: column ops first, then PK (matches common ALTER scripts).
  // When dropping a PK column, user should drop PK first — we emit PK alter after columns
  // only when nextPk is non-empty or previous changed; if nextPk empty and previous had PK,
  // put drop PK before column drops.
  if (args.previousPk.length > 0 && args.nextPk.length === 0) {
    return [...pkStmts, ...colStmts];
  }
  if (
    args.previousPk.length > 0 &&
    !sameStringList(args.previousPk, args.nextPk) &&
    args.columnOps.some((o) => o.kind === 'drop' && args.previousPk.includes(o.name))
  ) {
    const dropPk = generatePkAlterSql(
      args.tableName,
      args.dialect,
      args.previousPk,
      [],
      args.pkName,
      args.schema
    );
    const addPk =
      args.nextPk.length > 0
        ? generatePkAlterSql(
            args.tableName,
            args.dialect,
            [],
            args.nextPk,
            args.pkName,
            args.schema
          )
        : [];
    return [...dropPk, ...colStmts, ...addPk];
  }
  return [...colStmts, ...pkStmts];
}

// ── Foreign keys & triggers ───────────────────────────────────────────────────

export type FkReferentialAction =
  | 'NO ACTION'
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT'
  | 'RESTRICT';

export type BlueprintFkDraft = {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: FkReferentialAction;
  onUpdate?: FkReferentialAction;
};

export type BlueprintTriggerDraft = {
  name: string;
  timing: string;
  event: string;
  definition: string;
};

/** Suggest a constraint name from table + first local column. */
export function suggestFkName(tableName: string, columns: string[]): string {
  const col = columns[0] || 'col';
  const bare = tableName.replace(/^.*\./, '').replace(/[^A-Za-z0-9_]/g, '_');
  const c = col.replace(/[^A-Za-z0-9_]/g, '_');
  return `fk_${bare}_${c}`.toLowerCase().slice(0, 60);
}

export function suggestTriggerName(
  tableName: string,
  timing: string,
  event: string
): string {
  const bare = tableName.replace(/^.*\./, '').replace(/[^A-Za-z0-9_]/g, '_');
  const t = timing.split(/\s+/)[0]?.toLowerCase() || 'trg';
  const e = event.split(/\s+/)[0]?.toLowerCase() || 'evt';
  return `trg_${bare}_${t}_${e}`.toLowerCase().slice(0, 60);
}

/** Referential actions offered in the FK form (subset every dialect accepts reasonably). */
export function dialectFkActions(dialectName: string): FkReferentialAction[] {
  const d = dialectName.toLowerCase();
  if (d === 'clickhouse') return [];
  if (d === 'sqlite') return ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'];
  return ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'];
}

/**
 * Per-dialect support for FOREIGN KEY constraints on one or more columns.
 * Verified against every entry in `DIALECT_MAP` (core dialect registry).
 *
 * Two concerns:
 * - **Support** (`alterAdd` / `createInline` / `composite`) — can this dialect emit FKs?
 * - **Emission** — callers choose CREATE-inline vs ALTER ADD; formatting is shared.
 */
export type FkConstraintSupport = {
  /** `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY (cols…)` */
  alterAdd: boolean;
  /** Table-level `FOREIGN KEY (cols…) REFERENCES …` inside `CREATE TABLE` */
  createInline: boolean;
  /** Composite FKs (2+ columns on each side) */
  composite: boolean;
  hint: string;
};

/** Delegates to the core dialect × FK bitmatrix. */
export function dialectFkConstraintSupport(dialectName: string): FkConstraintSupport {
  return dialectSupportsFk(dialectName);
}

/** Structural completeness of an FK draft (name, columns, matching ref columns). */
function fkDraftIsComplete(fk: BlueprintFkDraft): boolean {
  return (
    !!fk.name.trim() &&
    fk.columns.length > 0 &&
    !!fk.referencedTable.trim() &&
    fk.referencedColumns.length > 0 &&
    fk.columns.length === fk.referencedColumns.length
  );
}

/** ON DELETE / ON UPDATE clause fragment (shared by CREATE inline + ALTER ADD). */
function fkActionClauses(fk: BlueprintFkDraft): string {
  let sql = '';
  if (fk.onDelete && fk.onDelete !== 'NO ACTION') {
    sql += ` ON DELETE ${fk.onDelete}`;
  }
  if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
    sql += ` ON UPDATE ${fk.onUpdate}`;
  }
  return sql;
}

/**
 * Table-level `CONSTRAINT name FOREIGN KEY (…) REFERENCES …` line (no trailing comma).
 * Formats only — callers gate on createInline / alterAdd / composite.
 */
export function formatForeignKeyConstraintLine(
  fk: BlueprintFkDraft,
  dialectName: string,
  schema?: string
): string | null {
  if (!fkDraftIsComplete(fk)) return null;
  const support = dialectFkConstraintSupport(dialectName);
  if (fk.columns.length > 1 && !support.composite) return null;

  const qFk = quoteIdent(fk.name.trim(), dialectName);
  const cols = fk.columns.map((c) => quoteIdent(c, dialectName)).join(', ');
  const refTable = qualifiedQuotedTable(fk.referencedTable.trim(), schema, dialectName);
  const refCols = fk.referencedColumns.map((c) => quoteIdent(c, dialectName)).join(', ');
  return (
    `CONSTRAINT ${qFk} FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})` +
    fkActionClauses(fk)
  );
}

export function generateAddForeignKeySql(
  tableName: string,
  dialectName: string,
  fk: BlueprintFkDraft,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name || !fk.name.trim() || fk.columns.length === 0 || !fk.referencedTable.trim()) {
    return [];
  }
  if (fk.referencedColumns.length === 0) return [];
  if (fk.columns.length !== fk.referencedColumns.length) {
    return [
      `-- review: FK ${fk.name}: local (${fk.columns.length}) and referenced (${fk.referencedColumns.length}) column counts must match`,
    ];
  }

  const support = dialectFkConstraintSupport(dialectName);
  if (!support.alterAdd) {
    if (!support.createInline) {
      return [
        `-- review: ${dialectName} does not support FOREIGN KEY constraints (${fk.name})`,
      ];
    }
    return [
      `-- review: ${dialectName} cannot ALTER TABLE ADD FOREIGN KEY (${fk.name}) — include in CREATE TABLE or recreate ${name}`,
    ];
  }
  if (fk.columns.length > 1 && !support.composite) {
    return [
      `-- review: ${dialectName} does not support composite FOREIGN KEY (${fk.name})`,
    ];
  }

  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const line = formatForeignKeyConstraintLine(fk, dialectName, schema);
  if (!line) return [];
  return [`ALTER TABLE ${qTable} ADD ${line};`];
}

export function generateDropForeignKeySql(
  tableName: string,
  dialectName: string,
  fkName: string,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name || !fkName.trim()) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const qFk = quoteIdent(fkName.trim(), dialectName);
  if (dialect.dropForeignKeyStatement) {
    return [dialect.dropForeignKeyStatement(qTable, qFk)];
  }
  return [`ALTER TABLE ${qTable} DROP CONSTRAINT IF EXISTS ${qFk};`];
}

export type TriggerFormMeta = {
  timings: string[];
  events: string[];
  bodyPlaceholder: string;
  hint: string;
};

export function dialectTriggerForm(dialectName: string): TriggerFormMeta {
  const d = dialectName.toLowerCase();
  if (dialectFamily(d) === 'mysql') {
    return {
      timings: ['BEFORE', 'AFTER'],
      events: ['INSERT', 'UPDATE', 'DELETE'],
      bodyPlaceholder: 'BEGIN\n  -- e.g. SET NEW.updated_at = NOW();\nEND',
      hint: 'MySQL/MariaDB: FOR EACH ROW body between BEGIN … END.',
    };
  }
  if (d === 'oracle') {
    return {
      // Oracle's own TRIGGER_TYPE vocabulary — the row/statement half is not
      // decoration: oracleSqlDialect.createTriggerStatement emits FOR EACH ROW
      // only when the timing says so. A bare 'BEFORE' builds a statement-level
      // trigger, and any :NEW/:OLD in the body then fails with PLS-00049.
      timings: [
        'BEFORE EACH ROW',
        'AFTER EACH ROW',
        'BEFORE STATEMENT',
        'AFTER STATEMENT',
        'INSTEAD OF',
      ],
      events: ['INSERT', 'UPDATE', 'DELETE'],
      bodyPlaceholder: 'BEGIN\n  -- PL/SQL body\n  NULL;\nEND;',
      hint: 'Oracle: CREATE OR REPLACE TRIGGER with PL/SQL body. Use EACH ROW for :NEW/:OLD.',
    };
  }
  if (d === 'postgres' || d === 'cockroachdb' || d === 'yugabytedb') {
    return {
      timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
      events: ['INSERT', 'UPDATE', 'DELETE'],
      bodyPlaceholder:
        '-- Paste function name, or full EXECUTE FUNCTION …()\nEXECUTE FUNCTION your_trigger_fn();',
      hint: 'Postgres-family triggers call a FUNCTION — create the function first, then reference it here.',
    };
  }
  if (dialectFamily(d) === 'sqlserver') {
    return {
      timings: ['AFTER', 'INSTEAD OF'],
      events: ['INSERT', 'UPDATE', 'DELETE'],
      bodyPlaceholder: 'BEGIN\n  -- T-SQL body\nEND;',
      hint: 'SQL Server: AFTER or INSTEAD OF triggers (no BEFORE).',
    };
  }
  if (d === 'sqlite') {
    return {
      timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
      events: ['INSERT', 'UPDATE', 'DELETE'],
      bodyPlaceholder: 'BEGIN\n  -- SQL statements\nEND;',
      hint: 'SQLite: FOR EACH ROW trigger body.',
    };
  }
  return {
    timings: ['BEFORE', 'AFTER'],
    events: ['INSERT', 'UPDATE', 'DELETE'],
    bodyPlaceholder: 'BEGIN\n  -- trigger body\nEND;',
    hint: 'Dialect-specific CREATE TRIGGER statement.',
  };
}

export function generateCreateTriggerSql(
  tableName: string,
  dialectName: string,
  trg: BlueprintTriggerDraft,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name || !trg.name.trim() || !trg.definition.trim()) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const spec = {
    name: quoteIdent(trg.name.trim(), dialectName),
    timing: trg.timing,
    event: trg.event,
    definition: trg.definition.trim(),
  };
  const viaDialect = dialect.createTriggerStatement?.(spec, qTable);
  if (viaDialect) return [viaDialect.endsWith(';') ? viaDialect : `${viaDialect};`];

  const d = dialectName.toLowerCase();
  const timing = (trg.timing || 'AFTER').toUpperCase();
  const event = (trg.event || 'INSERT').toUpperCase();
  const body = trg.definition.trim();

  if (d === 'postgres' || d === 'cockroachdb' || d === 'yugabytedb') {
    // Body is expected to be EXECUTE FUNCTION … or a full clause.
    const exec = /^EXECUTE\b/i.test(body) ? body : `EXECUTE FUNCTION ${body}`;
    return [
      `CREATE TRIGGER ${spec.name}\n${timing} ${event} ON ${qTable}\nFOR EACH ROW\n${exec};`,
    ];
  }
  if (dialectFamily(d) === 'sqlserver') {
    return [
      `CREATE TRIGGER ${spec.name} ON ${qTable}\n${timing} ${event}\nAS\n${body};`,
    ];
  }
  if (d === 'clickhouse') {
    return [`-- review: ClickHouse trigger support is limited — review before running`];
  }
  return [
    `CREATE TRIGGER ${spec.name} ${timing} ${event} ON ${qTable}\nFOR EACH ROW\n${body};`,
  ];
}

export function generateDropTriggerSql(
  tableName: string,
  dialectName: string,
  triggerName: string,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name || !triggerName.trim()) return [];
  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const qTrg = quoteIdent(triggerName.trim(), dialectName);
  if (dialect.dropTriggerStatement) {
    return [dialect.dropTriggerStatement(qTrg, qTable)];
  }
  return [`DROP TRIGGER IF EXISTS ${qTrg};`];
}

// ── Indexes ───────────────────────────────────────────────────────────────────

export type IndexColumnOrder = 'ASC' | 'DESC';

export type BlueprintIndexDraft = {
  name: string;
  columns: string[];
  /** Parallel to `columns`; defaults to ASC when missing. */
  orders: IndexColumnOrder[];
  /** true = UNIQUE (reject duplicates); false = accept duplicates */
  unique: boolean;
  /**
   * Partial / filtered index predicate (without the WHERE keyword), e.g.
   * `status = 'active'`. Emitted only when the dialect supports `filter`.
   */
  filter?: string;
  /**
   * SQL Server / Azure SQL: unique-constraint-backed index must use
   * ALTER TABLE ADD/DROP CONSTRAINT rather than CREATE/DROP INDEX.
   */
  constraint?: boolean;
  /**
   * When this pending create replaces an existing index, the live name that
   * will be dropped. Used so Undo-drop / Remove-pending stay consistent.
   */
  replaces?: string;
};

/** Suggest an index name from table + first column. */
export function suggestIndexName(tableName: string, columns: string[], unique: boolean): string {
  const col = columns[0] || 'col';
  const bare = tableName.replace(/^.*\./, '').replace(/[^A-Za-z0-9_]/g, '_');
  const c = col.replace(/[^A-Za-z0-9_]/g, '_');
  const prefix = unique ? 'ux' : 'ix';
  return `${prefix}_${bare}_${c}`.toLowerCase().slice(0, 60);
}

/** Delegates to the core dialect × index bitmatrix. */
export function dialectIndexSupport(dialectName: string): IndexFeatureSupport {
  return dialectSupportsIndex(dialectName);
}

export function normalizeIndexOrders(
  columns: string[],
  orders: IndexColumnOrder[] | undefined
): IndexColumnOrder[] {
  return columns.map((_, i) => (orders?.[i] === 'DESC' ? 'DESC' : 'ASC'));
}

function formatIndexColumnList(
  draft: BlueprintIndexDraft,
  dialectName: string,
  support: IndexFeatureSupport
): string {
  const orders = normalizeIndexOrders(draft.columns, draft.orders);
  return draft.columns
    .map((c, i) => {
      const q = quoteIdent(c, dialectName);
      if (!support.columnOrder) return q;
      return `${q} ${orders[i] ?? 'ASC'}`;
    })
    .join(', ');
}

function indexDraftIsComplete(idx: BlueprintIndexDraft): boolean {
  return !!idx.name.trim() && idx.columns.length > 0;
}

export function generateCreateIndexSql(
  tableName: string,
  dialectName: string,
  idx: BlueprintIndexDraft,
  schema?: string
): string[] {
  const name = tableName.trim();
  if (!name || !indexDraftIsComplete(idx)) return [];

  const support = dialectIndexSupport(dialectName);
  if (!support.create) {
    return [
      `-- review: ${dialectName} does not support CREATE INDEX (${idx.name.trim()}) — ${support.hint}`,
    ];
  }
  if (idx.unique && !support.unique) {
    return [
      `-- review: ${dialectName} does not support UNIQUE indexes (${idx.name.trim()})`,
    ];
  }
  if (!idx.unique && !support.acceptDuplicates) {
    return [
      `-- review: ${dialectName} does not support non-unique indexes (${idx.name.trim()})`,
    ];
  }

  const filterPred = idx.filter?.trim() ?? '';
  if (filterPred && !support.filter) {
    return [
      `-- review: ${dialectName} does not support filtered/partial indexes (${idx.name.trim()}) — omit WHERE or recreate without a filter`,
    ];
  }

  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const qName = quoteIdent(idx.name.trim(), dialectName);
  const d = dialectName.toLowerCase();

  // SQL Server unique constraints must round-trip as constraints, not indexes.
  // Constraints cannot carry a WHERE filter — use a unique filtered index instead.
  if (idx.unique && idx.constraint && (dialectFamily(d) === 'sqlserver')) {
    if (filterPred) {
      return [
        `-- review: ${idx.name.trim()}: unique constraints cannot include a WHERE filter — create a UNIQUE INDEX with filter instead`,
      ];
    }
    const cols = idx.columns.map((c) => quoteIdent(c, dialectName)).join(', ');
    return [`ALTER TABLE ${qTable} ADD CONSTRAINT ${qName} UNIQUE (${cols});`];
  }

  const colList = formatIndexColumnList(idx, dialectName, support);
  const uniqueStr = idx.unique ? ' UNIQUE' : '';
  const whereClause = filterPred ? ` WHERE ${filterPred}` : '';
  return [`CREATE${uniqueStr} INDEX ${qName} ON ${qTable} (${colList})${whereClause};`];
}

export function generateDropIndexSql(
  tableName: string,
  dialectName: string,
  indexName: string,
  schema?: string,
  opts?: { constraint?: boolean }
): string[] {
  const name = tableName.trim();
  if (!name || !indexName.trim()) return [];

  const support = dialectIndexSupport(dialectName);
  if (!support.drop) {
    return [
      `-- review: ${dialectName} does not support DROP INDEX (${indexName.trim()}) — ${support.hint}`,
    ];
  }

  const dialect = resolveDialect(dialectName);
  const qTable = qualifiedQuotedTable(name, schema, dialectName);
  const qIdx = quoteIdent(indexName.trim(), dialectName);
  if (dialect.dropIndexStatement) {
    return [
      dialect.dropIndexStatement(qIdx, qTable, {
        name: qIdx,
        columns: [],
        unique: !!opts?.constraint,
        constraint: opts?.constraint,
      }),
    ];
  }
  return [`DROP INDEX IF EXISTS ${qIdx};`];
}

/**
 * Compose column/PK alters with FK / trigger / index DDL.
 * Drops (indexes, FKs, triggers) run *before* `base` so DROP COLUMN cannot
 * precede DROP INDEX / DROP FK that still reference the column.
 * Creates run after `base`.
 */
export function appendFkTriggerSql(
  base: string[],
  args: {
    tableName: string;
    dialect: string;
    schema?: string;
    addFks?: BlueprintFkDraft[];
    dropFkNames?: string[];
    addTriggers?: BlueprintTriggerDraft[];
    dropTriggerNames?: string[];
    addIndexes?: BlueprintIndexDraft[];
    dropIndexes?: Array<{ name: string; constraint?: boolean }>;
  }
): string[] {
  const drops: string[] = [];
  for (const idx of args.dropIndexes ?? []) {
    drops.push(
      ...generateDropIndexSql(args.tableName, args.dialect, idx.name, args.schema, {
        constraint: idx.constraint,
      })
    );
  }
  for (const n of args.dropFkNames ?? []) {
    drops.push(...generateDropForeignKeySql(args.tableName, args.dialect, n, args.schema));
  }
  for (const n of args.dropTriggerNames ?? []) {
    drops.push(...generateDropTriggerSql(args.tableName, args.dialect, n, args.schema));
  }

  const creates: string[] = [];
  for (const idx of args.addIndexes ?? []) {
    creates.push(...generateCreateIndexSql(args.tableName, args.dialect, idx, args.schema));
  }
  for (const fk of args.addFks ?? []) {
    creates.push(...generateAddForeignKeySql(args.tableName, args.dialect, fk, args.schema));
  }
  for (const trg of args.addTriggers ?? []) {
    creates.push(...generateCreateTriggerSql(args.tableName, args.dialect, trg, args.schema));
  }
  return [...drops, ...base, ...creates];
}

// ── Clone / archive & recreate ───────────────────────────────────────────────

/** Bare table name (last segment of schema.table). */
export function bareTableName(tableName: string): string {
  const t = tableName.trim();
  if (!t) return t;
  const parts = t.split('.');
  return parts[parts.length - 1] ?? t;
}

/**
 * Pick the next archive name `base_N` (or `base_1` when none exist).
 * `suffixMode: 'auto'` continues from the highest existing `_N`.
 * `suffixMode: 'fixed'` uses `startNumber` (must not collide).
 */
export function nextArchiveTableName(
  baseTableName: string,
  existingTableNames: string[],
  opts?: { suffixMode?: 'auto' | 'fixed'; startNumber?: number }
): { archiveName: string; number: number; error?: string } {
  const bare = bareTableName(baseTableName);
  if (!bare) return { archiveName: '', number: 0, error: 'Missing table name' };

  const mode = opts?.suffixMode ?? 'auto';
  const startNumber = Math.max(1, Math.floor(opts?.startNumber ?? 1));
  const existing = new Set(
    existingTableNames.map((n) => bareTableName(n).toLowerCase()).filter(Boolean)
  );

  const escapeRe = escapeRegExp(bare);
  const re = new RegExp(`^${escapeRe}_(\\d+)$`, 'i');
  let max = 0;
  for (const n of existingTableNames) {
    const m = bareTableName(n).match(re);
    if (!m) continue;
    const num = Number(m[1]);
    if (Number.isFinite(num) && num > max) max = num;
  }

  if (mode === 'fixed') {
    const archiveName = `${bare}_${startNumber}`;
    if (existing.has(archiveName.toLowerCase())) {
      return {
        archiveName,
        number: startNumber,
        error: `Table ${archiveName} already exists — pick another number or use Auto`,
      };
    }
    return { archiveName, number: startNumber };
  }

  const number = Math.max(max + 1, startNumber);
  const archiveName = `${bare}_${number}`;
  if (existing.has(archiveName.toLowerCase())) {
    // Extremely unlikely if we scanned correctly; bump until free.
    let n = number;
    while (existing.has(`${bare}_${n}`.toLowerCase())) n += 1;
    return { archiveName: `${bare}_${n}`, number: n };
  }
  return { archiveName, number };
}

/** Dialect rename for a table → archive name (new name is bare / unqualified). */
export function generateRenameTableSql(
  fromTable: string,
  toTable: string,
  dialectName: string,
  schema?: string
): string[] {
  const from = fromTable.trim();
  const toBare = bareTableName(toTable);
  if (!from || !toBare) return [];
  const d = dialectName.toLowerCase();
  const fromQ = qualifiedQuotedTable(from, schema, dialectName);
  const toQ = quoteIdent(toBare, dialectName);

  if (dialectFamily(d) === 'mysql') {
    const toFull = qualifiedQuotedTable(toBare, schema, dialectName);
    return [`RENAME TABLE ${fromQ} TO ${toFull};`];
  }
  if (dialectFamily(d) === 'sqlserver') {
    const fromQual = qualifyTableName(from, schema, dialectName).replace(/'/g, "''");
    const toEsc = toBare.replace(/'/g, "''");
    return [`EXEC sp_rename N'${fromQual}', N'${toEsc}', N'OBJECT';`];
  }
  if (d === 'db2' || d === 'clickhouse') {
    return [`RENAME TABLE ${fromQ} TO ${toQ};`];
  }
  // postgres / cockroach / yugabyte / sqlite / oracle / duckdb / redshift …
  return [`ALTER TABLE ${fromQ} RENAME TO ${toQ};`];
}

/** Schema-unique index/constraint names — must free them on the archive before recreate. */
const SCHEMA_UNIQUE_INDEX_DIALECTS = new Set([
  'postgres',
  'postgresql',
  'cockroachdb',
  'yugabytedb',
  'oracle',
  'redshift',
  'duckdb',
  'sqlite',
  'sqlserver',
  'azuresql',
  'db2',
]);

/** Schema/db-unique FK names — drop from archive when recreating on the live table. */
const SCHEMA_UNIQUE_FK_DIALECTS = new Set([
  'postgres',
  'postgresql',
  'cockroachdb',
  'yugabytedb',
  'oracle',
  'mysql',
  'mariadb',
  'tidb',
  'sqlserver',
  'azuresql',
  'db2',
]);

function dialectNeedsIndexRenameOnArchive(dialectName: string): boolean {
  return SCHEMA_UNIQUE_INDEX_DIALECTS.has(dialectName.toLowerCase());
}

function dialectNeedsFkDropOnArchive(dialectName: string): boolean {
  return SCHEMA_UNIQUE_FK_DIALECTS.has(dialectName.toLowerCase());
}

function archiveSuffixName(objectName: string, archiveNumber: number): string {
  const base = objectName.trim();
  const suffix = `_h${archiveNumber}`;
  const max = 60;
  if (base.length + suffix.length <= max) return `${base}${suffix}`;
  return `${base.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
}

function generateRenameIndexSql(
  indexName: string,
  newName: string,
  archiveTable: string,
  dialectName: string,
  schema?: string
): string[] {
  const d = dialectName.toLowerCase();
  const qOld = quoteIdent(indexName.trim(), dialectName);
  const qNew = quoteIdent(newName.trim(), dialectName);
  const qTable = qualifiedQuotedTable(archiveTable, schema, dialectName);

  if (d === 'sqlite') {
    // SQLite has no RENAME INDEX — drop + recreate under the new name on the archive.
    return [
      `-- review: SQLite cannot RENAME INDEX — drop ${indexName} then recreate as ${newName} on ${bareTableName(archiveTable)} (recreate statements are emitted next)`,
      `DROP INDEX IF EXISTS ${qOld};`,
    ];
  }
  if (dialectFamily(d) === 'sqlserver') {
    const qual = `${qualifyTableName(archiveTable, schema, dialectName)}.${indexName}`.replace(
      /'/g,
      "''"
    );
    return [`EXEC sp_rename N'${qual}', N'${newName.replace(/'/g, "''")}', N'INDEX';`];
  }
  if (d === 'oracle') {
    return [`ALTER INDEX ${qOld} RENAME TO ${qNew};`];
  }
  // Postgres-family / duckdb / redshift
  return [`ALTER INDEX ${qOld} RENAME TO ${qNew};`];
}

function generateRenameConstraintSql(
  tableName: string,
  oldName: string,
  newName: string,
  dialectName: string,
  schema?: string
): string[] {
  const d = dialectName.toLowerCase();
  const qTable = qualifiedQuotedTable(tableName, schema, dialectName);
  const qOld = quoteIdent(oldName.trim(), dialectName);
  const qNew = quoteIdent(newName.trim(), dialectName);
  if (dialectFamily(d) === 'sqlserver') {
    const qual = `${qualifyTableName(tableName, schema, dialectName)}.${oldName}`.replace(
      /'/g,
      "''"
    );
    return [`EXEC sp_rename N'${qual}', N'${newName.replace(/'/g, "''")}', N'OBJECT';`];
  }
  if (d === 'mysql' || d === 'mariadb' || d === 'tidb' || d === 'sqlite') {
    return [];
  }
  return [`ALTER TABLE ${qTable} RENAME CONSTRAINT ${qOld} TO ${qNew};`];
}

export type CloneTableOptions = {
  table: TableSchema;
  dialect: string;
  schema?: string;
  /** All table names in the schema (for suffix collision checks). */
  existingTableNames: string[];
  /** Auto = next free `_N`; fixed = use startNumber (error if taken). */
  suffixMode?: 'auto' | 'fixed';
  /** Minimum / fixed archive number (default 1). */
  startNumber?: number;
  /** Recreate indexes on the new empty table (default true). */
  keepIndexes?: boolean;
  /** Recreate outbound foreign keys on the new empty table (default true). */
  keepForeignKeys?: boolean;
};

export type CloneTablePlan = {
  archiveName: string;
  archiveNumber: number;
  statements: string[];
  error?: string;
  /** Child tables whose FKs still point at the archive after rename. */
  inboundFkTables: string[];
};

function fkInfoToDraft(fk: {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}): BlueprintFkDraft {
  return {
    name: fk.name,
    columns: [...fk.columns],
    referencedTable: fk.referencedTable,
    referencedColumns: [...(fk.referencedColumns ?? [])],
  };
}

function indexInfoToCloneDraft(idx: {
  name: string;
  columns: string[];
  unique: boolean;
  constraint?: boolean;
  filter?: string;
}): BlueprintIndexDraft {
  return {
    name: idx.name,
    columns: [...idx.columns],
    orders: idx.columns.map(() => 'ASC' as IndexColumnOrder),
    unique: !!idx.unique,
    filter: idx.filter ?? '',
    constraint: idx.constraint,
  };
}

/**
 * Archive a large table under `name_N`, then recreate an empty table with the
 * original name + schema so applications keep working. Optionally restore
 * indexes and outbound foreign keys on the new table.
 */
export function generateCloneTableSql(args: CloneTableOptions): CloneTablePlan {
  const table = args.table;
  const dialect = args.dialect;
  const schema = args.schema;
  const liveName = table.name.trim();
  const bare = bareTableName(liveName);
  const keepIndexes = args.keepIndexes !== false;
  const keepForeignKeys = args.keepForeignKeys !== false;

  if (!liveName || (table.columns?.length ?? 0) === 0) {
    return {
      archiveName: '',
      archiveNumber: 0,
      statements: [],
      error: 'Table has no columns to clone',
      inboundFkTables: [],
    };
  }

  const picked = nextArchiveTableName(liveName, args.existingTableNames, {
    suffixMode: args.suffixMode,
    startNumber: args.startNumber,
  });
  if (picked.error) {
    return {
      archiveName: picked.archiveName,
      archiveNumber: picked.number,
      statements: [],
      error: picked.error,
      inboundFkTables: [],
    };
  }

  const archiveName = picked.archiveName;
  const archiveNumber = picked.number;
  const stmts: string[] = [];
  stmts.push(
    `-- Clone table: rename ${bare} → ${archiveName}, recreate empty ${bare} (app keeps the live name)`
  );

  // 1) Rename live → archive (data preserved on archive).
  stmts.push(...generateRenameTableSql(liveName, archiveName, dialect, schema));

  const fkSupport = dialectFkConstraintSupport(dialect);
  const outboundFks = (table.foreignKeys ?? []).filter((fk) => fk.name && fk.columns?.length);
  const pkCols = pkColumnsFromTable(table);
  const pkKey = pkCols.map((c) => c.toLowerCase()).join('\0');
  const indexes = (table.indices ?? []).filter((idx) => {
    if (!idx.name || !idx.columns?.length) return false;
    // PRIMARY KEY already creates a unique index — skip the catalog twin.
    if (
      idx.unique &&
      pkCols.length > 0 &&
      idx.columns.map((c) => c.toLowerCase()).join('\0') === pkKey
    ) {
      return false;
    }
    return true;
  });

  // 2) Free schema-unique names on the archive so the new table can reuse them.
  if (keepForeignKeys && outboundFks.length > 0 && dialectNeedsFkDropOnArchive(dialect)) {
    if (fkSupport.alterAdd || dialect.toLowerCase() === 'sqlite') {
      stmts.push(
        `-- Free FK names on archive ${archiveName} (history table; outbound FKs recreated on ${bare})`
      );
      for (const fk of outboundFks) {
        stmts.push(...generateDropForeignKeySql(archiveName, dialect, fk.name, schema));
      }
    }
  }

  const pkName =
    table.primaryKey?.name && table.primaryKey.name.toUpperCase() !== 'PRIMARY'
      ? table.primaryKey.name
      : undefined;
  if (pkName && dialectNeedsIndexRenameOnArchive(dialect)) {
    const newPk = archiveSuffixName(pkName, archiveNumber);
    const renames = generateRenameConstraintSql(archiveName, pkName, newPk, dialect, schema);
    if (renames.length) {
      stmts.push(`-- Rename PK constraint on archive so ${bare} can reuse ${pkName}`);
      stmts.push(...renames);
    }
  } else if (dialectNeedsIndexRenameOnArchive(dialect) && pkCols.length > 0) {
    const guessed = `${bare}_pkey`;
    const newPk = archiveSuffixName(guessed, archiveNumber);
    stmts.push(
      `-- review: if CREATE fails on PK name, run: ALTER TABLE ${archiveName} RENAME CONSTRAINT ${guessed} TO ${newPk};`
    );
  }

  const dLower = dialect.toLowerCase();
  if (keepIndexes && indexes.length > 0 && dialectNeedsIndexRenameOnArchive(dialect)) {
    stmts.push(`-- Rename/move indexes on archive ${archiveName} so names can be reused`);
    for (const idx of indexes) {
      const newName = archiveSuffixName(idx.name, archiveNumber);
      if (idx.constraint) {
        stmts.push(
          ...generateRenameConstraintSql(archiveName, idx.name, newName, dialect, schema)
        );
        continue;
      }
      stmts.push(...generateRenameIndexSql(idx.name, newName, archiveName, dialect, schema));
      // SQLite has no RENAME INDEX — recreate under the suffixed name after DROP.
      if (dLower === 'sqlite') {
        stmts.push(
          ...generateCreateIndexSql(
            archiveName,
            dialect,
            { ...indexInfoToCloneDraft(idx), name: newName },
            schema
          )
        );
      }
    }
  }

  // 3) Create empty live table (same columns / PK; inline FKs when required).
  const inlineFks =
    keepForeignKeys && fkSupport.createInline && !fkSupport.alterAdd
      ? outboundFks.map(fkInfoToDraft)
      : undefined;
  stmts.push(
    ...generateCreateTableSql(
      bare,
      table.columns,
      pkCols,
      dialect,
      pkName,
      inlineFks,
      schema,
      { ifNotExists: false }
    )
  );

  // 4) Indexes on the new empty table.
  if (keepIndexes) {
    for (const idx of indexes) {
      stmts.push(...generateCreateIndexSql(bare, dialect, indexInfoToCloneDraft(idx), schema));
    }
  }

  // 5) Outbound FKs via ALTER on dialects that support it.
  if (keepForeignKeys && fkSupport.alterAdd) {
    for (const fk of outboundFks) {
      stmts.push(...generateAddForeignKeySql(bare, dialect, fkInfoToDraft(fk), schema));
    }
  } else if (keepForeignKeys && !fkSupport.createInline && !fkSupport.alterAdd) {
    stmts.push(`-- review: ${dialect} does not support foreign keys — skipped`);
  }

  return {
    archiveName,
    archiveNumber,
    statements: stmts,
    inboundFkTables: [],
  };
}

/** Find tables that reference `targetTable` via foreign keys (inbound). */
export function findInboundForeignKeyTables(
  tables: TableSchema[],
  targetTable: string
): string[] {
  const bare = bareTableName(targetTable).toLowerCase();
  const qual = targetTable.trim().toLowerCase();
  const hits = new Set<string>();
  for (const t of tables) {
    if (bareTableName(t.name).toLowerCase() === bare) continue;
    for (const fk of t.foreignKeys ?? []) {
      const ref = (fk.referencedTable || '').trim().toLowerCase();
      if (!ref) continue;
      if (ref === qual || bareTableName(ref).toLowerCase() === bare) {
        hits.add(t.name);
      }
    }
  }
  return [...hits].sort((a, b) => a.localeCompare(b));
}
