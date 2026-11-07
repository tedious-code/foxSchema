/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Safe column change for SQL Server (Azure SQL re-exports it).
 *
 * Renames go through sp_rename. A column cannot be dropped while an index or
 * a DEFAULT constraint uses it, so the last step drops those by name first.
 * Each statement here is written to run on its own: CREATE TRIGGER must be
 * alone in its batch, so its body carries no inner semicolons.
 */
import type {
  ColumnChangeContext,
  ColumnChangeDialect,
  ColumnChangeStep,
} from '../../modules/utilities/column-change.types.js';

const q = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const schemaOf = (ctx: ColumnChangeContext) => ctx.schema || 'dbo';
const table = (ctx: ColumnChangeContext) => `${q(schemaOf(ctx))}.${q(ctx.table)}`;
/** A literal for sp_rename and OBJECT_ID: N'schema.table[.column]'. */
const lit = (...parts: string[]) => `N'${parts.join('.').replace(/'/g, "''")}'`;
const syncName = (ctx: ColumnChangeContext) => `fox_sync_${ctx.table}_${ctx.column.name}`.slice(0, 128);
const swap = (cols: string[], from: string, to: string) =>
  cols.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c));

function sqlServerCopyPatch(ctx: ColumnChangeContext): string {
  const t = table(ctx);
  const col = q(ctx.column.name);
  const next = q(ctx.newColumn);
  return `UPDATE TOP (${ctx.batchSize}) ${t} SET ${next} = CAST(${col} AS ${ctx.targetType})\nWHERE ${next} IS NULL AND ${col} IS NOT NULL;`;
}

/** One T-SQL batch: no inner `;`, so the WHILE stays one statement for the driver. */
function sqlServerCopyLoop(ctx: ColumnChangeContext): string {
  const nested = sqlServerCopyPatch(ctx)
    .replace(/;?\s*$/, '')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return [
    'SET NOCOUNT ON',
    'DECLARE @fox_n int = 1',
    'WHILE @fox_n > 0',
    'BEGIN',
    nested,
    '  SET @fox_n = @@ROWCOUNT',
    'END;',
  ].join('\n');
}

