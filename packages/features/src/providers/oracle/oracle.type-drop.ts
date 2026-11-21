/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on Oracle: object and collection types. Oracle has no in-place change
 * that takes a column off such a type, so the plan drops a type nothing uses
 * and otherwise lists the columns to change first. The schema is folded to
 * upper case, as the catalog stores an unquoted one.
 */
import type { TypeDropDialect } from '../../modules/utilities/type-drop.types.js';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export const oracleTypeDrop: TypeDropDialect = {
  canKeepValuesCheck: false,

  // Object and collection types only: none is a plain alias of a built-in type.
  kindOf: () => 'composite',

  suggestReplacement: () => undefined,

  convertColumnSteps: () => {
    throw new Error('Oracle has no in-place change from this kind of type.');
  },

  dropStep: ({ schema, typeName }) => ({
    phase: 'finish',
    title: `Drop ${typeName}`,
    rerunSafe: false,
    sql: `DROP TYPE ${schema ? `${q(schema.toUpperCase())}.` : ''}${q(typeName)};`,
    note: 'Oracle refuses while a column or another object still depends on the type, and drops nothing.',
  }),
};
