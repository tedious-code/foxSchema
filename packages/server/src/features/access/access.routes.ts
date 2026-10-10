/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access routes: index fragmentation, DBA utilities, database access.
 *
 * Extracted from api/routes.ts verbatim — the handler bodies are unchanged, so
 * this move cannot alter behaviour. Splitting them into handler/controller
 * layers is a separate step, deliberately not mixed with the extraction.
 */
import { scopeOf } from '../../platform/http/scope';
import type { WorkspaceScope } from '../../platform/http/scope';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import type { ConnectionModule } from '@foxschema/db';
import { requireAnyPermission, requirePermissions } from '../../platform/authorization/rbac.guard';
import { rateLimit } from '../../platform/guards/rate-limit';
import type { AuthedRequest } from '../../platform/http/types';
import type { ConnectionRef } from '../../platform/connections/resolve';
import { probeTableFragmentation, mapPool } from './index-fragmentation.service';
import { probeDbaUtility } from './dba-utilities.service';
import { probeTableInsight } from '../schema/table-insight.service';
import type { DbaUtilityKind } from '@foxschema/db';
import { probeDbAccess } from './db-access.service';
import {
  buildIndexFragmentationCustomTemplate,
  dialectSupportsIndexFragmentation,
} from '@foxschema/db';
import { sendError, sendThrown } from '../../platform/http/respond';

export interface AccessRouteDeps {
  resolveRef: (
    scope: WorkspaceScope | undefined,
    ref: ConnectionRef
  ) => Promise<{ dialect: string; option: Record<string, unknown>; schema: string }>;
  connectionModule: ConnectionModule;
}