export const sqlServerColumnChange: ColumnChangeDialect = {
  triggers: true,
  foreignKeyTypesMustMatch: true,

  renameSteps: (ctx) => [
      {
        phase: 'add',
        title: `Rename ${ctx.column.name} to ${ctx.targetName}`,
        rerunSafe: false,
      sql: `EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, ctx.column.name)}, ${lit(ctx.targetName)}, N'COLUMN';`,
      note:
        'Instant: only the catalog changes, and indexes follow. Views, procedures and functions that name the column ' +
        'do not; SQL Server warns about this, and they need updating after the rename.',
    },
  ],

  progressSql: (ctx) => ({
    totalSql: `SELECT COUNT(*) AS n FROM ${table(ctx)};`,
    remainingSql:
      `SELECT COUNT(*) AS n FROM ${table(ctx)}\n` +
      `WHERE ${q(ctx.newColumn)} IS NULL AND ${q(ctx.column.name)} IS NOT NULL;`,
    patchSql: sqlServerCopyPatch(ctx),
  }),

  rebuildSteps: (ctx) => {
    const t = table(ctx);
    const col = q(ctx.column.name);
    const next = q(ctx.newColumn);
    const trigger = `${q(schemaOf(ctx))}.${q(syncName(ctx))}`;
    const join = ctx.primaryKey.map((k) => `x.${q(k)} = i.${q(k)}`).join(' AND ');
    const steps: ColumnChangeStep[] = [];

    steps.push({
      phase: 'add',
      title: `Add the new column ${ctx.newColumn} (${ctx.targetType})`,
      rerunSafe: false,
      sql: `ALTER TABLE ${t} ADD ${next} ${ctx.targetType} NULL;`,
      note: 'Nullable and without a default: a metadata-only change.',
    });

    steps.push({
      phase: 'copy',
      title: 'Keep the new column in step while the copy runs',
      rerunSafe: false,
      sql:
        `CREATE TRIGGER ${trigger} ON ${t} AFTER INSERT, UPDATE AS\n` +
        `BEGIN\n` +
        `  SET NOCOUNT ON\n` +
        `  IF UPDATE(${col})\n` +
        `    UPDATE x SET x.${next} = CAST(i.${col} AS ${ctx.targetType})\n` +
        `    FROM ${t} AS x JOIN inserted AS i ON ${join}\n` +
        `END;`,
      note: 'Writes made while the copy runs reach the new column too.',
    });

    steps.push({
      phase: 'copy',
      title: `Copy the data in batches of ${ctx.batchSize.toLocaleString('en-US')}`,
      rerunSafe: true,
      sql: sqlServerCopyLoop(ctx),
      note: 'Loops until a batch affects 0 rows. Fox Run does that loop and shows processed / total. A value that does not convert stops the batch with an error and changes nothing.',
    });

    steps.push({
      phase: 'copy',
      title: 'Check that every row was copied',
      rerunSafe: true,
      sql: `SELECT COUNT(*) AS mismatched FROM ${t}\nWHERE (${col} IS NULL AND ${next} IS NOT NULL) OR (${col} IS NOT NULL AND ${next} IS NULL);`,
      note: 'Expect 0 before switching over.',
    });

    const constraints: string[] = [];
    constraints.push(sqlServerCopyComment(ctx));
    if (!ctx.column.nullable) constraints.push(`ALTER TABLE ${t} ALTER COLUMN ${next} ${ctx.targetType} NOT NULL;`);
    if (ctx.column.defaultValue && !ctx.typeChanged) {
      constraints.push(`ALTER TABLE ${t} ADD DEFAULT ${ctx.column.defaultValue} FOR ${next};`);
    }
    for (const idx of ctx.indexes) {
      const cols = swap(idx.columns, ctx.column.name, ctx.newColumn).map(q).join(', ');
      constraints.push(
        idx.constraint
          ? `ALTER TABLE ${t} ADD CONSTRAINT ${q(`${idx.name}__new`)} UNIQUE (${cols});`
          : `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(`${idx.name}__new`)} ON ${t} (${cols});`
      );
    }
    for (const fk of ctx.outboundForeignKeys) {
      const cols = swap(fk.columns, ctx.column.name, ctx.newColumn).map(q).join(', ');
      const parent = `${q(fk.referencedSchema || schemaOf(ctx))}.${q(fk.referencedTable)}`;
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
          ctx.column.defaultValue && ctx.typeChanged
            ? `The old default (${ctx.column.defaultValue}) is not copied, since the type changes: set one that fits ${ctx.targetType}.`
            : undefined,
      });
    }

    steps.push({
      phase: 'finish',
      title: 'Switch over',
      rerunSafe: false,
      // One batch, so one statement: drivers send each statement as its own
      // batch, and SQL Server refuses a batch that ends inside a transaction.
      // XACT_ABORT rolls the whole switch back if any part of it fails.
      sql: [
        'SET XACT_ABORT ON',
        'BEGIN TRANSACTION',
        `  DROP TRIGGER IF EXISTS ${trigger}`,
        `  EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, ctx.column.name)}, ${lit(ctx.oldColumn)}, N'COLUMN'`,
        `  EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, ctx.newColumn)}, ${lit(ctx.targetName)}, N'COLUMN'`,
        'COMMIT TRANSACTION;',
      ].join('\n'),
      note: 'One transaction in one batch: readers see the old column or the new one, never neither, and a failure undoes all of it.',
    });

    const finish: string[] = [];
    for (const fk of ctx.outboundForeignKeys) finish.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)};`);
    for (const idx of ctx.indexes) {
      finish.push(idx.constraint ? `ALTER TABLE ${t} DROP CONSTRAINT ${q(idx.name)};` : `DROP INDEX ${q(idx.name)} ON ${t};`);
    }
    // A DEFAULT constraint has a generated name; find it by the column. One
    // statement, so the variable lives as long as it is needed.
    // EXEC() takes only literals and variables, so the statement is built in
    // @sql first.
    finish.push(
      `DECLARE @df sysname, @sql nvarchar(max) SELECT @df = dc.name FROM sys.default_constraints AS dc ` +
        `JOIN sys.columns AS c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
        `WHERE dc.parent_object_id = OBJECT_ID(${lit(schemaOf(ctx), ctx.table)}) AND c.name = ${lit(ctx.oldColumn)} ` +
        `IF @df IS NOT NULL BEGIN SET @sql = N'ALTER TABLE ${t.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df) ` +
        `EXEC sp_executesql @sql END;`
    );
    finish.push(`ALTER TABLE ${t} DROP COLUMN ${q(ctx.oldColumn)};`);
    for (const idx of ctx.indexes) {
      finish.push(
        idx.constraint
          ? `EXEC sp_rename ${lit(schemaOf(ctx), `${idx.name}__new`)}, ${lit(idx.name)}, N'OBJECT';`
          : `EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, `${idx.name}__new`)}, ${lit(idx.name)}, N'INDEX';`
      );
    }
    for (const fk of ctx.outboundForeignKeys) {
      finish.push(`EXEC sp_rename ${lit(schemaOf(ctx), `${fk.name}__new`)}, ${lit(fk.name)}, N'OBJECT';`);
    }
    steps.push({
      phase: 'finish',
      title: `Drop the old column ${ctx.oldColumn}`,
      rerunSafe: false,
      sql: finish.join('\n'),
      note:
        'Only after you have checked the new column and the applications using it. Its indexes, foreign keys and default ' +
        'are dropped first, as SQL Server requires; the new ones then take their names.',
    });
    const rebuilt = sqlServerRebuildTriggers(ctx);
    if (rebuilt) steps.push(rebuilt);
    return steps;
  },
};

