/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Migration routes: execute (NDJSON stream) and run history.
 *
 * Extracted verbatim from api/routes.ts. This one executes DDL against real
 * databases, so the handler bodies are copied unchanged and only closure
 * references become explicit deps — a rewrite here does not belong in a move.
 */
import type { WorkspaceScope } from '../../platform/http/scope';
import { scopeOf } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import { streamWrite, streamEnd } from '../../platform/http/reply';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import type { ConnectionOptions, MigrationStep } from '@foxschema/db';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { idempotency } from '../../platform/guards/idempotency';
import { targetKey, targetLocks } from '../../platform/guards/target-lock';
import { gitServices, type GitMigrationsService } from '../git/git-migrations.service';
import type { AuthedRequest } from '../../platform/http/types';
import type { ConnectionRef } from '../../platform/connections/resolve';
import type {
  MigrationHistoryStore,
  MigrationObjectResult,
  MigrationRunStatus,
} from './migration-history.service';
import { sendError } from '../../platform/http/respond';

export interface MigrationRouteDeps {
  resolveRef: ConnectionResolver['resolveRef'];
  migrationModule: Record<string, any>;
  migrationHistory: MigrationHistoryStore;
  connectionModule: Record<string, any>;
  sqlGenerator: Record<string, any>;
  captureLiveSchema: (scope: WorkspaceScope, ...args: any[]) => Promise<any>;
  normalizeTableSchemas: (...args: any[]) => any;
  /** Committed migrations; defaults to the app's shared Git services. */
  gitMigrations?: Pick<GitMigrationsService, 'read' | 'recordApplied' | 'commitRequired' | 'canSee'>;
}

/** A run of a committed migration names the file and the exact commit. */
interface GitRunRef {
  repoId: string;
  branch?: string;
  commit: string;
  path: string;
}

