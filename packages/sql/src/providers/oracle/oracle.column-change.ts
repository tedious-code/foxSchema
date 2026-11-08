/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on Oracle: both changes in place. Names are quoted as the
 * catalog stores them; the schema is folded to upper case, the way Oracle
 * keeps an unquoted user name.
 */
import type { ColumnChangeContext, ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'oracle');
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema.toUpperCase())}.${q(ctx.table)}` : q(ctx.table));

export const oracleColumnChange: ColumnChangeDialect = {
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
        'Instant, and committed at once (Oracle DDL). Indexes and constraints follow; views, triggers and PL/SQL ' +
        'that name the column become invalid and fail until they are changed.',
    },
  ],

  alterTypeSteps: (ctx) => [
    {
      phase: 'add',
      title: `Change ${ctx.column.name} to ${ctx.targetType}`,
      rerunSafe: true,
      // No NULL / NOT NULL: MODIFY keeps what it does not restate, and restating
      // NOT NULL on a NOT NULL column is ORA-01442.
      sql: `ALTER TABLE ${table(ctx)} MODIFY (${q(ctx.column.name)} ${ctx.targetType});`,
      note:
        'NOT NULL, the default and the comment stay. Oracle changes a length or precision in place and refuses to ' +
        'go below the longest value (ORA-01441); a change to another kind of type, such as text to number or to a ' +
        'LOB, needs the column empty (ORA-01439). Views on the table are marked invalid and recompile when next ' +
        'used. Committed at once.',
    },
  ],
};
