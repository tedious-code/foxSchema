/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type: what a user-defined type is used by, and the SQL to drop it, as
 * steps to review. A database refuses to drop a type a column is declared
 * with, so the plan first moves each such column onto a built-in type — an
 * enum's values stay, as text, with a CHECK holding the list if asked — and
 * drops the type last.
 *
 * It never writes CASCADE. On PostgreSQL `DROP TYPE … CASCADE` drops every
 * column of the type, data included, without another word. Without it, a
 * dependent this plan did not see makes the database refuse, and nothing is
 * lost. This facade checks the input and finds the uses; each dialect's
 * provider file writes its SQL.
 */
import type { TableSchema } from '../../interfaces/schema.interface.js';
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';
import { columnReferenceLines } from './column-change.js';
import type { ColumnChangeStep, ColumnDependent } from './column-change.types.js';
import { shapeOf } from './column-type-shape.js';
import { resolveTypeDrop } from './type-drop.registry.js';
import type {
  TypeColumnUse,
  TypeDropDialect,
  TypeDropImpact,
  TypeDropInput,
  TypeDropPlan,
} from './type-drop.types.js';
import { referencesType } from './type-name-match.js';

const engineName = (dialect: string) => PROVIDER_SETTINGS[dialect.toLowerCase()]?.label ?? dialect;
const list = (names: string[]) => names.join(', ');

const DEPENDENT_KINDS: Array<ColumnDependent['objectType']> = ['VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER'];

function findImpact(input: TypeDropInput, dialect: TypeDropDialect): TypeDropImpact {
  const { type, schema } = input;
  const kind = dialect.kindOf(type);
  const uses = (columnType: string) =>
    dialect.columnUses ? dialect.columnUses(columnType, type) : referencesType(columnType, type.name, schema);

  const columns: TypeColumnUse[] = [];
  for (const t of input.tables) {
    if (t.objectType !== 'TABLE' && t.objectType !== 'MQT') continue;
    for (const column of t.columns) {
      const hit = uses(column.type);
      if (hit.uses) columns.push({ table: t.name, column, array: hit.array });
    }
  }

  const types = input.tables
    .filter((t) => t.objectType === 'TYPE' && t !== type && t.name !== type.name)
    .filter(
      (t) =>
        referencesType(t.userType?.sourceType, type.name, schema).uses ||
        (t.userType?.attributes ?? []).some((a) => referencesType(a.type, type.name, schema).uses)
    )
    .map((t) => t.name);

  const dependents: ColumnDependent[] = [];
  for (const t of input.tables) {
    const objectType = t.objectType as ColumnDependent['objectType'];
    if (!DEPENDENT_KINDS.includes(objectType)) continue;
    const references = columnReferenceLines(t.definition ?? '', type.name);
    // A routine can take or return the type without its body naming it.
    const inSignature = (t.parameters ?? []).some((p) => referencesType(p.type, type.name, schema).uses);
    if (references.length === 0 && !inSignature) continue;
    dependents.push({ name: t.name, objectType, definition: t.definition ?? '', references });
  }
  for (const t of input.tables) {
    for (const trigger of t.triggers ?? []) {
      const references = columnReferenceLines(trigger.definition ?? '', type.name);
      if (references.length === 0 || dependents.some((d) => d.objectType === 'TRIGGER' && d.name === trigger.name)) continue;
      dependents.push({ name: trigger.name, objectType: 'TRIGGER', definition: trigger.definition ?? '', references });
    }
  }

  const values = kind === 'enum' ? (type.userType?.attributes ?? []).map((a) => a.name) : undefined;
  return {
    kind,
    ...(values ? { values } : {}),
    ...(type.userType?.sourceType ? { baseType: type.userType.sourceType } : {}),
    columns,
    types,
    dependents,
    suggestedReplacement: dialect.suggestReplacement(type, kind),
    canKeepValuesCheck: kind === 'enum' && dialect.canKeepValuesCheck,
  };
}

/** Why a text type is too short for an enum's values, or undefined when it holds them. */
function tooShortFor(replacement: string, values: string[]): string | undefined {
  const shape = shapeOf(replacement);
  if (shape.kind !== 'text' || shape.size === undefined) return undefined;
  const longest = values.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length <= shape.size) return undefined;
  return `${replacement} is shorter than the longest value, '${longest}' (${longest.length} characters).`;
}

