/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on ClickHouse: both changes in place. ClickHouse will not
 * rename or retype a column in the sorting key, so that is refused up front.
 */
import type { ColumnChangeContext, ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'clickhouse');
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));
const escapeWord = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the sorting key names the column: a plain name, or inside an expression such as `cityHash64(id)`. */
function inSortingKey(ctx: ColumnChangeContext): boolean {
  const name = ctx.column.name;
  const word = new RegExp(`(^|[^A-Za-z0-9_])\`?${escapeWord(name)}\`?([^A-Za-z0-9_]|$)`);
  return (
    ctx.primaryKey.some((k) => k === name) ||
    ctx.sortingKey.some((expr) => expr === name || word.test(expr))
  );
}

/**
 * The new type as ClickHouse must be told it. A nullable column is
 * `Nullable(T)`; Fox shows it as T with nullable set, so a type typed in
 * without the wrapper gets it back, or every NULL would fail to convert.
 */
export function clickHouseTargetType(ctx: ColumnChangeContext): string {
  const t = ctx.targetType.trim();
  if (!ctx.column.nullable || /nullable\s*\(/i.test(t)) return t;
  // Nullable goes inside LowCardinality: LowCardinality(Nullable(String)).
  const low = t.match(/^lowcardinality\s*\((.*)\)$/i);
  return low ? `LowCardinality(Nullable(${low[1]!.trim()}))` : `Nullable(${t})`;
}

export const clickHouseColumnChange: ColumnChangeDialect = {
  triggers: false,
  foreignKeyTypesMustMatch: false,
  viewsBlockTypeChange: false,

  refuse: (ctx) =>
    inSortingKey(ctx)
      ? `${ctx.column.name} is in ${ctx.table}’s sorting key (ORDER BY / PRIMARY KEY), and ClickHouse will not ` +
        'rename it or change its type. Recreate the table with the new column instead.'
      : undefined,

  renameSteps: (ctx) => [
    {
      phase: 'add',
      title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
      rerunSafe: false,
      sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
      note:
        'A metadata change. Materialized views and queries that name the column do not follow it. ClickHouse has ' +
        'no transactions, so this applies on its own.',
    },
  ],

  alterTypeSteps: (ctx) => [
    {
      phase: 'add',
      title: `Change ${ctx.column.name} to ${clickHouseTargetType(ctx)}`,
      rerunSafe: true,
      sql: `ALTER TABLE ${table(ctx)} MODIFY COLUMN ${q(ctx.column.name)} ${clickHouseTargetType(ctx)};`,
      note:
        'Rewrites the column in every data part as a mutation; the default and comment stay. A value that does ' +
        'not convert stops the mutation, which then has to be killed (KILL MUTATION) before the table takes ' +
        'another change. ClickHouse has no transactions.',
    },
  ],
};
