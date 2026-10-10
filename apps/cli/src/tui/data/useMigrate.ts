import { useEffect, useRef, useState } from 'react';
import { normalizeTableSchemas, type MigrationEvent, type MigrationStep, type TableDiff } from '@foxschema/db';
import { connectionModule, migrationModule, sqlGenerator } from '../../runtime/engine';
import { getContext } from '../../runtime/store';
import { friendlyError } from '../../format/friendlyError';
import type { ConnRef } from '../types';

export interface ObjectResult {
  name: string;
  type: string;
  action: string;
  status: string;
  error?: string;
}

export type MigrateOutcome =
  | { status: 'running' }
  | { status: 'success' }
  | { status: 'partial_success'; failedCount: number }
  | { status: 'failed'; error?: string }
  | { status: 'rolled_back'; error?: string };

/**
 * Runs a migration and streams per-object progress. Mirrors commands/migrate.ts's
 * execute-path sequence exactly: history.start -> snapshot -> migrationModule.execute
 * -> history.finish, including the same PARTIAL_SUCCESS derivation (an object failed
 * but continueOnError let the run still commit).
 */
export function useMigrate(
  target: ConnRef,
  steps: MigrationStep[],
  sql: string,
  continueOnError: boolean
): { results: ObjectResult[]; outcome: MigrateOutcome; runId: string | null } {
  const [results, setResults] = useState<ObjectResult[]>([]);
  const [outcome, setOutcome] = useState<MigrateOutcome>({ status: 'running' });
  const [runId, setRunId] = useState<string | null>(null);
  const resultsRef = useRef<Map<string, ObjectResult>>(new Map());

  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // steps/sql are stable for the life of this screen; run exactly once
    started.current = true;

    (async () => {
      const ctx = await getContext();
      let id: string | null = null;
      try {
        id = await ctx.history.start(ctx.scope, {
          dialect: target.dialect,
          host: target.option.host,
          database: target.option.database,
          schema: target.schema,
          objectCount: steps.length,
          script: sql,
        });
        setRunId(id);
      } catch {
        /* history is best-effort */
      }

      let snapshotDdl: string | undefined;
      let finalStatus: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'ROLLED_BACK' = 'FAILED';
      let finalError: string | undefined;

      const send = (e: MigrationEvent) => {
        if (e.type === 'snapshot') {
          snapshotDdl = e.ddl;
        } else if (e.type === 'object') {
          resultsRef.current.set(e.objectName, {
            name: e.objectName,
            type: e.objectType,
            action: e.action,
            status: e.status,
            error: e.error,
          });
          setResults([...resultsRef.current.values()]);
        } else if (e.type === 'done') {
          const failedCount = [...resultsRef.current.values()].filter((r) => r.status === 'FAILED').length;
          finalStatus = e.success ? (failedCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS') : e.rolledBack ? 'ROLLED_BACK' : 'FAILED';
          finalError = e.error;
          setOutcome(
            finalStatus === 'SUCCESS'
              ? { status: 'success' }
              : finalStatus === 'PARTIAL_SUCCESS'
                ? { status: 'partial_success', failedCount }
                : finalStatus === 'ROLLED_BACK'
                  ? { status: 'rolled_back', error: finalError }
                  : { status: 'failed', error: finalError }
          );
        }
      };

      try {
        const provider = connectionModule.getProvider(target.dialect);
        if (provider.getTables) {
          const objs = normalizeTableSchemas(await provider.getTables(target.option, target.schema));
          snapshotDdl = `-- Target snapshot (pre-migration) · ${new Date().toISOString()}\n\n` + objs.map((o) => sqlGenerator.generateObjectDdl(o)).join('\n');
        }
        await migrationModule.execute(target.dialect, target.option, target.schema, steps, send, { continueOnError });
      } catch (err) {
        finalStatus = 'FAILED';
        finalError = friendlyError(err);
        setOutcome({ status: 'failed', error: finalError });
      }

      if (id) {
        try {
          await ctx.history.finish(id, { status: finalStatus, results: [...resultsRef.current.values()], snapshotDdl, error: finalError });
        } catch {
          /* best-effort */
        }
      }
    })();
  }, [target, steps, sql, continueOnError]);

  return { results, outcome, runId };
}

/** Plain helper so MigrateConfirmScreen can build the plan/SQL preview without duplicating the mapping shape used everywhere else. */
export function buildMigrationPlan(
  changed: TableDiff[],
  source: ConnRef,
  target: ConnRef,
  /** Full compare result — needed for Cockroach-style dependent DROP/CREATE. */
  contextDiffs: TableDiff[] = changed
) {
  const mapping = { sourceSchema: source.schema, targetSchema: target.schema, sourceDialect: source.dialect, targetDialect: target.dialect };
  return {
    steps: sqlGenerator.generateMigrationPlan(changed, target.dialect, mapping, contextDiffs),
    sql: sqlGenerator.generateMigrationSql(changed, target.dialect, mapping, contextDiffs),
  };
}
