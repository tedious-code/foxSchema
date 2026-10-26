/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Schema browse routes, and the table insight Data Peek shows.
 */
import { scopeOf } from '../../platform/http/scope';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router, reads } from '../../platform/http/router';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import type { AuthedRequest } from '../../platform/http/types';
import type { ConnectionRef } from '../../platform/connections/resolve';
import { getProviderSettings, type DbObjectType } from '@foxschema/db';
import { sendError, sendThrown } from '../../platform/http/respond';
import { rateLimit } from '../../platform/guards/rate-limit';
import { probeTableInsight } from './table-insight.service';

export interface SchemaRouteDeps {
  resolveRef: ConnectionResolver['resolveRef'];
  connectionModule: Record<string, any>;
  loadScopedTables: (...args: any[]) => Promise<any>;
}

export function createSchemaRoutes(deps: SchemaRouteDeps): Router {
  const router = Router();
  router.post('/schema/list', reads, requirePermissions('schema.browse'), async (req: AppRequest, res: FastifyReply) => {
    try {
      const { dialect, option } = await deps.resolveRef(scopeOf(req as AuthedRequest), req.body as ConnectionRef);
      const provider = deps.connectionModule.getProvider(dialect);
      if (!provider.listSchemas) {
        throw new Error(`Provider for dialect "${dialect}" does not support schema listing`);
      }
      const schemas = await provider.listSchemas(option);
      res.send({ schemas });
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to list schemas');
    }
  });

  router.post('/schema/load', reads, requirePermissions('schema.browse'), async (req: AppRequest, res: FastifyReply) => {
    const { scope, ...ref } = req.body as ConnectionRef & { scope: DbObjectType[] };
    try {
      const { dialect, option, schema } = await deps.resolveRef(scopeOf(req as AuthedRequest), ref);
      const settings = getProviderSettings(dialect);
      if (settings.schemaRequired && !schema?.trim()) {
        sendError(res, 'invalid_input', `${settings.label} requires a schema. Load schemas for the connection, then pick one before browsing or editing tables.`);
        return;
      }
      const { tables, warnings } = await deps.loadScopedTables(dialect, option, schema, scope);
      res.send(warnings.length ? { tables, warnings } : { tables });
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to load schema');
    }
  });

  const tableInsightLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
  router.post(
    '/schema/table-insight',
    reads,
    tableInsightLimiter,
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


  return router;
}
