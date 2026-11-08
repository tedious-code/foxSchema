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

/** The DEFAULT constraint's generated name, found by the column, dropped by name. No `;`: it runs inside one batch. */
function dropDefaultFor(ctx: ColumnChangeContext, column: string): string {
  const t = table(ctx);
  return (
    `DECLARE @df sysname, @sql nvarchar(max) SELECT @df = dc.name FROM sys.default_constraints AS dc ` +
    `JOIN sys.columns AS c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
    `WHERE dc.parent_object_id = OBJECT_ID(${lit(schemaOf(ctx), ctx.table)}) AND c.name = ${lit(column)} ` +
    `IF @df IS NOT NULL BEGIN SET @sql = N'ALTER TABLE ${t.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df) ` +
    `EXEC sp_executesql @sql END`
  );
}

/** `N'…'` around a string the catalog gives at run time, quotes doubled, as T-SQL text. */
const runtimeLit = (expr: string) => `N'N''' + REPLACE(${expr}, N'''', N'''''') + N''''`;

/**
 * Fills @fox_ix with SQL for every index and unique constraint on `on`,
 * scripted from the catalog when it runs. Fox's own index model has no filter,
 * included columns or sort order, and recreating from it quietly turned a
 * filtered unique index into an unfiltered one; the catalog has them all, and
 * also finds an index that only INCLUDEs the column. Per index:
 * - `drop_sql` drops it;
 * - `create_sql` recreates it — on `copy.column` in place of `on`, and named
 *   with `copy.suffix`, when `copy` is given (the new column of large-table mode);
 * - `rename_sql` gives `<name>__new` the old name, when that index exists.
 * An index counts when the column is a key, an included column, or named in
 * its filter: SQL Server blocks ALTER and sp_rename on a column a filter names.
 * `filtered` keeps only filtered indexes, or only unfiltered ones.
 * No `;`: it runs inside one batch.
 */