export function planTypeDrop(input: TypeDropInput): TypeDropPlan {
  const dialect = resolveTypeDrop(input.dialect);
  if (!dialect) {
    return { ok: false, error: `${engineName(input.dialect)} has no user-defined types for Fox to drop.` };
  }
  if (input.type.objectType !== 'TYPE') {
    return { ok: false, error: `${input.type.name} is not a user-defined type.` };
  }

  const impact = findImpact(input, dialect);
  const name = input.type.name;

  if (impact.types.length > 0) {
    return {
      ok: false,
      error: `Other types are built on ${name} (${list(impact.types)}). Drop or change them first.`,
      impact,
    };
  }

  // A routine whose parameters use the type is a dependency the database
  // enforces: the drop is refused while it exists. Refuse here, before any
  // column is changed, rather than stop on the last step with the columns
  // already moved. A name only in a body stays a warning: it may be a comment.
  const takers = input.tables
    .filter((t) => t.objectType === 'FUNCTION' || t.objectType === 'PROCEDURE')
    .filter((t) => (t.parameters ?? []).some((p) => referencesType(p.type, name, input.schema).uses))
    .map((t) => t.name);
  if (takers.length > 0) {
    const one = takers.length === 1;
    return {
      ok: false,
      error:
        `${list(takers)} ${one ? 'takes' : 'take'} ${name} as a parameter, and the database will not drop the type ` +
        `while ${one ? 'it exists' : 'they exist'}. Drop ${one ? 'it' : 'them'}, or change ${one ? 'its' : 'their'} ` +
        'parameters to another type, first.',
      impact,
    };
  }

  const replacement = (input.replacement ?? '').trim() || impact.suggestedReplacement;
  const usedBy = list(impact.columns.map((c) => `${c.table}.${c.column.name}`));
  if (impact.columns.length > 0) {
    if (!impact.suggestedReplacement || !replacement) {
      return {
        ok: false,
        error:
          `${impact.columns.length === 1 ? 'A column is' : `${impact.columns.length} columns are`} declared with ${name} (${usedBy}), ` +
          `and ${engineName(input.dialect)} has no in-place change from this kind of type. Change or drop ${impact.columns.length === 1 ? 'it' : 'them'} first.`,
        impact,
      };
    }
    if (referencesType(replacement, name, input.schema).uses) {
      return { ok: false, error: `The columns cannot stay ${name}: that is the type being dropped.`, impact };
    }
    const short = impact.values ? tooShortFor(replacement, impact.values) : undefined;
    if (short) return { ok: false, error: short, impact };
  }

  const keepValuesCheck = Boolean(input.keepValuesCheck) && impact.canKeepValuesCheck;
  const steps: ColumnChangeStep[] = [];
  for (const use of impact.columns) {
    const table = input.tables.find((t) => t.name === use.table && (t.objectType === 'TABLE' || t.objectType === 'MQT'));
    if (!table) continue;
    try {
      steps.push(
        ...dialect.convertColumnSteps({
          schema: input.schema,
          typeName: name,
          kind: impact.kind,
          values: impact.values ?? [],
          table,
          column: use.column,
          array: use.array,
          replacement: replacement!,
          keepValuesCheck,
          tables: input.tables,
        })
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `${use.table}.${use.column.name} cannot be moved off ${name}: ${reason}`, impact };
    }
  }
  steps.push(dialect.dropStep({ schema: input.schema, typeName: name, kind: impact.kind }));

  const warnings: string[] = [];
  const named = (objectType: ColumnDependent['objectType']) =>
    impact.dependents.filter((d) => d.objectType === objectType).map((d) => d.name);
  const mayUse = (label: string, names: string[]) => {
    if (names.length === 0) return;
    warnings.push(
      `${label} that may use the type: ${list(names)}. Change ${names.length === 1 ? 'it' : 'them'} first: the database refuses ` +
        'the drop while its definition depends on the type, and a body that only names it would fail when it next runs.'
    );
  };
  mayUse('Views', named('VIEW'));
  mayUse('Functions', named('FUNCTION'));
  mayUse('Procedures', named('PROCEDURE'));
  mayUse('Triggers', named('TRIGGER'));
  if (impact.kind === 'domain' && impact.columns.length > 0) {
    warnings.push(`A domain's own rules (NOT NULL, CHECK) go with it: the columns keep only ${replacement}.`);
  }
  if (impact.kind === 'enum' && impact.columns.length > 0 && !keepValuesCheck) {
    warnings.push(
      impact.canKeepValuesCheck
        ? 'Without the check constraint, the columns will accept any text, not only the values the type allowed.'
        : `The columns will accept any text afterwards: ${engineName(input.dialect)} cannot add a check constraint to an existing table.`
    );
  }
  return { ok: true, impact, steps, warnings };
}

/** The user-defined types of a loaded schema, by name. */
export function userTypesOf(tables: TableSchema[]): TableSchema[] {
  return tables.filter((t) => t.objectType === 'TYPE').sort((a, b) => a.name.localeCompare(b.name));
}
