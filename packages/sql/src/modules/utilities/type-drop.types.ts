/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Types for the Drop Type plan: what uses a user-defined type, and the steps
 * that move its columns onto a built-in type and then drop it.
 */
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import type { ColumnChangeStep, ColumnDependent } from './column-change.types.js';

/** What a user-defined type is, as far as dropping it goes. */
export type UserTypeKind =
  /** A fixed list of values (PostgreSQL, CockroachDB, DuckDB). */
  | 'enum'
  /** A built-in type with rules attached (PostgreSQL DOMAIN). */
  | 'domain'
  /** A built-in type under another name (SQL Server alias type, Db2 distinct type). */
  | 'alias'
  /** Has fields or elements of its own (Oracle object / collection, Db2 row / structured). */
  | 'composite';

export interface TypeDropInput {
  dialect: string;
  /** The schema the type lives in, as the catalog names it. */
  schema?: string;
  /** The type to drop: an entry with `objectType: 'TYPE'` from the loaded schema. */
  type: TableSchema;
  /** Everything else in the schema: its columns, routines, views and other types are searched. */
  tables: TableSchema[];
  /** What a column of this type becomes. Left out: the engine's suggestion. */
  replacement?: string;
  /** Enum only: keep the allowed values as a CHECK constraint on each column. */
  keepValuesCheck?: boolean;
}

/** One table column declared with the type. */
export interface TypeColumnUse {
  table: string;
  column: ColumnInfo;
  /** The column is an array of the type (PostgreSQL `status order_status[]`). */
  array: boolean;
}

/** What dropping the type touches, from the schema Fox already reads. */
export interface TypeDropImpact {
  kind: UserTypeKind;
  /** An enum's values, in order. */
  values?: string[];
  /** The built-in type under a domain or an alias. */
  baseType?: string;
  /** Columns declared with the type. Each must move to another type before the drop. */
  columns: TypeColumnUse[];
  /** Other user-defined types built on this one. */
  types: string[];
  /**
   * Views, routines and triggers whose text names the type, with the lines.
   * A text match, so "may use": a name in a comment or a string counts.
   */
  dependents: ColumnDependent[];
  /** What Fox would turn the columns into, when the engine can do that in place. */
  suggestedReplacement?: string;
  /** Whether the engine can add the enum's values back as a CHECK constraint. */
  canKeepValuesCheck: boolean;
}

export type TypeDropPlan =
  | { ok: true; impact: TypeDropImpact; steps: ColumnChangeStep[]; warnings: string[] }
  | { ok: false; error: string; impact?: TypeDropImpact };

/** What a dialect's step builder is given for one column of the type. */
export interface TypeDropColumnContext {
  schema?: string;
  typeName: string;
  kind: UserTypeKind;
  values: string[];
  table: TableSchema;
  column: ColumnInfo;
  array: boolean;
  /** The type the column becomes (without `[]`; the builder adds it for an array). */
  replacement: string;
  keepValuesCheck: boolean;
  /** Every table of the schema, for builders that plan through the column-change planner. */
  tables: TableSchema[];
}

export interface TypeDropDialect {
  /** What kind of type this is on this engine. */
  kindOf(type: TableSchema): UserTypeKind;
  /**
   * Whether a column's reported type is this type. Left out: by name, schema
   * and quoting ignored (`"shop"."order_status"[]` is `order_status`). DuckDB
   * reports an enum column by its values, so it matches on those.
   */
  columnUses?(columnType: string, type: TableSchema): { uses: boolean; array: boolean };
  /** What a column of this type can become in place, or undefined when the engine has no such change. */
  suggestReplacement(type: TableSchema, kind: UserTypeKind): string | undefined;
  /** Whether a CHECK constraint can be added to an existing table here. */
  canKeepValuesCheck: boolean;
  /**
   * Steps that move one column onto `replacement`. May throw with the reason
   * a column cannot be moved (a key other tables reference, say): the plan
   * then refuses whole, naming the column.
   */
  convertColumnSteps(ctx: TypeDropColumnContext): ColumnChangeStep[];
  /** The step that drops the type. Never CASCADE: a dependent Fox did not see stops it. */
  dropStep(input: { schema?: string; typeName: string; kind: UserTypeKind }): ColumnChangeStep;
}
