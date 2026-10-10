/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Schema history (Lokee) routes.
 *
 * Extracted verbatim from api/routes.ts; handler bodies are unchanged.
 */
import type { LokeeWeaveStore } from './lokee-weave.service';
import type { WorkspaceScope } from '../../platform/http/scope';
import { scopeOf } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import type { AuthedRequest } from '../../platform/http/types';
import { rateLimit } from '../../platform/guards/rate-limit';
import { targetKey, targetLocks } from '../../platform/guards/target-lock';
import { LOKEE_FULL_SCOPE } from './lokee-scope';
import type { ConnectionRef } from '../../platform/connections/resolve';
import type { ConnectionOptions, MigrationModule } from '@foxschema/db';
import { sendError, sendThrown } from '../../platform/http/respond';
import type { ForceMigrateErrorCode, LokeeRevertErrorCode } from '@foxschema/shared';

export interface HistoryRouteDeps {
  lokee: LokeeWeaveStore;
  captureLiveSchema: (scope: WorkspaceScope, ...args: any[]) => Promise<any>;
  resolveRef: ConnectionResolver['resolveRef'];
  migrationModule: MigrationModule;
  /**
   * Reads a live schema through the provider for a dialect. Force-migrate needs
   * the *target's* current tables to diff a stored version against, and unlike
   * revert it cannot get them from this history — the target may have none.
   */
  loadScopedTables: (...args: any[]) => Promise<any>;
  /**
   * Whether this install runs only migrations committed to Git. Revert and
   * force-migrate change a live schema too, so they are refused while it is on.
   */
  commitRequired: () => Promise<boolean>;
}

const COMMIT_REQUIRED =
  'This install runs only migrations committed to Git, and this changes the schema like a migration. ' +
  'Commit the change as a migration and run it from Migrate, or ask an admin to turn off Require a commit.';

