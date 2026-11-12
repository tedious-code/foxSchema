/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on SQL Server: alias types (`CREATE TYPE … FROM varchar(20)`).
 * A column moves to the built-in type through the same in-place change Rename
 * Column makes, which takes the column's indexes, keys and default off and
 * puts them back in one transaction.
 */
import { planColumnChange } from '../../modules/utilities/column-change.js';
import type { TypeDropDialect } from '../../modules/utilities/type-drop.types.js';

const q = (name: string) => `[${name.replace(/]/g, ']]')}]`;

export function sqlServerFamilyTypeDrop(dialect: string): TypeDropDialect {
  return {
    canKeepValuesCheck: false,

    kindOf: () => 'alias',

    suggestReplacement: (type) => type.userType?.sourceType?.trim() || undefined,

    convertColumnSteps: (ctx) => {
      const plan = planColumnChange({
        dialect,
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
      sql: `DROP TYPE ${q(schema || 'dbo')}.${q(typeName)};`,
      note:
        'SQL Server refuses while a column, a parameter of a procedure or function, or a computed column still uses the type, and drops nothing.',
    }),
  };
}

export const sqlServerTypeDrop = sqlServerFamilyTypeDrop('sqlserver');
