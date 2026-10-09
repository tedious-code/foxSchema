import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { normalizeTableSchemas, type TableDiff } from '@foxschema/db';
import { ensureSourceTarget, resolveRef } from '../runtime/connectionRef';
import { friendlyError } from '../format/friendlyError';
import { compareModule, connectionModule, filterIndexDiffs, loadScopedTables, migrationModule, parseScope, sqlGenerator } from '../runtime/engine';
import { getContext } from '../runtime/store';

export interface MigrateOptions {
  source?: string;
  target?: string;
  sourceSchema?: string;
  targetSchema?: string;
  scope?: string;
  execute?: boolean;
  yes?: boolean;
  continueOnError?: boolean;
  includeIndexes?: boolean;
}

interface MigrationEvent {
  type?: string;
  ddl?: string;
  objectName?: string;
  objectType?: string;
  action?: string;
  status?: string;
  error?: string;
  success?: boolean;
  rolledBack?: boolean;
}

/**
 * `migrate` — diff source→target and apply the changes to the target.
 * Dry-run by default (prints the SQL); --execute applies it (--yes skips confirm).
 */
export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const { source, target } = await ensureSourceTarget(opts);
  const scope = parseScope(opts.scope);
  const src = await resolveRef({ connection: source, schema: opts.sourceSchema });
  const tgt = await resolveRef({ connection: target, schema: opts.targetSchema });

  const [sourceTables, targetTables] = await Promise.all([
    loadScopedTables(src.dialect, src.option, src.schema, scope),
    loadScopedTables(tgt.dialect, tgt.option, tgt.schema, scope),
  ]);

  // Cross-dialect aware: both dialects are threaded through so equivalent native
  // types aren't false-flagged and generated DDL is translated to the target.
  const mapping = {
    sourceSchema: src.schema,
    targetSchema: tgt.schema,
    sourceDialect: src.dialect,
    targetDialect: tgt.dialect,
  };

  const result = await compareModule.compare(sourceTables, targetTables, {
    source: src.dialect,
    target: tgt.dialect,
  });
  const changed = filterIndexDiffs(result.tables, !!opts.includeIndexes).filter((d: TableDiff) => d.status !== 'UNCHANGED');
  if (changed.length === 0) {
    console.log(chalk.green('✔ Target already matches source — nothing to migrate.'));
    return;
  }

  // Pass the full compare (incl. UNCHANGED) so dialects without a runtime
  // dependent-view guard (CockroachDB) can DROP/CREATE dependents around ALTER —
  // same contract as the web UI.
  const sql = sqlGenerator.generateMigrationSql(changed, tgt.dialect, mapping, result.tables);
  const steps = sqlGenerator.generateMigrationPlan(changed, tgt.dialect, mapping, result.tables);

  if (!opts.execute) {
    console.log(chalk.dim(`-- ${steps.length} change(s) to apply to the target\n`));
    console.log(sql);
    console.log(chalk.dim('\n-- dry run. Re-run with --execute (and --yes) to apply.'));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: `Apply ${steps.length} change(s) to ${tgt.option.host ?? ''}/${tgt.option.database ?? ''} (${tgt.schema})?`,
      default: false,
    });
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  const ctx = await getContext();
  let runId: string | null = null;
  try {
    runId = await ctx.history.start(ctx.scope, {
      dialect: tgt.dialect,
      host: tgt.option.host,
      database: tgt.option.database,
      schema: tgt.schema,
      objectCount: steps.length,
      script: sql,
    });
  } catch {
    /* history is best-effort */
  }

  let snapshotDdl: string | undefined;
  const results = new Map<string, { name: string; type: string; action: string; status: string; error?: string }>();
  let finalStatus = 'FAILED';
  let finalError: string | undefined;

  const send = (e: MigrationEvent) => {
    if (e?.type === 'snapshot') {
      snapshotDdl = e.ddl;
    } else if (e?.type === 'object') {
      results.set(e.objectName!, {
        name: e.objectName!,
        type: e.objectType!,
        action: e.action!,
        status: e.status!,
        error: e.error,
      });
      const mark = e.status === 'SUCCESS' ? chalk.green('✔') : e.status === 'FAILED' ? chalk.red('✗') : chalk.dim('…');
      console.log(`  ${mark} ${e.action} ${e.objectType} ${e.objectName}${e.error ? chalk.red(' — ' + e.error) : ''}`);
    } else if (e?.type === 'done') {
      // continueOnError can commit successfully while individual objects failed and
      // were skipped — distinguish that from a clean run (mirrors routes.ts's history log).
      const anyObjectFailed = [...results.values()].some((r) => r.status === 'FAILED');
      finalStatus = e.success ? (anyObjectFailed ? 'PARTIAL_SUCCESS' : 'SUCCESS') : e.rolledBack ? 'ROLLED_BACK' : 'FAILED';
      finalError = e.error;
    }
  };

  try {
    const provider = connectionModule.getProvider(tgt.dialect);
    if (provider.getTables) {
      const objs = normalizeTableSchemas(await provider.getTables(tgt.option, tgt.schema));
      snapshotDdl =
        `-- Target snapshot (pre-migration) · ${new Date().toISOString()}\n\n` +
        objs.map((o) => sqlGenerator.generateObjectDdl(o)).join('\n');
    }
    await migrationModule.execute(tgt.dialect, tgt.option, tgt.schema, steps, send, { continueOnError: !!opts.continueOnError });
  } catch (err) {
    finalStatus = 'FAILED';
    finalError = friendlyError(err);
    send({ type: 'done', success: false, rolledBack: false, error: finalError });
  }

  if (runId) {
    try {
      await ctx.history.finish(runId, {
        status: finalStatus as 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'ROLLED_BACK',
        results: [...results.values()],
        snapshotDdl,
        error: finalError,
      });
    } catch {
      /* best-effort */
    }
  }

  if (finalStatus === 'SUCCESS') {
    console.log(chalk.green(`\n✔ Migration applied (${steps.length} change(s)).`));
  } else if (finalStatus === 'PARTIAL_SUCCESS') {
    const failedCount = [...results.values()].filter((r) => r.status === 'FAILED').length;
    console.log(chalk.yellow(`\n⚠ Migration completed with ${failedCount} failure(s) — skipped and continued.`));
  } else {
    console.error(chalk.red(`\n✗ Migration ${finalStatus.toLowerCase()}${finalError ? ': ' + finalError : ''}`));
    process.exitCode = 1;
  }
}