export function createHistoryRoutes(deps: HistoryRouteDeps): Router {
  const router = Router();
  const lokeeCaptureLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

  /**
   * The opening both force-migrate routes share: a version id, and a resolved
   * credential for the target.
   *
   * It sends the refusal itself and returns null, so each caller is one
   * `if (!target) return;`. Only the preamble is shared — what follows
   * legitimately differs, because the execute route takes the target lock
   * before it reads any schema.
   */
  async function resolveForceTarget(
    req: AppRequest,
    res: FastifyReply
  ): Promise<{
    versionId: string;
    dialect: string;
    option: ConnectionOptions;
    schema: string;
  } | null> {
    const body = req.body as ConnectionRef & { versionId?: string };
    const versionId = String(body.versionId ?? '').trim();
    if (!versionId) {
      sendError(res, 'invalid_input', 'versionId is required');
      return null;
    }
    try {
      const { dialect, option, schema } = await deps.resolveRef(
        scopeOf(req as AuthedRequest),
        body
      );
      return { versionId, dialect, option, schema };
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Invalid connection');
      return null;
    }
  }
  router.post(
    '/lokee/capture',
    lokeeCaptureLimiter,
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & { source?: string; migrationRunId?: string };
      try {
        const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
        const result = await deps.captureLiveSchema(
          scopeOf(req as AuthedRequest)!,
          resolved,
          body.source === 'migrate' || body.source === 'revert' ? body.source : 'manual',
          { migrationRunId: body.migrationRunId }
        );
        res.send(result);
      } catch (error: unknown) {
        sendThrown(res, error, 'Failed to capture schema');
      }
    }
  );

  router.get(
    '/lokee/databases',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      res.send({ databases: await deps.lokee.listDatabases(scopeOf(req as AuthedRequest)!) });
    }
  );

  router.get(
    '/lokee/databases/:id/versions',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const versions = await deps.lokee.listVersions(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id),
        Number(req.query.limit) || 100
      );
      res.send({ versions });
    }
  );

  router.get(
    '/lokee/databases/:id/graph',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      // The store scopes every read to the caller, so an unknown or unowned id
      // returns an empty graph rather than another user's history.
      res.send(
        await deps.lokee.graph(
          scopeOf(req as AuthedRequest)!,
          String(req.params.id),
          Number(req.query.limit) || 20
        )
      );
    }
  );

  router.get(
    '/lokee/databases/:id/revert/plan',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const toVersionId = String(req.query.toVersionId ?? '').trim();
      if (!toVersionId) {
        sendError(res, 'invalid_input', 'toVersionId is required');
        return;
      }
      // Optional selective revert: `?objectKeys=a&objectKeys=b`, or omitted for
      // the whole schema.
      // Absent means "whole schema"; present-but-empty means "nothing", and
      // those must stay distinguishable all the way down.
      const objectKeys =
        req.query.objectKeys === undefined
          ? undefined
          : ([] as string[])
              .concat(req.query.objectKeys as string | string[])
              .map((k) => String(k).trim())
              .filter(Boolean);
      const plan = await deps.lokee.planRevert(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id),
        toVersionId,
        undefined,
        undefined,
        objectKeys
      );
      if (!plan) {
        sendError(res, 'not_found', 'Version not found');
        return;
      }
      const { steps: _steps, ...published } = plan;
      res.send(published);
    }
  );

  router.post(
    '/lokee/databases/:id/revert',
    lokeeCaptureLimiter,
    requirePermissions('schema.migrate'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & {
        toVersionId?: string;
        confirmLossy?: boolean;
        /** Revert only these objects; omit for the whole schema. */
        objectKeys?: string[];
      };
      const toVersionId = String(body.toVersionId ?? '').trim();
      if (!toVersionId) {
        sendError(res, 'invalid_input', 'toVersionId is required');
        return;
      }
      let dialect: string;
      let option: ConnectionOptions;
      let schema: string;
      try {
        ({ dialect, option, schema } = await deps.resolveRef(scopeOf(req as AuthedRequest), body));
      } catch (error: unknown) {
        sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Invalid connection');
        return;
      }

      if (await deps.commitRequired()) {
        sendError(res, 'forbidden', COMMIT_REQUIRED);
        return;
      }

      const userId = (req as AuthedRequest).userId!;
      const databaseId = String(req.params.id);

      // One writer at a time, the same lock `/migration/execute` and
      // force-migrate take. Revert was the one route that applied DDL to a live
      // target without it: it plans reverse DDL from the newest captured
      // version, so a migration landing in between leaves this plan derived
      // from a shape that no longer exists. The pre-snapshot drift check below
      // catches drift that was already there when the request arrived — it
      // cannot catch a concurrent writer, because that one moves the schema
      // *after* the snapshot has been taken.
      const lock = targetLocks.acquire(
        targetKey({ dialect, host: option.host, database: option.database, schema }),
        { userId, operation: 'migrate' }
      );
      if (!lock.ok) {
        sendError(res, 'conflict', lock.message, { extra: { heldBy: lock.heldBy.operation } });
        return;
      }

      try {
      // History is keyed by database identity; the execute connection must be
      // that same database or we would apply reverse DDL to the wrong target.
      const identityMatch = await deps.lokee.matchDatabaseIdentity(scopeOf(req as AuthedRequest)!, databaseId, {
        dialect,
        host: option.host ?? null,
        port: option.port ?? null,
        database: option.database ?? null,
        schema: schema ?? null,
      });
      if (identityMatch === 'not_found') {
        sendError(res, 'not_found', 'Database not found');
        return;
      }
      if (identityMatch === 'mismatch') {
        sendError(res, 'conflict', 'The selected connection does not match this schema history. Choose the credential for the same database before reverting.');
        return;
      }

      /**
       * Snapshot the live schema before touching it.
       *
       * Two reasons, and the second is the one that matters. It leaves a
       * version to come back to — but it also makes the plan *correct*:
       * `planRevert` reverses from the newest **captured** version, not from
       * what is actually in the database. If someone changed the schema by
       * hand since the last capture, the reverse DDL was being computed against
       * a picture that no longer existed.
       *
       * So when this snapshot finds drift, the request is refused rather than
       * applied. The caller reviewed a plan built on the old head; running a
       * different one silently is exactly the surprise this is here to stop.
       */
      let preSnapshot: Awaited<ReturnType<HistoryRouteDeps['captureLiveSchema']>>;
      try {
        preSnapshot = await deps.captureLiveSchema(scopeOf(req as AuthedRequest)!, { dialect, option, schema }, 'manual');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'snapshot failed';
        sendError(res, 'failed', `Could not snapshot the schema before reverting: ${message}`);
        return;
      }
      if (preSnapshot.changed) {
        sendRefusal(
          res,
          'schema_drifted',
          `The live schema had changed since the last capture — snapshotted it as v${preSnapshot.versionNumber} ` +
            `(${preSnapshot.changeCount} object change(s)). Review the diff against that version and run the revert again.`,
          { capture: preSnapshot }
        );
        return;
      }

      const objectKeys = Array.isArray(body.objectKeys)
        ? body.objectKeys.map((k) => String(k).trim()).filter(Boolean)
        : undefined;
      const plan = await deps.lokee.planRevert(
        scopeOf(req as AuthedRequest)!,
        databaseId,
        toVersionId,
        dialect,
        schema,
        objectKeys
      );
      if (!plan) {
        sendError(res, 'not_found', 'Version not found');
        return;
      }
      const { steps, ...published } = plan;
      if (plan.alreadyAtTarget || steps.length === 0) {
        res.send({ ok: true, ...published, alreadyAtTarget: true });
        return;
      }
      const refusal = reversalGate(plan.reversal.risk, body, {
        blocked: 'This revert is blocked — existing data cannot be converted.',
        lossy: 'This revert destroys data. Confirm to continue.',
      });
      if (refusal) {
        sendRefusal(res, refusal.code, refusal.error, published);
        return;
      }

      let failed = true;
      let executeError = 'Revert failed';
      try {
        await deps.migrationModule.execute(dialect, option, schema, steps, (event) => {
          if (event.type === 'done') {
            failed = !event.success;
            if (event.error) executeError = event.error;
          }
        });
      } catch (error: unknown) {
        failed = true;
        executeError = error instanceof Error ? error.message : 'Revert failed';
      }
      if (failed) {
        sendError(res, 'failed', executeError, { extra: published });
        return;
      }

      try {
        // Record where this undo came from and where it went, so reading the
        // history later answers "reverted to which version?" rather than just
        // "a revert happened".
        const capture = await deps.captureLiveSchema(scopeOf(req as AuthedRequest)!, { dialect, option, schema }, 'revert', {
          revert: {
            fromVersionId: plan.fromVersion.id,
            toVersionId: plan.toVersion.id,
          },
        });
        res.send({ ok: true, capture, ...published });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'capture failed';
        sendError(res, 'failed', `Schema reverted but capture failed: ${message}`, {
          extra: published,
        });
      }
      } finally {
        // finally, not a trailing call: this handler has eight early returns
        // between here and the acquire — two identity refusals, a snapshot
        // failure, a drift 409, an unknown version, already-at-target, blocked,
        // and unconfirmed-lossy — and any one of them leaving without releasing
        // would hold the database for the 30-minute stale timeout.
        lock.release();
      }
    }
  );

  /**
   * Plan applying a stored version to another database.
   *
   * POST, unlike the revert plan's GET: this one resolves a credential for the
   * *target*, including a session password when the connection was saved
   * without one, and a password has no business in a query string.
   */
  router.post(
    '/lokee/databases/:id/force-migrate/plan',
    // Throttled like capture and revert: this is the most expensive endpoint in
    // the feature — full live introspection of an arbitrary target plus a
    // whole-schema compare — and it was the only one left unmetered.
    lokeeCaptureLimiter,
    requirePermissions('schema.migrate.force'),
    async (req: AppRequest, res: FastifyReply) => {
      const target = await resolveForceTarget(req, res);
      if (!target) return;
      const { versionId, dialect, option, schema } = target;
      try {
        const { tables } = await deps.loadScopedTables(
          dialect,
          option,
          schema ?? '',
          LOKEE_FULL_SCOPE
        );
        const plan = await deps.lokee.planForceMigrate(
          scopeOf(req as AuthedRequest)!,
          String(req.params.id),
          versionId,
          { dialect, host: option.host, database: option.database, schema, tables }
        );
        if (!plan) {
          sendError(res, 'not_found', 'Version not found');
          return;
        }
        const { steps: _steps, ...published } = plan;
        res.send(published);
      } catch (error: unknown) {
        sendThrown(res, error, 'Failed to plan the force migrate');
      }
    }
  );

  /**
   * Apply a stored version to a database that is not the one it came from.
   *
   * This route deliberately does **not** run the identity check the revert
   * route does. Reverting through a connection that points somewhere else is
   * always a mistake; doing it on purpose is this feature. What replaces that
   * guard is everything below: its own permission (`schema.migrate.force`,
   * withheld from owner by default), an explicit `confirmForce` that a lossy
   * acknowledgement cannot stand in for, the same one-writer target lock the
   * migrate route takes, and provenance written into the receiving database's
   * own history so the schema can be traced back to where it came from.
   */
  router.post(
    '/lokee/databases/:id/force-migrate',
    lokeeCaptureLimiter,
    requirePermissions('schema.migrate.force'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as { confirmForce?: boolean; confirmLossy?: boolean };
      const target = await resolveForceTarget(req, res);
      if (!target) return;
      const { versionId, dialect, option, schema } = target;
      if (await deps.commitRequired()) {
        sendError(res, 'forbidden', COMMIT_REQUIRED);
        return;
      }

      const userId = (req as AuthedRequest).userId!;
      const sourceDatabaseId = String(req.params.id);

      // Same lock the migrate route takes, and for the same reason: two writers
      // planning against a schema the other is about to change apply steps
      // derived from a shape that no longer exists.
      const lock = targetLocks.acquire(
        targetKey({ dialect, host: option.host, database: option.database, schema }),
        { userId, operation: 'migrate' }
      );
      if (!lock.ok) {
        sendError(res, 'conflict', lock.message, { extra: { heldBy: lock.heldBy.operation } });
        return;
      }

      try {
        const { tables } = await deps.loadScopedTables(
          dialect,
          option,
          schema ?? '',
          LOKEE_FULL_SCOPE
        );
        const plan = await deps.lokee.planForceMigrate(scopeOf(req as AuthedRequest)!, sourceDatabaseId, versionId, {
          dialect,
          host: option.host,
          database: option.database,
          schema,
          tables,
        });
        if (!plan) {
          sendError(res, 'not_found', 'Version not found');
          return;
        }
        const { steps, ...published } = plan;
        // `alreadyMatches` *is* `steps.length === 0` (see planForceMigrate), so
        // testing both said the same thing twice — and re-asserting the flag on
        // the way out implied it might have been false.
        if (plan.alreadyMatches) {
          res.send({ ok: true, ...published });
          return;
        }
        const refusal = reversalGate(plan.reversal.risk, body, {
          blocked: 'This cannot be applied — existing data cannot be converted.',
          lossy: 'Applying this version destroys data on the target. Confirm to continue.',
          force:
            `This applies v${plan.version.number} to ${option.database ?? 'the selected database'}` +
            ', which is not the database this history was captured from. Confirm to continue.',
        });
        if (refusal) {
          sendRefusal(res, refusal.code, refusal.error, published);
          return;
        }

        let failed = true;
        let executeError = 'Force migrate failed';
        try {
          await deps.migrationModule.execute(dialect, option, schema, steps, (event) => {
            if (event.type === 'done') {
              failed = !event.success;
              if (event.error) executeError = event.error;
            }
          });
        } catch (error: unknown) {
          failed = true;
          executeError = error instanceof Error ? error.message : 'Force migrate failed';
        }
        if (failed) {
          sendError(res, 'failed', executeError, { extra: published });
          return;
        }

        try {
          // The receiving database keeps its own history — a different identity
          // means a different `lokee_databases` row — so without this the new
          // version would record only that the schema changed, losing the one
          // fact worth keeping: which history, and which version, it came from.
          const capture = await deps.captureLiveSchema(
            scopeOf(req as AuthedRequest)!,
            { dialect, option, schema },
            'force-migrate',
            { appliedFrom: { databaseId: sourceDatabaseId, versionId: plan.version.id } }
          );
          res.send({ ok: true, capture, ...published });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'capture failed';
          sendError(res, 'failed', `Schema applied but capture failed: ${message}`, {
            extra: published,
          });
        }
      } catch (error: unknown) {
        sendThrown(res, error, 'Force migrate failed');
      } finally {
        // finally, not a trailing call: a throw anywhere above would otherwise
        // leave the target locked until the stale timeout.
        lock.release();
      }
    }
  );

  router.patch(
    '/lokee/databases/:id/versions/:versionId',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as { name?: string | null; description?: string | null };
      const updated = await deps.lokee.updateVersionMeta(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id),
        String(req.params.versionId),
        {
          name: body.name,
          description: body.description,
        }
      );
      if (!updated) {
        sendError(res, 'not_found', 'Version not found');
        return;
      }
      res.send({ version: updated });
    }
  );

  router.get(
    '/lokee/databases/:id/inspect',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const versionId = String(req.query.versionId ?? '').trim();
      const objectKey = String(req.query.objectKey ?? '').trim();
      if (!versionId || !objectKey) {
        sendError(res, 'invalid_input', 'versionId and objectKey are required');
        return;
      }
      const result = await deps.lokee.inspectObject(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id),
        versionId,
        objectKey
      );
      if (!result) {
        sendError(res, 'not_found', 'Object not found');
        return;
      }
      res.send(result);
    }
  );

  router.get(
    '/lokee/databases/:id/compare',
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const versionId = String(req.query.versionId ?? '').trim();
      if (!versionId) {
        sendError(res, 'invalid_input', 'versionId is required');
        return;
      }
      const against = String(req.query.againstVersionId ?? '').trim();
      const result = await deps.lokee.diffVersions(
        scopeOf(req as AuthedRequest)!,
        String(req.params.id),
        versionId,
        against || undefined
      );
      if (!result) {
        sendError(res, 'not_found', 'Version not found');
        return;
      }
      res.send(result);
    }
  );

  return router;
}

