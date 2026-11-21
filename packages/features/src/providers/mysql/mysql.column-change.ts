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

function procName(ctx: ColumnChangeContext): string {
  const ident = `fox_copy_${ctx.table}_${ctx.column.name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  return q(ident);
}

function mysqlCopyPatch(ctx: ColumnChangeContext): string {
  const t = table(ctx);
  const col = q(ctx.column.name);
  const next = q(ctx.newColumn);
  return `UPDATE ${t} SET ${next} = ${col}\nWHERE ${next} IS NULL AND ${col} IS NOT NULL\nLIMIT ${ctx.batchSize};`;
}

/** MySQL/MariaDB stored procedure loop. TiDB has no usable procedures here, so the patch plus a repeat note. */
function mysqlCopyLoop(ctx: ColumnChangeContext, procedural: boolean): string {
  const patch = mysqlCopyPatch(ctx);
  if (!procedural) {
    return `-- Repeat until this UPDATE changes 0 rows. Fox Run loops it and shows progress.\n${patch}`;
  }
  const name = procName(ctx);
  const nested = patch.split('\n').map((line) => `    ${line}`).join('\n');
  return [
    `DROP PROCEDURE IF EXISTS ${name};`,
    `CREATE PROCEDURE ${name}()`,
    'BEGIN',
    '  REPEAT',
    nested,
    '  UNTIL ROW_COUNT() = 0 END REPEAT;',
    'END;',
    `CALL ${name}();`,
    `DROP PROCEDURE ${name};`,
  ].join('\n');
}

export function mysqlFamilyColumnChange(options: { triggers: boolean; atomicSwitch?: boolean }): ColumnChangeDialect {
  return {
    triggers: options.triggers,
    foreignKeyTypesMustMatch: true,
    viewsBlockTypeChange: false,

    alterTypeSteps: (ctx) => [
      {
        phase: 'add',
        title: `Change ${ctx.column.name} to ${ctx.targetType}`,
        rerunSafe: true,
        sql: mysqlModifyKeepingComment(ctx, ctx.column.name, mysqlRestated(ctx)),
        note:
          'MODIFY restates the whole column, so its NOT NULL, default, collation and comment are carried over. ' +
          'Most type changes copy the table and block writes while they run; lengthening a varchar is often instant. ' +
          'Run with strict SQL mode (the default) so a value that does not fit stops it instead of being cut or stored as 0.',
      },
    ],

    renameSteps: (ctx) => [
      {
        phase: 'add',
        title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
        rerunSafe: false,
        sql: `ALTER TABLE ${table(ctx)} RENAME COLUMN ${q(ctx.column.name)} TO ${q(ctx.targetName)};`,
        note:
          'Instant: only the catalog changes, and indexes follow. Views and triggers that name the column do not: ' +
          'MySQL keeps their text, so recreate them after the rename.',
      },
    ],

    progressSql: (ctx) => ({
      totalSql: `SELECT COUNT(*) AS n FROM ${table(ctx)};`,
      remainingSql:
        `SELECT COUNT(*) AS n FROM ${table(ctx)}\n` +
        `WHERE ${q(ctx.newColumn)} IS NULL AND ${q(ctx.column.name)} IS NOT NULL;`,
      patchSql: mysqlCopyPatch(ctx),
    }),

    rebuildSteps: (ctx) => {
      const t = table(ctx);
      const col = q(ctx.column.name);
      const next = q(ctx.newColumn);
      const ins = q(syncName(ctx, 'ins'));
      const upd = q(syncName(ctx, 'upd'));
      const steps: ColumnChangeStep[] = [];

      steps.push({
        phase: 'add',
        title: `Add the new column ${ctx.newColumn} (${ctx.targetType})`,
        rerunSafe: false,
        sql: `ALTER TABLE ${t} ADD COLUMN ${next} ${ctx.targetType} NULL;`,
        note: 'Nullable and without a default. On MySQL 8 this is an instant change for most tables.',
      });

      if (options.triggers) {
        steps.push({
          phase: 'copy',
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
        phase: 'copy',
        title: `Copy the data in batches of ${ctx.batchSize.toLocaleString('en-US')}`,
        rerunSafe: true,
        sql: mysqlCopyLoop(ctx, options.triggers),
        note:
          'Loops until a batch changes 0 rows. Fox Run does that loop and shows processed / total. Run with strict SQL mode (the default) so a value that does not convert ' +
          'stops with an error instead of being stored as 0 or NULL.' +
          (options.triggers ? '' : ' This engine has no triggers: pause writes to the column, or run it once more just before the switch-over.'),
      });

      steps.push({
        phase: 'copy',
        title: 'Check that every row was copied',
        rerunSafe: true,
        sql: `SELECT COUNT(*) AS mismatched FROM ${t}\nWHERE (${col} IS NULL AND ${next} IS NOT NULL) OR (${col} IS NOT NULL AND ${next} IS NULL);`,
        note: 'Expect 0 before switching over.',
      });

      const constraints: string[] = [];
      constraints.push(mysqlCopyComment(ctx));
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
          phase: 'finish',
          title: 'Give the new column the old one’s constraints and indexes',
          rerunSafe: false,
          sql: constraints.join('\n'),
          note:
            (ctx.column.defaultValue && ctx.typeChanged
              ? `The old default (${ctx.column.defaultValue}) is not copied, since the type changes: set one that fits ${ctx.targetType}. `
              : '') + 'Making a column NOT NULL rebuilds the table on MySQL.',
        });
      }

      const switchRenames =
        options.atomicSwitch === false
          ? [
              `ALTER TABLE ${t} RENAME COLUMN ${col} TO ${q(ctx.oldColumn)};`,
              `ALTER TABLE ${t} RENAME COLUMN ${next} TO ${q(ctx.targetName)};`,
            ]
          : [`ALTER TABLE ${t} RENAME COLUMN ${col} TO ${q(ctx.oldColumn)}, RENAME COLUMN ${next} TO ${q(ctx.targetName)};`];
      steps.push({
        phase: 'finish',
        title: 'Switch over',
        rerunSafe: false,
        sql: [
          ...(options.triggers ? [`DROP TRIGGER IF EXISTS ${ins};`, `DROP TRIGGER IF EXISTS ${upd};`] : []),
          ...switchRenames,
        ].join('\n'),
        note:
          options.atomicSwitch === false
            ? 'Two ALTERs: this engine cannot rename both columns in one statement. A write between them can miss the new name.'
            : 'One ALTER renames both columns at once. Run these together: a write between dropping the triggers and the rename ' +
              'would not reach the new column.',
      });

      const finish: string[] = [];
      // Foreign keys first: MySQL refuses to drop an index a foreign key still needs.
      for (const fk of ctx.outboundForeignKeys) finish.push(`ALTER TABLE ${t} DROP FOREIGN KEY ${q(fk.name)};`);
      for (const idx of ctx.indexes) finish.push(`DROP INDEX ${q(idx.name)} ON ${t};`);
      finish.push(`ALTER TABLE ${t} DROP COLUMN ${q(ctx.oldColumn)};`);
      for (const idx of ctx.indexes) finish.push(`ALTER TABLE ${t} RENAME INDEX ${q(`${idx.name}__new`)} TO ${q(idx.name)};`);
      steps.push({
        phase: 'finish',
        title: `Drop the old column ${ctx.oldColumn}`,
        rerunSafe: false,
        sql: finish.join('\n'),
        note:
          'Only after you have checked the new column and the applications using it.' +
          (ctx.outboundForeignKeys.length > 0
            ? ' MySQL cannot rename a foreign key, so the new ones keep their __new names.'
            : ''),
      });
      const rebuilt = mysqlRebuildTriggers(ctx);
      if (rebuilt) steps.push(rebuilt);
      return steps;
    },
  };
}

const mysqlLit = (value: string) => value.replace(/'/g, "''");
const mysqlWord = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `MODIFY COLUMN <target> <definition> COMMENT <the column's comment>`, with the
 * comment read from the catalog when it runs. A MODIFY drops what it does not
 * restate, and the comment is not in the schema Fox holds.
 */
function mysqlModifyKeepingComment(ctx: ColumnChangeContext, target: string, definition: string): string {
  const schema = ctx.schema || '';
  const schemaPred = schema
    ? `TABLE_SCHEMA = '${mysqlLit(schema)}'`
    : 'TABLE_SCHEMA = DATABASE()';
  const head = mysqlLit(`ALTER TABLE ${table(ctx)} MODIFY COLUMN ${q(target)} ${definition} COMMENT `);
  return [
    `SET @fox_col_comment = (SELECT COLUMN_COMMENT FROM information_schema.COLUMNS WHERE ${schemaPred} AND TABLE_NAME = '${mysqlLit(ctx.table)}' AND COLUMN_NAME = '${mysqlLit(ctx.column.name)}');`,
    `SET @fox_col_sql = CONCAT('${head}', QUOTE(IFNULL(@fox_col_comment, '')));`,
    'PREPARE fox_col_stmt FROM @fox_col_sql;',
    'EXECUTE fox_col_stmt;',
    'DEALLOCATE PREPARE fox_col_stmt;',
  ].join('\n');
}

function mysqlCopyComment(ctx: ColumnChangeContext): string {
  return mysqlModifyKeepingComment(ctx, ctx.newColumn, `${ctx.targetType} NULL`);
}

/** The column as MODIFY must restate it under the new type: nullability, default and collation. */
function mysqlRestated(ctx: ColumnChangeContext): string {
  const parts = [ctx.targetType, ctx.column.nullable ? 'NULL' : 'NOT NULL'];
  if (ctx.column.defaultValue) parts.push(`DEFAULT ${ctx.column.defaultValue}`);
  if (ctx.column.collation && /char|text/i.test(ctx.targetType)) parts.push(`COLLATE ${ctx.column.collation}`);
  return parts.join(' ');
}

function mysqlRebuildTriggers(ctx: ColumnChangeContext): ColumnChangeStep | undefined {
  if (ctx.triggers.length === 0) return undefined;
  const sql = ctx.triggers
    .map((trg) => {
      const drop = `DROP TRIGGER IF EXISTS ${q(trg.name)};`;
      const body = trg.definition?.trim();
      if (!body) return `${drop}\n-- Recreate ${trg.name} after checking the new column name.`;
      const rewritten = body.replace(new RegExp(`\\b${mysqlWord(ctx.column.name)}\\b`, 'g'), ctx.targetName);
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

export const mysqlColumnChange = mysqlFamilyColumnChange({ triggers: true });
