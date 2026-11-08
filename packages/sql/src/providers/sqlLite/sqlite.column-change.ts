/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on SQLite: a rename only. SQLite has no ALTER COLUMN; a type
 * change needs the table rebuilt, which is refused here with that reason.
 */
import type { ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'sqlite');

export const sqliteColumnChange: ColumnChangeDialect = {
  triggers: false,
  foreignKeyTypesMustMatch: false,
  viewsBlockTypeChange: false,

  refuse: (_ctx, { typeChanged }) =>
    typeChanged
      ? 'SQLite cannot change a column’s type in place: it needs the table rebuilt (a new table, a copy, a swap), ' +
        'which is not covered here yet. A rename on its own works.'
      : undefined,

  renameSteps: (ctx) => [
    {
      phase: 'add',
      title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
      rerunSafe: false,
      sql: `ALTER TABLE ${q(ctx.table)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
      note:
        'Needs SQLite 3.25 or later. SQLite also rewrites the indexes, triggers and views that name the column, ' +
        'so they keep working; application SQL does not change.',
    },
  ],

  // Never reached: `refuse` stops a type change first.
  alterTypeSteps: () => [],
};