type LokeeRefusalCode = LokeeRevertErrorCode | ForceMigrateErrorCode;

/**
 * The confirmation ladder shared by revert and force-migrate: a blocked plan
 * is refused outright, a lossy one needs `confirmLossy`, and — force-migrate
 * only, when `msg.force` is given — writing onto a database the history was
 * not captured from needs `confirmForce` as well. That last answer is checked
 * after the others and is never satisfied by `confirmLossy`: agreeing to lose
 * data is not agreeing to target a different database, and a plan that
 * destroys nothing still needs it.
 */
function reversalGate(
  risk: string,
  confirmed: { confirmLossy?: unknown; confirmForce?: unknown },
  msg: { blocked: string; lossy: string; force?: string }
): { code: LokeeRefusalCode; error: string } | null {
  if (risk === 'blocked') return { code: 'blocked', error: msg.blocked };
  if (risk === 'lossy' && confirmed.confirmLossy !== true) {
    return { code: 'confirm_lossy', error: msg.lossy };
  }
  if (msg.force !== undefined && confirmed.confirmForce !== true) {
    return { code: 'confirm_force', error: msg.force };
  }
  return null;
}

/**
 * A 409 carrying a Lokee refusal code. These codes are the Lokee wire contract
 * (`@foxschema/shared` lokee-wire), not `ErrorCode`, so they are sent directly
 * rather than through `sendError`; `extra` (the plan, or the fresh capture)
 * goes last, as before.
 */
function sendRefusal(res: FastifyReply, code: LokeeRefusalCode, error: string, extra: object): void {
  res.status(409).send({ ok: false, code, error, ...extra });
}
