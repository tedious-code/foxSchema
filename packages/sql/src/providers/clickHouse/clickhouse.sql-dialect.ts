import type { SqlDialect, ColumnSpec } from '../../modules/dialect/sql-dialect.interface.js';
import type { TableSchema } from '../../interfaces/index.js';
import { makeDialectTypeFns, plain, sized, decimalAs, tokenizeType } from '../../modules/dialect/type-mapping.js';

// ClickHouse type names are case-sensitive. Lowercase the token for parseMap lookup.
const types = makeDialectTypeFns({
  label: 'ClickHouse',
  parseMap: {
    // Signed integers
    int8: 'smallint', int16: 'smallint',
    int32: 'integer', int64: 'bigint', int128: 'bigint', int256: 'bigint',
    // Unsigned integers (promote to next signed size to avoid overflow)
    uint8: 'smallint', uint16: 'integer',
    uint32: 'bigint', uint64: 'bigint', uint128: 'bigint', uint256: 'bigint',
    // Float
    float32: 'real', float64: 'double',
    // String
    string: 'text',
    fixedstring: 'char',
    // Boolean
    bool: 'boolean', boolean: 'boolean',
    // Date/time
    date: 'date', date32: 'date',
    datetime: 'timestamp', datetime64: 'timestamp',
    // Decimal — DecimalN(S) paren is *scale*; fixed precision is per family.
    decimal: 'decimal', decimal32: 'decimal', decimal64: 'decimal',
    decimal128: 'decimal', decimal256: 'decimal',
    // UUID
    uuid: 'uuid',
    // Semi-structured
    json: 'json',
    // Enums → text (values are label strings)
    enum8: 'text', enum16: 'text',
  },
  renderMap: {
    boolean: plain('Bool'),
    smallint: plain('Int16'),
    integer: plain('Int32'),
    bigint: plain('Int64'),
    decimal: decimalAs('Decimal'),
    real: plain('Float32'),
    double: plain('Float64'),
    char: sized('FixedString'),
    varchar: plain('String'),
    text: plain('String'),
    binary: plain('String'),
    varbinary: plain('String'),
    blob: plain('String'),
    date: plain('Date'),
    time: plain('String'),
    timestamp: (t) => {
      const p = t.length !== undefined ? Math.min(Math.max(t.length, 0), 9) : 3;
      return `DateTime64(${p})`;
    },
    timestamptz: (t) => {
      const p = t.length !== undefined ? Math.min(Math.max(t.length, 0), 9) : 3;
      return `DateTime64(${p}, 'UTC')`;
    },
    uuid: plain('UUID'),
    json: plain('JSON'),
    xml: plain('String'),
  },
});

/** Fixed precision for ClickHouse Decimal32/64/128/256; the paren is scale only. */
const CH_DECIMAL_PRECISION: Record<string, number> = {
  decimal32: 9,
  decimal64: 18,
  decimal128: 38,
  decimal256: 76,
};

function unwrapOuterParens(raw: string): string {
  let s = raw.trim();
  while (s.startsWith('(') && s.endsWith(')') && s.length >= 2) {
    let depth = 0;
    let wrapsEntire = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i !== s.length - 1) {
          wrapsEntire = false;
          break;
        }
      }
    }
    if (!wrapsEntire || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Split a ClickHouse sorting_key / primary_key catalog string on top-level
 * commas. `id, created_at` → two columns; `cityHash64(id, 1)` stays one
 * expression so a nested comma does not become a fake column.
 */
export function parseClickHouseKeyList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of unwrapOuterParens(raw)) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      const piece = current.trim();
      if (piece) out.push(piece);
      current = '';
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) out.push(last);
  return out;
}

function clickHouseEngineName(engine: string | undefined): string {
  const stripped = (engine ?? '').trim().replace(/^ENGINE\s*=\s*/i, '').trim();
  return stripped || 'MergeTree';
}

function clickHouseEngineSql(engine: string | undefined): string {
  return `ENGINE = ${clickHouseEngineName(engine)}`;
}

function clickHouseOrderBy(table: TableSchema): string[] {
  return table.orderBy?.length ? table.orderBy : table.primaryKey?.columns ?? [];
}

function clickHouseOrderBySql(quotedOrderBy: string[]): string {
  if (quotedOrderBy.length === 0) return 'tuple()';
  if (quotedOrderBy.length === 1) return quotedOrderBy[0]!;
  return `(${quotedOrderBy.join(', ')})`;
}

