/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Safe column change for MySQL. MariaDB and TiDB use the same SQL through
 * `mysqlFamilyColumnChange`; TiDB has no triggers.
 *
 * Two MySQL rules shape the steps: DDL commits on its own (no transaction
 * around the switch-over, but one ALTER renames both columns atomically), and
 * dropping a column shrinks a multi-column index rather than dropping it, so
 * the old indexes are dropped by name first.
 */
import type {
  ColumnChangeContext,
  ColumnChangeDialect,
  ColumnChangeStep,
} from '../../modules/utilities/column-change.types.js';

const q = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));
const syncName = (ctx: ColumnChangeContext, kind: 'ins' | 'upd') =>
  `fox_sync_${ctx.table}_${ctx.column.name}`.slice(0, 56) + `_${kind}`;
const swap = (cols: string[], from: string, to: string) =>
  cols.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c));

export function mysqlFamilyColumnChange(options: { triggers: boolean }): ColumnChangeDialect {
  return {
    triggers: options.triggers,
    foreignKeyTypesMustMatch: true,

    renameSteps: (ctx) => [
      {
        title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
        rerunSafe: false,
        sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
        note:
          'Instant: only the catalog changes, and indexes follow. Views and triggers that name the column do not: ' +
          'MySQL keeps their text, so recreate them after the rename.',
      },
    ],

    rebuildSteps: (ctx) => {
      const t = table(ctx);
      const col = q(ctx.column.name);
      const next = q(ctx.newColumn);
      const ins = q(syncName(ctx, 'ins'));
      const upd = q(syncName(ctx, 'upd'));
      const steps: ColumnChangeStep[] = [];

      steps.push({
        title: `Add the new column ${ctx.newColumn} (${ctx.targetType})`,
        rerunSafe: false,
        sql: `ALTER TABLE ${t} ADD COLUMN ${next} ${ctx.targetType} NULL;`,
        note: 'Nullable and without a default. On MySQL 8 this is an instant change for most tables.',
      });

      if (options.triggers) {
        steps.push({
          title: 'Keep the new column in step while the copy runs',
          rerunSafe: false,
          sql: [
            `CREATE TRIGGER ${ins} BEFORE INSERT ON ${t} FOR EACH ROW SET NEW.${next} = NEW.${col};`,
            `CREATE TRIGGER ${upd} BEFORE UPDATE ON ${t} FOR EACH ROW SET NEW.${next} = NEW.${col};`,
          ].join('\n'),
          note: 'Writes made while the copy runs reach the new column too.',
        });
      }

      steps.push({
        title: `Copy the data in batches of ${ctx.batchSize.toLocaleString('en-US')}`,
        rerunSafe: true,
        sql: `UPDATE ${t} SET ${next} = ${col}\nWHERE ${next} IS NULL AND ${col} IS NOT NULL\nLIMIT ${ctx.batchSize};`,
        note:
          'Run it again until it changes 0 rows. Run with strict SQL mode (the default) so a value that does not convert ' +
          'stops with an error instead of being stored as 0 or NULL.' +
          (options.triggers ? '' : ' This engine has no triggers: pause writes to the column, or run it once more just before the switch-over.'),
      });

      steps.push({
        title: 'Check that every row was copied',
        rerunSafe: true,
        sql: `SELECT COUNT(*) AS mismatched FROM ${t}\nWHERE (${col} IS NULL AND ${next} IS NOT NULL) OR (${col} IS NOT NULL AND ${next} IS NULL);`,
        note: 'Expect 0 before switching over.',
      });

      const constraints: string[] = [];
      if (!ctx.column.nullable) {
        const keepDefault = ctx.column.defaultValue && !ctx.typeChanged ? ` DEFAULT ${ctx.column.defaultValue}` : '';
        constraints.push(`ALTER TABLE ${t} MODIFY COLUMN ${next} ${ctx.targetType} NOT NULL${keepDefault};`);
      } else if (ctx.column.defaultValue && !ctx.typeChanged) {
        constraints.push(`ALTER TABLE ${t} ALTER COLUMN ${next} SET DEFAULT ${ctx.column.defaultValue};`);
      }
      for (const idx of ctx.indexes) {
        const cols = swap(idx.columns, ctx.column.name, ctx.newColumn).map(q).join(', ');
        constraints.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(`${idx.name}__new`)} ON ${t} (${cols});`);
      }
      for (const fk of ctx.outboundForeignKeys) {
        const cols = swap(fk.columns, ctx.column.name, ctx.newColumn).map(q).join(', ');
        const parent = fk.referencedSchema ? `${q(fk.referencedSchema)}.${q(fk.referencedTable)}` : q(fk.referencedTable);
        constraints.push(
          `ALTER TABLE ${t} ADD CONSTRAINT ${q(`${fk.name}__new`)} FOREIGN KEY (${cols}) REFERENCES ${parent} (${fk.referencedColumns.map(q).join(', ')});`
        );
      }
      if (constraints.length > 0) {
        steps.push({
          title: 'Give the new column the old one’s constraints and indexes',
          rerunSafe: false,
          sql: constraints.join('\n'),
          note:
            (ctx.column.defaultValue && ctx.typeChanged
              ? `The old default (${ctx.column.defaultValue}) is not copied, since the type changes: set one that fits ${ctx.targetType}. `
              : '') + 'Making a column NOT NULL rebuilds the table on MySQL.',
        });
      }

      steps.push({
        title: 'Switch over',
        rerunSafe: false,
        sql: [
          ...(options.triggers ? [`DROP TRIGGER IF EXISTS ${ins};`, `DROP TRIGGER IF EXISTS ${upd};`] : []),
          `ALTER TABLE ${t} RENAME COLUMN ${col} TO ${q(ctx.oldColumn)}, RENAME COLUMN ${next} TO ${q(ctx.targetName)};`,
        ].join('\n'),
        note:
          'One ALTER renames both columns at once. Run these together: a write between dropping the triggers and the rename ' +
          'would not reach the new column.',
      });

      const finish: string[] = [];
      // Foreign keys first: MySQL refuses to drop an index a foreign key still needs.
      for (const fk of ctx.outboundForeignKeys) finish.push(`ALTER TABLE ${t} DROP FOREIGN KEY ${q(fk.name)};`);
      for (const idx of ctx.indexes) finish.push(`DROP INDEX ${q(idx.name)} ON ${t};`);
      finish.push(`ALTER TABLE ${t} DROP COLUMN ${q(ctx.oldColumn)};`);
      for (const idx of ctx.indexes) finish.push(`ALTER TABLE ${t} RENAME INDEX ${q(`${idx.name}__new`)} TO ${q(idx.name)};`);
      steps.push({
        title: `Drop the old column ${ctx.oldColumn}`,
        rerunSafe: false,
        sql: finish.join('\n'),
        note:
          'Only after you have checked the new column and the applications using it.' +
          (ctx.outboundForeignKeys.length > 0
            ? ' MySQL cannot rename a foreign key, so the new ones keep their __new names.'
            : ''),
      });
      return steps;
    },
  };
}

export const mysqlColumnChange = mysqlFamilyColumnChange({ triggers: true });
