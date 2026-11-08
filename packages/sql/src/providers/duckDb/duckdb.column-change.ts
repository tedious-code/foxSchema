/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename Column on DuckDB: both changes in place.
 */
import type { ColumnChangeContext, ColumnChangeDialect } from '../../modules/utilities/column-change.types.js';
import { quoteSqlIdentifier } from '../../modules/sql-text/sql-template.js';

const q = (name: string) => quoteSqlIdentifier(name, 'duckdb');
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));

export const duckDbColumnChange: ColumnChangeDialect = {
  triggers: false,
  foreignKeyTypesMustMatch: false,
  viewsBlockTypeChange: false,

  // DuckDB refuses every ALTER on a table that has an index, a rename of an
  // unrelated column included ("Cannot alter entry … entries that depend on
  // it"). Fox does not know an index's columns here, so it cannot put one back:
  // the user drops and recreates them. A primary key does not count.
  refuse: (ctx) => {
    const names = ctx.tableIndexes.map((i) => i.name);
    if (names.length === 0) return undefined;
    return (
      `DuckDB will not change a column of ${ctx.table} while the table has ${names.length === 1 ? 'an index' : 'indexes'} ` +
      `(${names.join(', ')}). Drop ${names.length === 1 ? 'it' : 'them'}, make the change, then create ` +
      `${names.length === 1 ? 'it' : 'them'} again.`
    );
  },

  renameSteps: (ctx) => [
    {
      phase: 'add',
      title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
      rerunSafe: false,
      sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
      note: 'Instant. Views keep their SQL text, so one that names the column fails until it is recreated.',
    },
  ],

  alterTypeSteps: (ctx) => {
    const col = q(ctx.column.name);
    return [
      {
        phase: 'add',
        title: `Change ${ctx.column.name} to ${ctx.targetType}`,
        rerunSafe: true,
        sql: `ALTER TABLE ${table(ctx)} ALTER COLUMN ${col} TYPE ${ctx.targetType} USING CAST(${col} AS ${ctx.targetType});`,
        note:
          'Rewrites the column; NOT NULL and the default stay. A value that does not convert stops it and ' +
          'changes nothing.',
      },
    ];
  },
};