const ssWord = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sqlServerCopyComment(ctx: ColumnChangeContext): string {
  const schema = schemaOf(ctx);
  // One statement: drivers send each `;` as its own batch, and @fox_desc would not live.
  return [
    `DECLARE @fox_desc sql_variant, @fox_has int`,
    `SELECT @fox_desc = ep.value FROM sys.extended_properties AS ep`,
    `JOIN sys.columns AS c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id`,
    `WHERE ep.major_id = OBJECT_ID(${lit(schema, ctx.table)}) AND ep.name = N'MS_Description' AND c.name = ${lit(ctx.column.name)}`,
    `IF @fox_desc IS NOT NULL BEGIN`,
    `  SELECT @fox_has = COUNT(*) FROM sys.extended_properties AS ep`,
    `  JOIN sys.columns AS c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id`,
    `  WHERE ep.major_id = OBJECT_ID(${lit(schema, ctx.table)}) AND ep.name = N'MS_Description' AND c.name = ${lit(ctx.newColumn)}`,
    `  IF @fox_has = 0 EXEC sp_addextendedproperty N'MS_Description', @fox_desc, N'SCHEMA', ${lit(schema)}, N'TABLE', ${lit(ctx.table)}, N'COLUMN', ${lit(ctx.newColumn)}`,
    `END;`,
  ].join('\n');
}

function sqlServerRebuildTriggers(ctx: ColumnChangeContext): ColumnChangeStep | undefined {
  if (ctx.triggers.length === 0) return undefined;
  const sql = ctx.triggers
    .map((trg) => {
      const drop = `DROP TRIGGER IF EXISTS ${q(schemaOf(ctx))}.${q(trg.name)};`;
      const body = trg.definition?.trim();
      if (!body) return `${drop}\n-- Recreate ${trg.name} after checking the new column name.`;
      const rewritten = body.replace(new RegExp(`\\b${ssWord(ctx.column.name)}\\b`, 'g'), ctx.targetName);
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
