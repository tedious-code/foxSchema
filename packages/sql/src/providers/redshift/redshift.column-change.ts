/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on Redshift: a rename in place, and a type change only where
 * Redshift has one — making a VARCHAR longer. Anything else is refused with
 * the reason, never SQL that fails there.
 */
import type { ColumnChangeContext, ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'redshift');
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));

/** Redshift's VARCHAR(MAX). */
const VARCHAR_MAX = 65535;

/** The length of a VARCHAR type, or undefined for any other type. */
export function redshiftVarcharLength(type: string): number | undefined {
  // Split by hand rather than with one pattern: name, then an optional "(n)".
  const t = type.trim().toLowerCase().replace(/\s+/g, ' ');
  const open = t.indexOf('(');
  const name = (open < 0 ? t : t.slice(0, open)).trim();
  if (!['character varying', 'varchar', 'nvarchar', 'text'].includes(name)) return undefined;
  // A bare VARCHAR, and TEXT, are VARCHAR(256) on Redshift.
  if (open < 0) return 256;
  if (!t.endsWith(')')) return undefined;
  const arg = t.slice(open + 1, -1).trim();
  if (arg === 'max') return VARCHAR_MAX;
  return /^\d+$/.test(arg) ? Number(arg) : undefined;
}

export const redshiftColumnChange: ColumnChangeDialect = {
  triggers: false,
  foreignKeyTypesMustMatch: false,
  viewsBlockTypeChange: false,

  refuse: (ctx, { typeChanged }) => {
    if (!typeChanged) return undefined;
    const from = redshiftVarcharLength(ctx.column.type);
    const to = redshiftVarcharLength(ctx.targetType);
    if (from !== undefined && to !== undefined && to > from) return undefined;
    return (
      `Redshift changes a column’s type in place only to make a VARCHAR longer, and ${ctx.column.type} → ` +
      `${ctx.targetType} is not that. Add a new column and copy into it, or recreate the table.`
    );
  },

  renameSteps: (ctx) => [
    {
      phase: 'add',
      title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
      rerunSafe: false,
      sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
      note: 'Instant. A late-binding view or stored SQL that names the column fails until it is changed.',
    },
  ],

  alterTypeSteps: (ctx) => [
    {
      phase: 'add',
      title: `Change ${ctx.column.name} to ${ctx.targetType}`,
      rerunSafe: true,
      sql: `ALTER TABLE ${table(ctx)} ALTER COLUMN ${q(ctx.column.name)} TYPE ${ctx.targetType};`,
      note:
        'Lengthens the VARCHAR in place. Redshift runs it outside a transaction block, and refuses it on a column ' +
        'encoded BYTEDICT, RUNLENGTH, TEXT255 or TEXT32K.',
    },
  ],
};