function sameKeyList(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((c, i) => c.toUpperCase() === (b[i] ?? '').toUpperCase());
}

function clickHousePkReview(tableName: string): string[] {
  return [`-- review: ${tableName}: ClickHouse PRIMARY KEY is part of the ENGINE clause and cannot be altered in place. Recreate the table to change the key.`];
}

function parseClickHouseType(raw: string) {
  const parsed = types.parseType(raw);
  const tok = tokenizeType(raw);
  const name = tok.name;
  const fixed = CH_DECIMAL_PRECISION[name];
  if (fixed !== undefined) {
    // Decimal64(4) tokenizes as length/precision 4 — that value is the *scale*.
    const scale = tok.scale ?? tok.length ?? tok.precision ?? 0;
    return { ...parsed, base: 'decimal' as const, precision: fixed, scale };
  }
  if (name === 'datetime64' && parsed.length === undefined) {
    // DateTime64(3, 'UTC') — fsp is the first arg (precision after tokenize).
    const fsp = tok.length ?? tok.precision ?? 3;
    return { ...parsed, length: fsp };
  }
  return parsed;
}

export const clickHouseSqlDialect: SqlDialect = {
  // ClickHouse has no auto-increment / identity concept
  identityClause(_c: ColumnSpec): string {
    return '';
  },

  addColumnStatement(tableName: string, colDef: string): string {
    return `ALTER TABLE ${tableName} ADD COLUMN ${colDef};`;
  },

  modifyColumnStatements(tableName: string, colName: string, col: ColumnSpec): string[] {
    return [`ALTER TABLE ${tableName} MODIFY COLUMN ${colName} ${col.type};`];
  },

  dropColumnStatement(tableName: string, colName: string): string {
    return `ALTER TABLE ${tableName} DROP COLUMN ${colName};`;
  },

  setDefaultStatements(tableName: string, colName: string, defaultValue: string | undefined): string[] {
    if (defaultValue) {
      return [`ALTER TABLE ${tableName} MODIFY COLUMN ${colName} DEFAULT ${defaultValue};`];
    }
    return [`ALTER TABLE ${tableName} MODIFY COLUMN ${colName} REMOVE DEFAULT;`];
  },

  dropPrimaryKeyStatements(tableName: string, _pkName: string | undefined): string[] {
    return clickHousePkReview(tableName);
  },

  addPrimaryKeyStatements(tableName: string, _quotedColumns: string[], _pkName: string | undefined): string[] {
    return clickHousePkReview(tableName);
  },

  // Table-level PRIMARY KEY (cols) is not valid inside the column list — only
  // CHECK / ASSUME. The key is ENGINE … ORDER BY after the closing paren.
  inlinePrimaryKeyConstraint: false,

  createTableSuffix(table: TableSchema, quotedOrderBy: string[]): string {
    const pkCols = table.primaryKey?.columns ?? [];
    // ClickHouse PRIMARY KEY defaults to ORDER BY; only emit it when they differ.
    const pkClause =
      pkCols.length > 0 && !sameKeyList(pkCols, clickHouseOrderBy(table))
        ? ` PRIMARY KEY ${clickHouseOrderBySql(pkCols)}`
        : '';
    return ` ${clickHouseEngineSql(table.engine)}${pkClause} ORDER BY ${clickHouseOrderBySql(quotedOrderBy)}`;
  },

  engineChangeStatements(tableName: string, source: TableSchema, target: TableSchema): string[] {
    const srcOrder = clickHouseOrderBy(source);
    if (
      clickHouseEngineName(source.engine).toLowerCase() === clickHouseEngineName(target.engine).toLowerCase() &&
      sameKeyList(srcOrder, clickHouseOrderBy(target))
    ) {
      return [];
    }
    return [
      `-- review: ${tableName}: ClickHouse ENGINE / ORDER BY cannot be altered in place. Recreate the table to apply ${clickHouseEngineSql(source.engine)} ORDER BY ${clickHouseOrderBySql(srcOrder)}.`,
    ];
  },

  // ClickHouse uses Nullable(T) wrapper instead of NULL / NOT NULL keywords.
  nullableTypeWrapper(typeSql: string, nullable: boolean): string {
    return nullable ? `Nullable(${typeSql})` : typeSql;
  },

  ...types,
  parseType: parseClickHouseType,
};
