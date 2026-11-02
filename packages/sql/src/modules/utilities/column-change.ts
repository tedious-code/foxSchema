/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Safe column change: what renaming a column or changing its type touches,
 * and the SQL to do it the safe way, step by step, for review. Fox runs none
 * of it (docs/plans/2026-11-01-safe-column-change.md).
 *
 * A rename alone is one step: every engine here renames in place, instantly.
 * A type change adds a new column, keeps it in step with a trigger where the
 * engine has them, copies in batches, checks, switches the names over in one
 * go, and drops the old column last. This facade checks the input and finds
 * the impact; each dialect's provider file writes its SQL.
 */
import type { ColumnInfo, TableSchema } from '../../interfaces/schema.interface.js';
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';
import { resolveColumnChange } from './column-change.registry.js';
import type {
  ColumnChangeContext,
  ColumnChangeImpact,
  ColumnChangeInput,
  ColumnChangePlan,
} from './column-change.types.js';

export const DEFAULT_COLUMN_CHANGE_BATCH = 10_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const engineName = (dialect: string) => PROVIDER_SETTINGS[dialect.toLowerCase()]?.label ?? dialect;
const has = (cols: readonly string[], name: string) => cols.some((c) => same(c, name));
const normType = (type: string) => type.trim().replace(/\s+/g, ' ').toLowerCase();
const wordIn = (text: string, word: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text);

export function planColumnChange(input: ColumnChangeInput): ColumnChangePlan {
  const dialect = resolveColumnChange(input.dialect);
  if (!dialect) return { ok: false, error: `Safe column change is not available for ${engineName(input.dialect)} yet.` };

  const column = input.table.columns.find((c) => same(c.name, input.column));
  if (!column) return { ok: false, error: `${input.table.name} has no column ${input.column}.` };

  const targetName = input.change.newName?.trim() || column.name;
  const targetType = input.change.newType?.trim() || column.type;
  const renamed = targetName !== column.name;
  const typeChanged = normType(targetType) !== normType(column.type);
  const impact = findImpact(input, column, typeChanged ? targetType : undefined);

  if (!renamed && !typeChanged) return { ok: false, error: 'Nothing to change: the name and the type are as they are now.', impact };
  if (renamed && input.table.columns.some((c) => c !== column && same(c.name, targetName))) {
    return { ok: false, error: `${input.table.name} already has a column ${targetName}.`, impact };
  }
  if (impact.inPrimaryKey) {
    return { ok: false, error: 'Changing a primary key column is not covered yet.', impact };
  }
  if (impact.inboundForeignKeys.length > 0) {
    const from = [...new Set(impact.inboundForeignKeys.map((f) => f.table))].join(', ');
    return { ok: false, error: `Other tables' foreign keys point at this column (${from}). Changing a referenced column is not covered yet.`, impact };
  }

  const warnings: string[] = [];
  if (impact.views.length > 0) {
    warnings.push(`Views that may use the column: ${impact.views.join(', ')}. Check them after the change.`);
  }
  if (impact.triggers.length > 0) {
    warnings.push(`Triggers on the table that may use the column: ${impact.triggers.map((t) => t.name).join(', ')}.`);
  }

  const primaryKey = input.table.primaryKey?.columns?.length
    ? input.table.primaryKey.columns
    : input.table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const ctx: ColumnChangeContext = {
    schema: input.schema,
    table: input.table.name,
    column,
    targetName,
    targetType,
    newColumn: `${targetName}__new`,
    oldColumn: `${column.name}__old`,
    primaryKey,
    indexes: impact.indexes,
    outboundForeignKeys: impact.outboundForeignKeys,
    batchSize: Math.max(1, Math.floor(input.batchSize ?? DEFAULT_COLUMN_CHANGE_BATCH)),
    typeChanged,
  };

  if (!typeChanged) return { ok: true, impact, steps: dialect.renameSteps(ctx), warnings };

  if (column.identity) return { ok: false, error: 'An identity column cannot be copied this way.', impact };
  if (primaryKey.length === 0) {
    return { ok: false, error: 'The table needs a primary key: the copy works through it in batches.', impact };
  }
  for (const name of [ctx.newColumn, ctx.oldColumn]) {
    if (input.table.columns.some((c) => same(c.name, name))) {
      return { ok: false, error: `${input.table.name} already has a column ${name}, which this plan needs for a while.`, impact };
    }
  }
  if (dialect.foreignKeyTypesMustMatch) {
    for (const fk of impact.outboundForeignKeys) {
      const parent = input.tables.find((t) => same(t.name, fk.referencedTable));
      const position = fk.columns.findIndex((c) => same(c, column.name));
      const parentColumn = parent?.columns.find((c) => same(c.name, fk.referencedColumns[position] ?? ''));
      if (parentColumn && normType(parentColumn.type) !== normType(targetType)) {
        return {
          ok: false,
          error:
            `${column.name} has a foreign key to ${fk.referencedTable}.${parentColumn.name} (${parentColumn.type}). ` +
            `${engineName(input.dialect)} needs both sides of a foreign key to have the same type: change ${fk.referencedTable}.${parentColumn.name} first, or keep ${parentColumn.type}.`,
          impact,
        };
      }
    }
  }
  if (impact.lossy) warnings.push(impact.lossy);
  if (!dialect.triggers) {
    warnings.push('This engine has no triggers here: writes during the copy are caught by running the copy once more before the switch-over.');
  }
  return { ok: true, impact, steps: dialect.rebuildSteps(ctx), warnings };
}