export function createMigrationRoutes(deps: MigrationRouteDeps): Router {
  const router = Router();
  const gitMigrations = deps.gitMigrations ?? gitServices().migrations;
  // A factory, not the middleware — see the editor extraction.
  const writeIdempotency = idempotency();
  router.post('/migration/execute', requirePermissions('schema.migrate'), writeIdempotency, async (req: AppRequest, res: FastifyReply) => {
    const { steps: postedSteps, continueOnError, git: gitRun, ...ref } = req.body as ConnectionRef & {
      steps: MigrationStep[];
      continueOnError?: boolean;
      git?: GitRunRef;
    };
    let dialect: string;
    let option: ConnectionOptions;
    let schema: string;
    try {
      ({ dialect, option, schema } = await deps.resolveRef(scopeOf(req as AuthedRequest), ref));
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Invalid connection');
      return;
    }

    // A committed migration runs exactly the steps in its file at that
    // commit — never steps the browser sent alongside — so what reaches the
    // database is what was reviewed.
    let steps = postedSteps;
    if (gitRun) {
      if (!gitRun.repoId || !gitRun.path || !/^[0-9a-f]{40}$/.test(gitRun.commit ?? '')) {
        sendError(res, 'invalid_input', 'A committed migration needs its repository, file path and full commit id.');
        return;
      }
      if (!(await gitMigrations.canSee(gitRun.repoId, req as AuthedRequest))) {
        sendError(res, 'not_found', 'Repository not found.');
        return;
      }
      try {
        const file = await gitMigrations.read(gitRun.repoId, gitRun.commit, gitRun.path);
        if (file.header.dialect.toLowerCase() !== dialect.toLowerCase()) {
          sendError(res, 'invalid_input', `This migration was written for ${file.header.dialect}; the target is ${dialect}.`);
          return;
        }
        steps = file.steps;
      } catch (error: unknown) {
        sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Could not read the committed migration.');
        return;
      }
    } else if (await gitMigrations.commitRequired()) {
      sendError(
        res,
        'forbidden',
        'Migrations must be committed to Git before they run on this install. Commit the plan, then run it from its commit.'
      );
      return;
    }

    // One writer at a time. A second migration planned against a schema this
    // one is about to change would apply steps derived from a shape that no
    // longer exists, and the database will not arbitrate that for us.
    const lock = targetLocks.acquire(
      targetKey({ dialect, host: option.host, database: option.database, schema }),
      { userId: (req as AuthedRequest).userId!, operation: 'migrate' }
    );
    if (!lock.ok) {
      sendError(res, 'conflict', lock.message, { extra: { heldBy: lock.heldBy.operation } });
      return;
    }

    // finally, not a trailing call: an unexpected throw anywhere below would
    // otherwise leave the target locked until the stale timeout, blocking
    // everyone from a database that is actually free.
    try {
    // Record this run in history (best-effort — never let logging break a deploy).
    const userId = (req as AuthedRequest).userId!;
    const script = steps
      .map((s) => `-- ${s.action} ${s.objectType} ${s.objectName}\n${s.statements.join('\n')}`)
      .join('\n\n');
    let runId: string | null = null;
    try {
      runId = await deps.migrationHistory.start(scopeOf(req as AuthedRequest)!, {
        dialect,
        host: option.host,
        database: option.database,
        schema,
        objectCount: steps.length,
        script,
        ...(gitRun ? { git: gitRun } : {}),
      });
    } catch {
      /* history is non-critical */
    }

    // Stream NDJSON progress events as the migration runs, while capturing the
    // snapshot, per-object results, and final status for the history record.
    res.header('Content-Type', 'application/x-ndjson');
    res.header('Cache-Control', 'no-cache');
    let snapshotDdl: string | undefined;
    const resultMap = new Map<string, MigrationObjectResult>();
    let finalStatus: MigrationRunStatus = 'FAILED';
    let finalError: string | undefined;
    let captureAfter = false;
    const send = (event: any) => {
      streamWrite(res, JSON.stringify(event) + '\n');
      if (event?.type === 'snapshot') {
        snapshotDdl = event.ddl;
      } else if (event?.type === 'object') {
        // Keep the latest status per object (RUNNING → SUCCESS/FAILED).
        resultMap.set(event.objectName, {
          name: event.objectName,
          type: event.objectType,
          action: event.action,
          status: event.status,
          error: event.error,
        });
      } else if (event?.type === 'done') {
        // continueOnError can commit successfully while individual objects failed
        // and were skipped — distinguish that from a clean run for the history log.
        const anyObjectFailed = Array.from(resultMap.values()).some((r) => r.status === 'FAILED');
        finalStatus = event.success
          ? (anyObjectFailed ? 'PARTIAL_SUCCESS' : 'SUCCESS')
          : event.rolledBack ? 'ROLLED_BACK' : 'FAILED';
        finalError = event.error;
        captureAfter = event.success === true;
      }
    };

    try {
      // 1. Snapshot the target schema DDL before touching anything
      const provider = deps.connectionModule.getProvider(dialect);
      if (provider.getTables) {
        const targetObjects = deps.normalizeTableSchemas(await provider.getTables(option, schema));
        let snapshot = `-- =========================================================================\n`;
        snapshot += `-- Target schema snapshot (pre-migration)\n`;
        snapshot += `-- Schema: ${schema}  |  Taken At: ${new Date().toISOString()}\n`;
        snapshot += `-- =========================================================================\n\n`;
        snapshot += targetObjects.map((t: { name?: string }) => deps.sqlGenerator.generateObjectDdl(t)).join('\n');
        send({ type: 'snapshot', ddl: snapshot });
      }

      // Content-addressed Lokee snapshot of the target *before* DDL, so a first
      // migrate still has a baseline version to compare against.
      try {
        const before = await deps.captureLiveSchema(
          scopeOf(req as AuthedRequest)!,
          { dialect, option, schema },
          'migrate',
          { migrationRunId: runId ?? undefined }
        );
        send({ type: 'lokee', phase: 'before', ...before });
      } catch (error: unknown) {
        send({
          type: 'lokee',
          phase: 'before',
          error: error instanceof Error ? error.message : 'Lokee snapshot failed',
        });
      }

      // 2. Execute the plan in a single transaction, reporting per object
      await deps.migrationModule.execute(dialect, option, schema, steps, send, { continueOnError: !!continueOnError });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Migration failed';
      finalStatus = 'FAILED';
      finalError = message;
      send({ type: 'done', success: false, rolledBack: false, error: message });
    }

    if (captureAfter) {
      try {
        const after = await deps.captureLiveSchema(
          scopeOf(req as AuthedRequest)!,
          { dialect, option, schema },
          'migrate',
          { migrationRunId: runId ?? undefined }
        );
        send({ type: 'lokee', phase: 'after', ...after });
      } catch (error: unknown) {
        send({
          type: 'lokee',
          phase: 'after',
          error: error instanceof Error ? error.message : 'Lokee snapshot failed',
        });
      }
    }

    // A committed migration that ran cleanly is applied to this database for
    // good — recorded apart from run history, which is pruned. A run with
    // failed steps (continueOnError reports it as a success) applied only part
    // of it, so it stays incoming; its run history still names the commit.
    // Widened: finalStatus is set inside the stream callback, which TypeScript does not follow.
    const outcome = finalStatus as MigrationRunStatus;
    if (gitRun && outcome === 'SUCCESS') {
      try {
        await gitMigrations.recordApplied({
          repoId: gitRun.repoId,
          path: gitRun.path,
          commit: gitRun.commit,
          targetKey: targetKey({ dialect, host: option.host, database: option.database, schema }),
          status: outcome,
          runId,
          userId,
        });
      } catch {
        /* the run itself succeeded; the listing can be corrected by running again */
      }
    }

    // Finalize the history record with the outcome.
    if (runId) {
      try {
        await deps.migrationHistory.finish(runId, {
          status: finalStatus,
          results: [...resultMap.values()],
          snapshotDdl,
          error: finalError,
        });
      } catch {
        /* history is non-critical */
      }
    }

    streamEnd(res);
    } finally {
      lock.release();
    }
  });

  router.get('/migrations', async (req: AppRequest, res: FastifyReply) => {
    res.send({ runs: await deps.migrationHistory.list(scopeOf(req as AuthedRequest)!) });
  });

  router.post('/migrations/delete', async (req: AppRequest, res: FastifyReply) => {
    const ids = Array.isArray((req.body as { ids?: unknown }).ids)
      ? ((req.body as { ids: unknown[] }).ids.filter((i) => typeof i === 'string') as string[])
      : [];
    const removed = await deps.migrationHistory.removeMany(scopeOf(req as AuthedRequest)!, ids);
    res.send({ removed });
  });

  router.delete('/migrations', async (req: AppRequest, res: FastifyReply) => {
    const removed = await deps.migrationHistory.clear(scopeOf(req as AuthedRequest)!);
    res.send({ removed });
  });

  router.get('/migrations/:id', async (req: AppRequest, res: FastifyReply) => {
    const run = await deps.migrationHistory.get(scopeOf(req as AuthedRequest)!, String(req.params.id));
    if (!run) {
      sendError(res, 'not_found', 'Migration run not found');
      return;
    }
    res.send({ run });
  });

  router.delete('/migrations/:id', async (req: AppRequest, res: FastifyReply) => {
    const removed = await deps.migrationHistory.remove(scopeOf(req as AuthedRequest)!, String(req.params.id));
    if (!removed) {
      sendError(res, 'not_found', 'Migration run not found');
      return;
    }
    res.send({ ok: true });
  });

  return router;
}
