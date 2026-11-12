/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop Type on Db2: distinct, row and structured types. Db2 has no in-place change
 * that takes a column off such a type, so the plan drops a type nothing uses
 * and otherwise lists the columns to change first. The schema is folded to
 * upper case, as the catalog stores an unquoted one.
 */
import type { TypeDropDialect } from '../../modules/utilities/type-drop.types.js';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** SYSCAT.DATATYPES METATYPE `T` is a distinct type: a built-in type under another name. */
const KIND_ALIAS = new Set(['T']);

export const db2TypeDrop: TypeDropDialect = {
  canKeepValuesCheck: false,

  kindOf: (type) => (KIND_ALIAS.has((type.userType?.metaType ?? '').trim().toUpperCase()) ? 'alias' : 'composite'),

  suggestReplacement: () => undefined,

  convertColumnSteps: () => {
    throw new Error('Db2 has no in-place change from this kind of type.');
  },

  dropStep: ({ schema, typeName }) => ({
    phase: 'finish',
    title: `Drop ${typeName}`,
    rerunSafe: false,
    sql: `DROP TYPE ${schema ? `${q(schema.toUpperCase())}.` : ''}${q(typeName)};`,
    note: 'Db2 refuses while a column or another object still depends on the type, and drops nothing.',
  }),
};
