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

const lit = (value: string) => value.replace(/'/g, "''");
const identWord = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function postgresCopyComment(ctx: ColumnChangeContext): string {
  const schema = ctx.schema || 'public';
  return [
    'DO $fox$',
    'DECLARE d text;',
    'BEGIN',
    '  SELECT d.description INTO d',
    '  FROM pg_catalog.pg_description d',
    '  JOIN pg_catalog.pg_class c ON c.oid = d.objoid',
    '  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    '  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid',
    `  WHERE n.nspname = '${lit(schema)}' AND c.relname = '${lit(ctx.table)}' AND a.attname = '${lit(ctx.column.name)}';`,
    '  IF d IS NOT NULL THEN',
    `    EXECUTE format('COMMENT ON COLUMN %I.%I.%I IS %L', '${lit(schema)}', '${lit(ctx.table)}', '${lit(ctx.newColumn)}', d);`,
    '  END IF;',
    'END',
    '$fox$;',
  ].join('\n');
}

function postgresRebuildTriggers(ctx: ColumnChangeContext): ColumnChangeStep | undefined {
  if (ctx.triggers.length === 0) return undefined;
  const t = table(ctx);
  const sql = ctx.triggers
    .map((trg) => {
      const drop = `DROP TRIGGER IF EXISTS ${q(trg.name)} ON ${t};`;
      const body = trg.definition?.trim();
      if (!body) return `${drop}\n-- Recreate ${trg.name} after checking the new column name.`;
      const rewritten = body.replace(new RegExp(`\\b${identWord(ctx.column.name)}\\b`, 'g'), ctx.targetName);
      return `${drop}\n${rewritten.replace(/;?\s*$/, '')};`;
    })
    .join('\n');
  return {
    phase: 'finish',
    title: 'Recreate table triggers that name the column',
    rerunSafe: false,
    sql,
    note: 'Dropped and recreated after the switch-over, with the old column name rewritten to the new one. Check the body before running.',
  };
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const table = (ctx: ColumnChangeContext) => (ctx.schema ? `${q(ctx.schema)}.${q(ctx.table)}` : q(ctx.table));
const objectIn = (ctx: ColumnChangeContext, name: string) => (ctx.schema ? `${q(ctx.schema)}.${q(name)}` : q(name));
const syncName = (ctx: ColumnChangeContext) => `fox_sync_${ctx.table}_${ctx.column.name}`.slice(0, 63);
const swap = (cols: string[], from: string, to: string) =>
  cols.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c));
const keyList = (ctx: ColumnChangeContext) => ctx.primaryKey.map(q).join(', ');

function postgresCopyPatch(ctx: ColumnChangeContext): string {
  const t = table(ctx);
  const col = q(ctx.column.name);
  const next = q(ctx.newColumn);
  const keys = keyList(ctx);
  return [
    `UPDATE ${t} SET ${next} = CAST(${col} AS ${ctx.targetType})`,
    `WHERE (${keys}) IN (`,
    `  SELECT ${keys} FROM ${t}`,
    `  WHERE ${next} IS NULL AND ${col} IS NOT NULL`,
    `  ORDER BY ${keys} LIMIT ${ctx.batchSize}`,
    `);`,
  ].join('\n');
}

/** plpgsql loop for Postgres/Yugabyte. Cockroach has no DO, so the patch plus a repeat note. */
function postgresCopyLoop(ctx: ColumnChangeContext, procedural: boolean): string {
  const patch = postgresCopyPatch(ctx);
  if (!procedural) {
    return `-- Repeat until this UPDATE changes 0 rows. Fox Run loops it and shows progress.\n${patch}`;
  }
  const nested = patch.split('\n').map((line) => `    ${line}`).join('\n');
  return [
    'DO $fox_copy$',
    'DECLARE n int;',
    'BEGIN',
    '  LOOP',
    nested,
    '    GET DIAGNOSTICS n = ROW_COUNT;',
    '    EXIT WHEN n = 0;',
    '  END LOOP;',
    'END',
    '$fox_copy$;',
  ].join('\n');
}

export function postgresFamilyColumnChange(options: { triggers: boolean }): ColumnChangeDialect {
  return {
    triggers: options.triggers,
    foreignKeyTypesMustMatch: false,

    renameSteps: (ctx) => [
      {
        phase: 'add',
        title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
        rerunSafe: false,
        sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
        note:
          'Instant: only the catalog changes. Indexes, constraints and views follow the column; ' +
          'application code and stored SQL that name it do not.',
      },
    ],

    progressSql: (ctx) => ({
      totalSql: `SELECT COUNT(*) AS n FROM ${table(ctx)};`,
      remainingSql:
        `SELECT COUNT(*) AS n FROM ${table(ctx)}\n` +
        `WHERE ${q(ctx.newColumn)} IS NULL AND ${q(ctx.column.name)} IS NOT NULL;`,
      patchSql: postgresCopyPatch(ctx),
    }),

    rebuildSteps: (ctx) => {
      const t = table(ctx);
      const col = q(ctx.column.name);
      const next = q(ctx.newColumn);
      const fn = objectIn(ctx, syncName(ctx));
      const trigger = q(syncName(ctx));
      const steps: ColumnChangeStep[] = [];

      steps.push({
        phase: 'add',
        title: `Add the new column ${ctx.newColumn} (${ctx.targetType})`,
        rerunSafe: true,
        sql: `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${next} ${ctx.targetType};`,
        note: 'Nullable and without a default, so existing rows are not rewritten.',
      });

      if (options.triggers) {
        steps.push({
          phase: 'copy',
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
        phase: 'copy',
        title: `Copy the data in batches of ${ctx.batchSize.toLocaleString('en-US')}`,
        rerunSafe: true,
        sql: postgresCopyLoop(ctx, options.triggers),
        note:
          'Loops until a batch updates 0 rows. Fox Run does that loop and shows processed / total. A value that does not convert stops the batch with an error and changes nothing.' +
          (options.triggers ? '' : ' This engine has no triggers here: pause writes to the column, or run it once more just before the switch-over.'),
      });

      steps.push(checkStep(t, col, next));

      const constraints: string[] = [];
      if (!ctx.column.nullable) constraints.push(`ALTER TABLE ${t} ALTER COLUMN ${next} SET NOT NULL;`);
      if (ctx.column.defaultValue && !ctx.typeChanged) {
        constraints.push(`ALTER TABLE ${t} ALTER COLUMN ${next} SET DEFAULT ${ctx.column.defaultValue};`);
      }
      if (options.triggers) constraints.push(postgresCopyComment(ctx));
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
          phase: 'finish',
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
        phase: 'finish',
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
        phase: 'finish',
        title: `Drop the old column ${ctx.oldColumn}`,
        rerunSafe: false,
        sql: finish.join('\n'),
        note:
          'Only after you have checked the new column and the applications using it. Its indexes and constraints go with it; ' +
          'the new ones then take their names. It refuses while a view still uses the old column.',
      });
      const rebuilt = postgresRebuildTriggers(ctx);
      if (rebuilt) steps.push(rebuilt);
      return steps;
    },
  };
}

function checkStep(t: string, col: string, next: string): ColumnChangeStep {
  return {
    phase: 'copy',
    title: 'Check that every row was copied',
    rerunSafe: true,
    sql: `SELECT COUNT(*) AS mismatched FROM ${t}\nWHERE (${col} IS NULL AND ${next} IS NOT NULL) OR (${col} IS NOT NULL AND ${next} IS NULL);`,
    note: 'Expect 0 before switching over.',
  };
}

export const postgresColumnChange = postgresFamilyColumnChange({ triggers: true });
