/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on DuckDB: enums. DuckDB reports a column of an enum type by its
 * values (`ENUM('sad', 'ok')`), not by the type's name, so a column is matched
 * on the value list. Two enum types with the same values cannot be told apart
 * that way; the database still refuses the drop while a column really uses it.
 */
import { planColumnChange } from '../../modules/utilities/column-change.js';
import type { TypeDropDialect } from '../../modules/utilities/type-drop.types.js';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The values inside `enum('a', 'b''c')`, or undefined when the text is not an enum type. */
export function duckDbEnumValues(columnType: string): string[] | undefined {
  const text = columnType.trim();
  if (!/^enum\s*\(/i.test(text) || !text.endsWith(')')) return undefined;
  const inner = text.slice(text.indexOf('(') + 1, -1);
  const values: string[] = [];
  let current: string | undefined;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (current === undefined) {
      if (ch === "'") current = '';
      continue;
    }
    if (ch === "'") {
      if (inner[i + 1] === "'") {
        current += "'";
        i++;
      } else {
        values.push(current);
        current = undefined;
      }
      continue;
    }
    current += ch;
  }
  return values;
}

export const duckDbTypeDrop: TypeDropDialect = {
  canKeepValuesCheck: false,

  kindOf: () => 'enum',

  columnUses: (columnType, type) => {
    const values = duckDbEnumValues(columnType);
    const own = (type.userType?.attributes ?? []).map((a) => a.name);
    const uses = !!values && values.length === own.length && values.every((v, i) => v === own[i]);
    return { uses, array: false };
  },

  suggestReplacement: () => 'VARCHAR',

  convertColumnSteps: (ctx) => {
    const plan = planColumnChange({
      dialect: 'duckdb',
      schema: ctx.schema,
      table: ctx.table,
      tables: ctx.tables,
      column: ctx.column.name,
      change: { newType: ctx.replacement },
    });
    if (!plan.ok) throw new Error(plan.error);
    return plan.steps.map((step) => ({
      ...step,
      title: `Change ${ctx.table.name}.${ctx.column.name} to ${ctx.replacement}`,
    }));
  },

  dropStep: ({ schema, typeName }) => ({
    phase: 'finish',
    title: `Drop ${typeName}`,
    rerunSafe: false,
    sql: `DROP TYPE ${schema ? `${q(schema)}.` : ''}${q(typeName)};`,
    note: 'DuckDB refuses while a column still depends on the type, and drops nothing.',
  }),
};