function findImpact(input: ColumnChangeInput, column: ColumnInfo, newType: string | undefined): ColumnChangeImpact {
  const { table } = input;
  const name = column.name;
  const inPrimaryKey = column.primaryKey || has(table.primaryKey?.columns ?? [], name);
  const indexes = (table.indices ?? []).filter((i) => has(i.columns, name));
  const outboundForeignKeys = (table.foreignKeys ?? []).filter((fk) => has(fk.columns, name));
  const inboundForeignKeys = input.tables
    .filter((t) => t !== table && t.objectType !== 'VIEW')
    .flatMap((t) =>
      (t.foreignKeys ?? [])
        .filter(
          (fk) =>
            same(fk.referencedTable, table.name) &&
            (!fk.referencedSchema || !input.schema || same(fk.referencedSchema, input.schema)) &&
            has(fk.referencedColumns, name)
        )
        .map((foreignKey) => ({ table: t.name, foreignKey }))
    );
  const triggers = (table.triggers ?? []).filter((t) => !t.definition || wordIn(t.definition, name));
  const views = input.tables
    .filter((t: TableSchema) => t.objectType === 'VIEW' && t.definition && wordIn(t.definition, table.name) && wordIn(t.definition, name))
    .map((t) => t.name);
  return {
    inPrimaryKey,
    indexes,
    outboundForeignKeys,
    inboundForeignKeys,
    triggers,
    views,
    lossy: newType ? lossyConversion(column.type, newType) : undefined,
  };
}

interface TypeShape {
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
};

function shapeOf(type: string): TypeShape {
  const t = normType(type);
  const base = t.replace(/\(.*$/, '').trim();
  const args = (t.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((a) => a.trim());
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (TEXT_TYPES.has(base)) {
    return { kind: 'text', size: args[0] === 'max' ? undefined : num(args[0]) };
  }
  if (base in INT_RANK) return { kind: 'int', size: INT_RANK[base] };
  if (/^(decimal|numeric|number|money)$/.test(base)) return { kind: 'decimal', size: num(args[0]), scale: num(args[1]) ?? 0 };
  if (/^(float|double|double precision|real|float4|float8)$/.test(base)) return { kind: 'float' };
  if (base === 'date') return { kind: 'date' };
  if (/^(timestamptz|datetimeoffset)$/.test(base) || /with time zone/.test(t)) return { kind: 'datetimetz' };
  if (/^(timestamp|datetime|datetime2|smalldatetime)/.test(base)) return { kind: 'datetime' };
  if (/^(bool|boolean|bit)$/.test(base)) return { kind: 'bool' };
  return { kind: 'other' };
}

/** Why moving values from `from` to `to` can lose data or fail, or undefined when it should not. */
export function lossyConversion(from: string, to: string): string | undefined {
  const a = shapeOf(from);
  const b = shapeOf(to);
  if (b.kind === 'bool' && a.kind !== 'bool') return `Only values that read as true or false convert to ${to}.`;
  if (a.kind === 'text' && b.kind !== 'text') return `Text that is not a valid ${to} stops the copy with an error.`;
  if (a.kind === 'text' && b.kind === 'text' && b.size !== undefined && (a.size === undefined || b.size < a.size)) {
    return `Values longer than ${b.size} characters do not fit ${to}.`;
  }
  if (a.kind === 'int' && b.kind === 'int' && (b.size ?? 0) < (a.size ?? 0)) return `Numbers outside ${to}'s range do not fit.`;
  if (a.kind === 'float' && (b.kind === 'int' || b.kind === 'decimal')) return `Fractions are rounded to fit ${to}.`;
  if (a.kind === 'decimal' && b.kind === 'int' && (a.scale ?? 0) > 0) return `Fractions are rounded to fit ${to}.`;
  if (a.kind === 'decimal' && b.kind === 'decimal') {
    if ((b.scale ?? 0) < (a.scale ?? 0)) return `Fewer decimal places: values are rounded to fit ${to}.`;
    if (b.size !== undefined && a.size !== undefined && b.size - (b.scale ?? 0) < a.size - (a.scale ?? 0)) {
      return `Fewer digits before the decimal point: large values do not fit ${to}.`;
    }
  }
  if (a.kind === 'datetimetz' && b.kind === 'datetime') return 'The time zone offset is dropped.';
  if ((a.kind === 'datetime' || a.kind === 'datetimetz') && b.kind === 'date') return 'The time of day is dropped.';
  const widening =
    (a.kind === 'int' && (b.kind === 'decimal' || b.kind === 'float')) ||
    (a.kind === 'date' && (b.kind === 'datetime' || b.kind === 'datetimetz')) ||
    (a.kind === 'datetime' && b.kind === 'datetimetz');
  if (a.kind !== 'other' && b.kind !== 'other' && a.kind !== b.kind && b.kind !== 'text' && !widening) {
    return `Converting ${from} to ${to} may fail on some values.`;
  }
  return undefined;
}
