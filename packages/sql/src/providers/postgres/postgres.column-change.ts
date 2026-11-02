/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Safe column change for PostgreSQL. CockroachDB, YugabyteDB and Redshift use
 * the same SQL through `postgresFamilyColumnChange`, differing only in whether
 * a trigger can keep the new column in step during the copy.
 */
import type {
  ColumnChangeContext,
  ColumnChangeDialect,
  ColumnChangeStep,
} from '../../modules/utilities/column-change.types.js';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));
const objectIn = (ctx: ColumnChangeContext, name: string) => (ctx.schema ? `${q(ctx.schema)}.${q(name)}` : q(name));
const syncName = (ctx: ColumnChangeContext) => `fox_sync_${ctx.table}_${ctx.column.name}`.slice(0, 63);
const swap = (cols: string[], from: string, to: string) =>
  cols.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c));
const keyList = (ctx: ColumnChangeContext) => ctx.primaryKey.map(q).join(', ');

export function postgresFamilyColumnChange(options: { triggers: boolean }): ColumnChangeDialect {
  return {
    triggers: options.triggers,
    foreignKeyTypesMustMatch: false,

    renameSteps: (ctx) => [
      {
        title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
        rerunSafe: false,
        sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
        note:
          'Instant: only the catalog changes. Indexes, constraints and views follow the column; ' +
          'application code and stored SQL that name it do not.',
      },
    ],

    rebuildSteps: (ctx) => {
      const t = table(ctx);
      const col = q(ctx.column.name);
      const next = q(ctx.newColumn);
      const fn = objectIn(ctx, syncName(ctx));
      const trigger = q(syncName(ctx));
      const steps: ColumnChangeStep[] = [];

      steps.push({
        title: `Add the new column ${ctx.newColumn} (${ctx.targetType})`,
        rerunSafe: true,
        sql: `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${next} ${ctx.targetType};`,
        note: 'Nullable and without a default, so existing rows are not rewritten.',
      });

      if (options.triggers) {
        steps.push({
          title: 'Keep the new column in step while the copy runs',
          rerunSafe: true,
          sql: [
            `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$`,
            'BEGIN',
            `  NEW.${next} := CAST(NEW.${col} AS ${ctx.targetType});`,
            '  RETURN NEW;',
            'END;',
            '$$;',
            `DROP TRIGGER IF EXISTS ${trigger} ON ${t};`,
            `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE OF ${col} ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
          ].join('\n'),
          note: 'Writes made while the copy runs reach the new column too.',
        });
      }

      steps.push({
        title: `Copy the data in batches of ${ctx.batchSize.toLocaleString('en-US')}`,
        rerunSafe: true,
        sql:
          `UPDATE ${t} SET ${next} = CAST(${col} AS ${ctx.targetType})\n` +
          `WHERE (${keyList(ctx)}) IN (\n` +
          `  SELECT ${keyList(ctx)} FROM ${t}\n` +
          `  WHERE ${next} IS NULL AND ${col} IS NOT NULL\n` +
          `  ORDER BY ${keyList(ctx)} LIMIT ${ctx.batchSize}\n` +
          `);`,
        note:
          'Run it again until it updates 0 rows. A value that does not convert stops the batch with an error and changes nothing.' +
          (options.triggers ? '' : ' This engine has no triggers here: pause writes to the column, or run it once more just before the switch-over.'),
      });

      steps.push(checkStep(t, col, next));

      const constraints: string[] = [];
      if (!ctx.column.nullable) constraints.push(`ALTER TABLE ${t} ALTER COLUMN ${next} SET NOT NULL;`);
      if (ctx.column.defaultValue && !ctx.typeChanged) {
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
              : '') + 'Indexes are built while the table stays writable; on a large table, consider CREATE INDEX CONCURRENTLY outside a transaction.',
        });
      }

      steps.push({
        title: 'Switch over',
        rerunSafe: false,
        sql: [
          'BEGIN;',
          ...(options.triggers ? [`DROP TRIGGER IF EXISTS ${trigger} ON ${t};`] : []),
          `ALTER TABLE ${t} RENAME COLUMN ${col} TO ${q(ctx.oldColumn)};`,
          `ALTER TABLE ${t} RENAME COLUMN ${next} TO ${q(ctx.targetName)};`,
          'COMMIT;',
        ].join('\n'),
        note:
          'One transaction: readers see the old column or the new one, never neither. Views keep pointing at the old column ' +
          `(${ctx.oldColumn}); recreate any that use it before the last step.`,
      });

      const finish = [`ALTER TABLE ${t} DROP COLUMN ${q(ctx.oldColumn)};`];
      if (options.triggers) finish.push(`DROP FUNCTION IF EXISTS ${fn}();`);
      for (const idx of ctx.indexes) finish.push(`ALTER INDEX ${objectIn(ctx, `${idx.name}__new`)} RENAME TO ${q(idx.name)};`);
      for (const fk of ctx.outboundForeignKeys) {
        finish.push(`ALTER TABLE ${t} RENAME CONSTRAINT ${q(`${fk.name}__new`)} TO ${q(fk.name)};`);
      }
      steps.push({
        title: `Drop the old column ${ctx.oldColumn}`,
        rerunSafe: false,
        sql: finish.join('\n'),
        note:
          'Only after you have checked the new column and the applications using it. Its indexes and constraints go with it; ' +
          'the new ones then take their names. It refuses while a view still uses the old column.',
      });
      return steps;
    },
  };
}

function checkStep(t: string, col: string, next: string): ColumnChangeStep {
  return {
    title: 'Check that every row was copied',
    rerunSafe: true,
    sql: `SELECT COUNT(*) AS mismatched FROM ${t}\nWHERE (${col} IS NULL AND ${next} IS NOT NULL) OR (${col} IS NOT NULL AND ${next} IS NULL);`,
    note: 'Expect 0 before switching over.',
  };
}

export const postgresColumnChange = postgresFamilyColumnChange({ triggers: true });
