/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Types for the safe column change plan (docs/plans/2026-11-01-safe-column-change.md).
 */
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableSchema, TriggerInfo } from '../../interfaces/schema.interface.js';

/** Rename, change type, or both. At least one must differ from the column as it is. */
export interface ColumnChange {
  newName?: string;
  newType?: string;
}

export interface ColumnChangeInput {
  dialect: string;
  /** The schema (or database, on MySQL) the table lives in, as the catalog names it. */
  schema?: string;
  /** The table being changed, as loaded from the schema. */
  table: TableSchema;
  /** Every table and view of the schema: inbound foreign keys and views are found here. */
  tables: TableSchema[];
  column: string;
  change: ColumnChange;
  /** Rows per copy batch. Default 10,000. */
  batchSize?: number;
}

export interface InboundForeignKey {
  table: string;
  foreignKey: ForeignKeyInfo;
}

/**
 * One line of a dependent object's definition that names the column.
 *
 * The engine renames a column; it does not rewrite the SQL inside a view or a
 * routine that reads it. Naming the object is not enough to act on — somebody
 * then has to find the lines — so the lines come with it.
 */
export interface ColumnReferenceLine {
  /** 1-based, the way an editor numbers it. */
  line: number;
  /** The line as written, without its trailing whitespace. */
  text: string;
  /** Where the name sits in `text`, as [start, end) pairs, for highlighting. */
  matches: Array<{ start: number; end: number }>;
  /** `text` with every match replaced by the new name. Absent unless renaming. */
  renamed?: string;
}

/** A view, routine or trigger whose definition names the column. */
export interface ColumnDependent {
  name: string;
  objectType: 'VIEW' | 'FUNCTION' | 'PROCEDURE' | 'TRIGGER';
  /** The definition as the catalog gave it, for a read-only editor. */
  definition: string;
  /** The lines that name the column, in the order they appear. */
  references: ColumnReferenceLine[];
}

/** What the change touches, from the schema Fox already reads. */
export interface ColumnChangeImpact {
  inPrimaryKey: boolean;
  /** Indexes and unique constraints that include the column. */
  indexes: IndexInfo[];
  /** Foreign keys from this column to another table. */
  outboundForeignKeys: ForeignKeyInfo[];
  /** Foreign keys in other tables that point at this column. */
  inboundForeignKeys: InboundForeignKey[];
  triggers: TriggerInfo[];
  /** Views whose definition mentions the column: a text match, so "may use". */
  views: string[];
  /** Functions whose definition mentions the table and column. */
  functions: string[];
  /** Procedures whose definition mentions the table and column. */
  procedures: string[];
  /**
   * The same views, functions, procedures and triggers, with the lines that
   * name the column. The name lists above stay as they are — the warnings and
   * the summary read them — and this carries what a reader needs to act.
   * Empty for an object whose definition the catalog did not give us.
   */
  dependents: ColumnDependent[];
  /** Why the type change can lose data or fail on some values, when it can. */
  lossy?: string;
}

/** Add the nullable column, copy rows, then move constraints and switch over. */
export type ColumnChangePhase = 'add' | 'copy' | 'finish';

export interface ColumnChangeProgressSql {
  totalSql: string;
  remainingSql: string;
  /** One batch UPDATE. The app loops this until remaining is 0, and shows progress. */
  patchSql: string;
}

export interface ColumnChangeStep {
  title: string;
  /** Running it twice does no harm (the batched copy, the check). */
  rerunSafe: boolean;
  sql: string;
  note?: string;
  /** Which of the three parts this step belongs to. A rename-alone is `add`. */
  phase: ColumnChangePhase;
}

export type ColumnChangePlan =
  | {
      ok: true;
      impact: ColumnChangeImpact;
      steps: ColumnChangeStep[];
      warnings: string[];
      /** Present for a type change: COUNT(*) and rows still to copy. */
      progress?: ColumnChangeProgressSql;
    }
  | { ok: false; error: string; impact?: ColumnChangeImpact };

/** What a dialect's step builder is given, once the facade has checked the input. */
export interface ColumnChangeContext {
  schema?: string;
  table: string;
  column: ColumnInfo;
  targetName: string;
  targetType: string;
  /** The new column while both exist: `<target>__new`. */
  newColumn: string;
  /** The old column after the switch-over, until it is dropped: `<column>__old`. */
  oldColumn: string;
  primaryKey: string[];
  indexes: IndexInfo[];
  outboundForeignKeys: ForeignKeyInfo[];
  /** Table triggers whose definition mentions the column. */
  triggers: TriggerInfo[];
  batchSize: number;
  typeChanged: boolean;
}

export interface ColumnChangeDialect {
  /** Steps for a rename alone: the engine renames in place, instantly. */
  renameSteps(ctx: ColumnChangeContext): ColumnChangeStep[];
  /** Steps for a type change (with or without a rename): new column, copy, switch over. */
  rebuildSteps(ctx: ColumnChangeContext): ColumnChangeStep[];
  /** COUNT(*) and rows still waiting to copy, for the copy-part progress. */
  progressSql(ctx: ColumnChangeContext): ColumnChangeProgressSql;
  /** Whether the engine can keep the new column in step with a trigger during the copy. */
  triggers: boolean;
  /**
   * Whether both sides of a foreign key must have the same type (MySQL, SQL
   * Server). PostgreSQL only needs comparable types, so int8 may reference int4.
   */
  foreignKeyTypesMustMatch: boolean;
}