export function createAccessRoutes(deps: AccessRouteDeps): Router {
  const router = Router();
  const indexFragLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
  const indexFragBatchLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
  const dbaUtilityLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
  const dbAccessLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

  router.post(
    '/schema/index-fragmentation',
    indexFragLimiter,
    requirePermissions('utility.access'),
    async (req: AppRequest, res: FastifyReply) => {
    const body = req.body as ConnectionRef & {
      table?: unknown;
      schema?: unknown;
      customSql?: unknown;
      preferCustom?: unknown;
    };
    const table = typeof body.table === 'string' ? body.table.trim() : '';
    if (!table) {
      sendError(res, 'invalid_input', 'table is required.');
      return;
    }
    const customSql = typeof body.customSql === 'string' ? body.customSql.trim() : '';
    const preferCustom = body.preferCustom === true;
    try {
      const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
      const schema =
        (typeof body.schema === 'string' && body.schema.trim()) || resolved.schema || '';
      const probed = await probeTableFragmentation({
        dialect: resolved.dialect,
        option: resolved.option,
        schema,
        table,
        customSql,
        preferCustom,
      });
      if (!probed.ok) {
        const { status, ...rest } = probed.failure;
        res.status(status).send(rest);
        return;
      }
      res.send(probed.value);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to load index fragmentation';
      sendError(res, 'failed', message);
    }
  });

  router.post(
    '/schema/index-fragmentation-batch',
    indexFragBatchLimiter,
    requirePermissions('utility.access'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & {
        tables?: unknown;
        schema?: unknown;
      };
      const tables = Array.isArray(body.tables)
        ? body.tables
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      if (tables.length === 0) {
        sendError(res, 'invalid_input', 'tables[] is required.');
        return;
      }
      if (tables.length > 80) {
        sendError(res, 'invalid_input', 'At most 80 tables per batch request.');
        return;
      }
      try {
        const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
        const schema =
          (typeof body.schema === 'string' && body.schema.trim()) || resolved.schema || '';
        const support = dialectSupportsIndexFragmentation(resolved.dialect);
        const results = await mapPool(tables, 3, async (table) => {
          const probed = await probeTableFragmentation({
            dialect: resolved.dialect,
            option: resolved.option,
            schema,
            table,
          });
          if (!probed.ok) {
            return {
              table,
              ok: false as const,
              error: probed.failure.error,
              rows: [],
              defrag: {} as Record<string, string[]>,
            };
          }
          return {
            table,
            ok: true as const,
            rows: probed.value.rows,
            defrag: probed.value.defrag,
            mode: probed.value.mode,
            source: probed.value.source,
            warning: probed.value.warning,
          };
        });
        res.send({
          support,
          dialect: resolved.dialect,
          schema,
          results,
          customSqlTemplate: buildIndexFragmentationCustomTemplate({
            dialect: resolved.dialect,
            schema,
            table: tables[0]!,
          }),
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Failed to load index fragmentation batch';
        sendError(res, 'failed', message);
      }
    }
  );

  router.post(
    '/schema/dba-utility',
    dbaUtilityLimiter,
    requirePermissions('utility.access'),
    async (req: AppRequest, res: FastifyReply) => {
    const body = req.body as ConnectionRef & {
      kind?: unknown;
      schema?: unknown;
    };
    const kindRaw = typeof body.kind === 'string' ? body.kind.trim() : '';
    const allowed: DbaUtilityKind[] = ['pool', 'sessions', 'system', 'sizes'];
    if (!allowed.includes(kindRaw as DbaUtilityKind)) {
      sendError(res, 'invalid_input', 'kind must be one of: pool, sessions, system, sizes.');
      return;
    }
    const kind = kindRaw as DbaUtilityKind;
    try {
      const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
      const schema =
        (typeof body.schema === 'string' && body.schema.trim()) || resolved.schema || '';
      const probed = await probeDbaUtility({
        dialect: resolved.dialect,
        option: resolved.option,
        kind,
        schema,
      });
      if (!probed.ok) {
        const { status, ...rest } = probed.failure;
        res.status(status).send(rest);
        return;
      }
      res.send({ ...probed.value, dialect: resolved.dialect, schema });
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to run DBA utility');
    }
  });

  router.post(
    '/schema/table-insight',
    dbaUtilityLimiter,
    // This powers Data Peek's Insight tab in the SQL Editor. Requiring
    // utility.access locked the whole tab out for the built-in viewer role,
    // even though viewers can open Data Peek and run its read-only queries.
    requirePermissions('editor.run'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & { schema?: unknown; table?: unknown };
      const table = typeof body.table === 'string' ? body.table.trim() : '';
      if (!table) {
        sendError(res, 'invalid_input', 'table is required.');
        return;
      }
      try {
        const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
        const schema =
          (typeof body.schema === 'string' && body.schema.trim()) || resolved.schema || '';
        const probed = await probeTableInsight({
          dialect: resolved.dialect,
          option: resolved.option,
          schema,
          table,
        });
        if (!probed.ok) {
          const { status, ...rest } = probed.failure;
          res.status(status).send(rest);
          return;
        }
        res.send({ ...probed.value, dialect: resolved.dialect });
      } catch (error: unknown) {
        sendThrown(res, error, 'Failed to load table insight');
      }
    }
  );

  router.post(
    '/schema/db-access',
    dbAccessLimiter,
    // Access workspace tabs use access.*; Utilities → Database Access uses
    // utility.access. Either family may load the catalog.
    requireAnyPermission(
      'utility.access',
      'access.access',
      'access.users',
      'access.builder',
      'access.diff',
      'access.inspector',
      'access.report',
    ),
    async (req: AppRequest, res: FastifyReply) => {
      const body = req.body as ConnectionRef & { schema?: unknown };
      try {
        const resolved = await deps.resolveRef(scopeOf(req as AuthedRequest), body);
        const schema =
          (typeof body.schema === 'string' && body.schema.trim()) || resolved.schema || '';
        const probed = await probeDbAccess({
          dialect: resolved.dialect,
          option: resolved.option,
          schema,
        });
        if (!probed.ok) {
          const { status, ...rest } = probed.failure;
          res.status(status).send(rest);
          return;
        }
        res.send(probed.value);
      } catch (error: unknown) {
        sendThrown(res, error, 'Failed to load database users and privileges');
      }
    }
  );

  return router;
}