function scriptIndexesFor(
  ctx: ColumnChangeContext,
  on: string,
  copy?: { column: string; suffix: string },
  filtered?: 'only' | 'none'
): string[] {
  const t = table(ctx).replace(/'/g, "''");
  const swapped = (expr: string) =>
    copy ? `REPLACE(${expr}, QUOTENAME(${lit(on)}), QUOTENAME(${lit(copy.column)}))` : expr;
  const colsOf = (included: 0 | 1, withOrder: boolean) =>
    `SELECT STRING_AGG(${swapped('QUOTENAME(c.name)')}${withOrder ? ` + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END` : ''}, N', ') ` +
    `WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS cols FROM sys.index_columns AS ic ` +
    `JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id ` +
    `WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = ${included}`;
  const name = copy ? `QUOTENAME(i.name + ${lit(copy.suffix)})` : 'QUOTENAME(i.name)';
  const newName = `i.name + N'__new'`;
  const schemaDot = schemaOf(ctx).replace(/'/g, "''") + '.';
  const tableDot = `${schemaDot}${ctx.table.replace(/'/g, "''")}.`;
  return [
    'DECLARE @fox_ix TABLE (n int IDENTITY, drop_sql nvarchar(max), create_sql nvarchar(max), rename_sql nvarchar(max))',
    'INSERT @fox_ix (drop_sql, create_sql, rename_sql) SELECT',
    `    CASE WHEN i.is_unique_constraint = 1 THEN N'ALTER TABLE ${t} DROP CONSTRAINT ' + QUOTENAME(i.name)`,
    `      ELSE N'DROP INDEX ' + QUOTENAME(i.name) + N' ON ${t}' END,`,
    `    CASE WHEN i.is_unique_constraint = 1`,
    `      THEN N'ALTER TABLE ${t} ADD CONSTRAINT ' + ${name} + N' UNIQUE ' + i.type_desc + N' (' + k.cols + N')'`,
    `      ELSE N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END + i.type_desc + N' INDEX ' + ${name}`,
    `        + N' ON ${t} (' + k.cols + N')' + ISNULL(N' INCLUDE (' + inc.cols + N')', N'') + ISNULL(N' WHERE ' + ${swapped('i.filter_definition')}, N'') END,`,
    `    CASE WHEN NOT EXISTS (SELECT 1 FROM sys.indexes AS x WHERE x.object_id = i.object_id AND x.name = ${newName}) THEN NULL`,
    `      WHEN i.is_unique_constraint = 1 THEN N'EXEC sp_rename ' + ${runtimeLit(`N'${schemaDot}' + ${newName}`)} + N', ' + ${runtimeLit('i.name')} + N', N''OBJECT'''`,
    `      ELSE N'EXEC sp_rename ' + ${runtimeLit(`N'${tableDot}' + ${newName}`)} + N', ' + ${runtimeLit('i.name')} + N', N''INDEX''' END`,
    '  FROM sys.indexes AS i',
    `  CROSS APPLY (${colsOf(0, true)}) AS k`,
    `  OUTER APPLY (${colsOf(1, false)}) AS inc`,
    `  WHERE i.object_id = OBJECT_ID(${lit(schemaOf(ctx), ctx.table)}) AND i.is_primary_key = 0 AND i.type IN (1, 2)` +
      (filtered === 'only' ? ' AND i.has_filter = 1' : filtered === 'none' ? ' AND i.has_filter = 0' : ''),
    `    AND (EXISTS (SELECT 1 FROM sys.index_columns AS ic JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id`,
    `      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND c.name = ${lit(on)})`,
    `      OR (i.has_filter = 1 AND CHARINDEX(QUOTENAME(${lit(on)}), i.filter_definition) > 0))`,
    'DECLARE @fox_n int = 1, @fox_sql nvarchar(max)',
  ];
}

/** Runs one column of @fox_ix in order, skipping a NULL. No `;`. */
const runScripted = (column: 'drop_sql' | 'create_sql' | 'rename_sql') =>
  `SET @fox_n = 1 WHILE @fox_n <= (SELECT COUNT(*) FROM @fox_ix) BEGIN SELECT @fox_sql = ${column} FROM @fox_ix WHERE n = @fox_n ` +
  `IF @fox_sql IS NOT NULL EXEC sp_executesql @fox_sql SET @fox_n += 1 END`;

function sqlServerAlterType(ctx: ColumnChangeContext): ColumnChangeStep {
  const t = table(ctx);
  const col = q(ctx.column.name);
  const collate = ctx.column.collation && /char|text/i.test(ctx.targetType) ? ` COLLATE ${ctx.column.collation}` : '';
  const alter = `ALTER TABLE ${t} ALTER COLUMN ${col} ${ctx.targetType}${collate} ${ctx.column.nullable ? 'NULL' : 'NOT NULL'}`;
  const parentOf = (fk: ColumnChangeContext['outboundForeignKeys'][number]) =>
    `${q(fk.referencedSchema || schemaOf(ctx))}.${q(fk.referencedTable)}`;
  // SQL Server refuses ALTER COLUMN while an index, a key or (for a new base
  // type) a default sits on the column: take them off, change it, put them back.
  // Foreign keys off first and on last: one may need an index dropped here.
  // Indexes are always scripted, even when Fox knows of none here: its model
  // leaves out an index that only INCLUDEs the column, which blocks the ALTER too.
  const before = [
    ...ctx.outboundForeignKeys.map((fk) => `ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)}`),
    ...scriptIndexesFor(ctx, ctx.column.name),
    runScripted('drop_sql'),
    ...(ctx.column.defaultValue ? [dropDefaultFor(ctx, ctx.column.name)] : []),
  ];
  const after = [
    ...(ctx.column.defaultValue ? [`ALTER TABLE ${t} ADD DEFAULT ${ctx.column.defaultValue} FOR ${col}`] : []),
    runScripted('create_sql'),
    ...ctx.outboundForeignKeys.map(
      (fk) =>
        `ALTER TABLE ${t} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
        `REFERENCES ${parentOf(fk)} (${fk.referencedColumns.map(q).join(', ')})`
    ),
  ];

  const note =
    'Most type changes rewrite every row and block the table while they run; lengthening a varchar does not. ' +
    'Any index, foreign key or default on the column is dropped first and recreated after, as SQL Server requires, ' +
    'in one transaction in one batch: a failure, such as a value that does not convert, undoes all of it. The indexes ' +
    'are scripted from the catalog as it runs, so their filters, included columns and sort order come back; options ' +
    'such as fill factor and compression do not.';
  return {
    phase: 'add',
    title: `Change ${ctx.column.name} to ${ctx.targetType}`,
    rerunSafe: false,
    // One batch, so one statement for the splitter: no `;` until COMMIT.
    sql: [
      'SET XACT_ABORT ON',
      'BEGIN TRANSACTION',
      ...before.map((s) => `  ${s}`),
      `  ${alter}`,
      ...after.map((s) => `  ${s}`),
      'COMMIT TRANSACTION;',
    ].join('\n'),
    note,
  };
}

export const sqlServerColumnChange: ColumnChangeDialect = {
  triggers: true,
  foreignKeyTypesMustMatch: true,
  viewsBlockTypeChange: false,

  alterTypeSteps: (ctx) => [sqlServerAlterType(ctx)],

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
    // Every unfiltered index on the old column again on the new one, as
    // `<name>__new`, scripted from the catalog so includes and sort order come
    // too. Filtered ones move at the switch-over, where the column is renamed.
    constraints.push(
      [
        ...scriptIndexesFor(ctx, ctx.column.name, { column: ctx.newColumn, suffix: '__new' }, 'none'),
        runScripted('create_sql'),
      ].join('\n') + ';'
    );
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
      // A filtered index whose filter names the column blocks sp_rename, so
      // those move here: dropped from the old column, recreated on the new one
      // under its final name, inside the same transaction.
      sql: [
        'SET XACT_ABORT ON',
        'BEGIN TRANSACTION',
        `  DROP TRIGGER IF EXISTS ${trigger}`,
        ...scriptIndexesFor(ctx, ctx.column.name, { column: ctx.targetName, suffix: '' }, 'only').map((s) => `  ${s}`),
        `  ${runScripted('drop_sql')}`,
        `  EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, ctx.column.name)}, ${lit(ctx.oldColumn)}, N'COLUMN'`,
        `  EXEC sp_rename ${lit(schemaOf(ctx), ctx.table, ctx.newColumn)}, ${lit(ctx.targetName)}, N'COLUMN'`,
        `  ${runScripted('create_sql')}`,
        'COMMIT TRANSACTION;',
      ].join('\n'),
      note:
        'One transaction in one batch: readers see the old column or the new one, never neither, and a failure undoes all of it. ' +
        'A filtered index on the column moves across here, since SQL Server will not rename a column a filter names; it is ' +
        'rebuilt inside the transaction.',
    });

    // One batch in one transaction: @fox_ix lives only inside its batch, and a
    // failure part way leaves neither column without its indexes. The old
    // column's indexes are found in the catalog, the ones Fox's model misses too.
    const finish = [
      ...ctx.outboundForeignKeys.map((fk) => `ALTER TABLE ${t} DROP CONSTRAINT ${q(fk.name)}`),
      ...scriptIndexesFor(ctx, ctx.oldColumn),
      runScripted('drop_sql'),
      // A DEFAULT constraint has a generated name; find it by the column.
      dropDefaultFor(ctx, ctx.oldColumn),
      `ALTER TABLE ${t} DROP COLUMN ${q(ctx.oldColumn)}`,
      runScripted('rename_sql'),
      ...ctx.outboundForeignKeys.map(
        (fk) => `EXEC sp_rename ${lit(schemaOf(ctx), `${fk.name}__new`)}, ${lit(fk.name)}, N'OBJECT'`
      ),
    ];
    steps.push({
      phase: 'finish',
      title: `Drop the old column ${ctx.oldColumn}`,
      rerunSafe: false,
      sql: ['SET XACT_ABORT ON', 'BEGIN TRANSACTION', ...finish.map((s) => `  ${s}`), 'COMMIT TRANSACTION;'].join('\n'),
      note:
        'Only after you have checked the new column and the applications using it. Its indexes, foreign keys and default ' +
        'are dropped first, as SQL Server requires, and the new ones then take their names — in one transaction, so a ' +
        'failure undoes all of it.',
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
