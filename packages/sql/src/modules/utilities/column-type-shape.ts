/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What kind of type a column type is (text, integer, decimal, …) and its size,
 * read across dialects' spellings. Shared by the column-change planner (the
 * data-loss check) and the dialects that phrase a type change by kind. Kept
 * apart from the planner so a dialect can import it without a cycle.
 */

/** A type as written, lower-cased with single spaces, for comparing. */
export const normType = (type: string) => type.trim().replace(/\s+/g, ' ').toLowerCase();

export interface TypeShape {
  kind: 'text' | 'int' | 'decimal' | 'float' | 'date' | 'datetime' | 'datetimetz' | 'bool' | 'other';
  /** Text length, integer width rank, or decimal precision. */
  size?: number;
  scale?: number;
}

const TEXT_TYPES = new Set([
  'char', 'nchar', 'varchar', 'nvarchar', 'character', 'character varying', 'text', 'ntext',
  'string', 'clob', 'varchar2', 'nvarchar2', 'tinytext', 'mediumtext', 'longtext',
]);

const INT_RANK: Record<string, number> = {
  tinyint: 1, smallint: 2, int2: 2, mediumint: 3, int: 4, integer: 4, int4: 4, serial: 4, bigint: 5, int8: 5, bigserial: 5,
  // ClickHouse. Its Int8 is one byte, but `int8` above is PostgreSQL's bigint, which wins.
  int16: 2, int32: 4, int64: 5, int128: 6, int256: 7,
};

const FLOAT_RANK: Record<string, number> = {
  real: 1, float4: 1,
  float: 2, double: 2, 'double precision': 2, float8: 2,
  float32: 1, float64: 2,
};

export function shapeOf(type: string): TypeShape {
  // ClickHouse wraps a type for nullability and dictionary encoding; the value is the inner type.
  const wrapper = /^(?:nullable|lowcardinality)\s*\((.*)\)$/;
  let t = normType(type);
  while (wrapper.test(t)) t = t.replace(wrapper, '$1').trim();
  const base = t.replace(/\(.*$/, '').trim();
  const args = (t.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((a) => a.trim());
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (TEXT_TYPES.has(base)) {
    return { kind: 'text', size: args[0] === 'max' ? undefined : num(args[0]) };
  }
  if (base in INT_RANK) return { kind: 'int', size: INT_RANK[base] };
  if (/^(decimal|numeric|number|money)$/.test(base)) return { kind: 'decimal', size: num(args[0]), scale: num(args[1]) ?? 0 };
  if (base in FLOAT_RANK) return { kind: 'float', size: FLOAT_RANK[base] };
  if (base === 'date') return { kind: 'date' };
  if (/^(timestamptz|datetimeoffset)$/.test(base) || /with time zone/.test(t)) return { kind: 'datetimetz' };
  if (/^(timestamp|datetime|datetime2|smalldatetime)/.test(base)) return { kind: 'datetime' };
  if (/^(bool|boolean|bit)$/.test(base)) return { kind: 'bool' };
  return { kind: 'other' };
}

/**
 * Whether two types are the same kind (text and text, integer and integer, …),
 * so a dialect can convert between them without spelling out the cast. Unknown
 * kinds never match.
 */
export function sameTypeKind(a: string, b: string): boolean {
  const x = shapeOf(a).kind;
  return x !== 'other' && x === shapeOf(b).kind;
}
