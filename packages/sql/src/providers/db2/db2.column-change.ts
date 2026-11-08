/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on Db2: both changes in place. The schema is folded to upper
 * case and the table quoted exactly as the catalog gave it (DIALECTS.md, Db2).
 */
import type { ColumnChangeContext, ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'db2');
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema.toUpperCase())}.${q(ctx.table)}` : q(ctx.table));

export const db2ColumnChange: ColumnChangeDialect = {
  triggers: false,
  foreignKeyTypesMustMatch: false,
  viewsBlockTypeChange: false,

  renameSteps: (ctx) => [
    {
      phase: 'add',
      title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
      rerunSafe: false,
      sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
      note:
        'Instant: only the catalog changes, and indexes and keys follow. Views, triggers and routines that name ' +
        'the column are marked invalid and fail until they are changed.',
    },
  ],

  alterTypeSteps: (ctx) => [
    {
      phase: 'add',
      title: `Change ${ctx.column.name} to ${ctx.targetType}`,
      rerunSafe: true,
      sql: `ALTER TABLE ${table(ctx)} ALTER COLUMN ${q(ctx.column.name)} SET DATA TYPE ${ctx.targetType};`,
      note:
        'NOT NULL and the default stay: SET DATA TYPE changes only the type. A value that does not fit stops it. ' +
        'Some changes leave the table reorg-pending, so the next step reorganises it.',
    },
    {
      phase: 'add',
      title: `Reorganise ${ctx.table}`,
      rerunSafe: true,
      // ADMIN_CMD: plain REORG TABLE is a CLP command, not SQL.
      sql: `CALL SYSPROC.ADMIN_CMD('REORG TABLE ${table(ctx).replace(/'/g, "''")}');`,
      note:
        'Reads still work on a reorg-pending table, but every write fails with SQL0668N reason 7 until it is ' +
        'reorganised. REORG rewrites the table and blocks writes while it runs; harmless when nothing was pending.',
    },
  ],
};
