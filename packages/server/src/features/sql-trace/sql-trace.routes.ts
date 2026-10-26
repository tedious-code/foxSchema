/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL Tracer routes, mounted at /api/sql-trace. Every one needs
 * `utility.trace`: a trace shows other people's statements.
 *
 *   POST /start            { connectionId, mode, password? } → status
 *   GET  /:id/events?after → { status, events } after that seq
 *   POST /:id/stop         → status
 *
 * Only saved connections can be traced: Fox activity is reported by saved
 * connection id, and the trace's owner must be able to open the connection.
 */
import type { FastifyReply } from 'fastify';
import { dialectSupportsDbaUtility, type TraceMode } from '@foxschema/sql';
import { Router } from '../../platform/http/router';
import type { AppRequest, AuthedRequest } from '../../platform/http/types';
import { scopeOf, type WorkspaceScope } from '../../platform/http/scope';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { rateLimit } from '../../platform/guards/rate-limit';
import type { ConnectionRef } from '../../platform/connections/resolve';
import { sendError, sendThrown } from '../../platform/http/respond';
import type { SqlTraceService } from './sql-trace.service';

export interface SqlTraceRouteDeps {
  service: SqlTraceService;
  resolveRef: (
    scope: WorkspaceScope | undefined,
    ref: ConnectionRef
  ) => Promise<{ dialect: string; option: Record<string, unknown>; schema: string }>;
}

const MODES: readonly TraceMode[] = ['live', 'fox'];

export function createSqlTraceRoutes(deps: SqlTraceRouteDeps): Router {
  const router = Router();
  const startLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
  // The screen asks about once a second while a trace runs.
  const eventsLimiter = rateLimit({ windowMs: 60 * 1000, max: 180 });
  const trace = requirePermissions('utility.trace');

  router.post('/start', startLimiter, trace, async (req: AppRequest, res: FastifyReply) => {
    const body = (req.body ?? {}) as { connectionId?: unknown; mode?: unknown; password?: unknown };
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
    if (!connectionId) {
      sendError(res, 'invalid_input', 'connectionId is required: only saved connections can be traced.');
      return;
    }
    const mode = body.mode as TraceMode;
    if (!MODES.includes(mode)) {
      sendError(res, 'invalid_input', 'mode must be live or fox.');
      return;
    }
    const authed = req as AuthedRequest;
    try {
      // Resolving proves the caller may open this connection, in either mode.
      const resolved = await deps.resolveRef(scopeOf(authed), {
        connectionId,
        password: typeof body.password === 'string' ? body.password : undefined,
      });
      if (mode === 'live') {
        const support = dialectSupportsDbaUtility(resolved.dialect, 'sessions');
        if (!support.query) {
          sendError(res, 'invalid_input', support.hint || 'This database has no session list to trace. Use Fox activity.');
          return;
        }
      }
      const target = mode === 'live' ? { dialect: resolved.dialect, option: resolved.option } : null;
      res.send({ status: deps.service.start(authed.userId!, connectionId, mode, target) });
    } catch (error: unknown) {
      sendThrown(res, error, 'Could not start the trace');
    }
  });

  router.get('/:id/events', eventsLimiter, trace, async (req: AppRequest, res: FastifyReply) => {
    const { id } = req.params as { id: string };
    const afterRaw = (req.query as { after?: unknown } | undefined)?.after;
    const after = afterRaw === undefined ? 0 : Number(afterRaw);
    if (!Number.isInteger(after) || after < 0) {
      sendError(res, 'invalid_input', 'after must be a whole number.');
      return;
    }
    try {
      res.send(await deps.service.events((req as AuthedRequest).userId!, id, after));
    } catch (error: unknown) {
      sendThrown(res, error, 'Could not read the trace');
    }
  });

  router.post('/:id/stop', trace, async (req: AppRequest, res: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      res.send({ status: deps.service.stop((req as AuthedRequest).userId!, id) });
    } catch (error: unknown) {
      sendThrown(res, error, 'Could not stop the trace');
    }
  });

  return router;
}
