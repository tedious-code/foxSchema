/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * FoxWorkflow control-plane settings, engine health, and the engine proxy the
 * Workflow designer talks through.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest, RouteHandler } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { connectionCredentialId, type AdminConfigPut } from '@foxschema/workflow-contract';
import { requirePermissions } from '../authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { beginStream, pathOf, streamEnd, streamWrite } from '../../platform/http/reply';
import { WorkflowSettingsService } from './workflow-settings.service';
import { WorkflowConnectionGrants } from './workflow-connection-grants.service';
import { actorOf } from '../../platform/http/actor-of';
import {
  ENGINE_ROUTES,
  EngineNotAcceptingRunsError,
  EngineUnavailableError,
  engineBaseUrl,
  WorkflowEngineProxyService,
  type EngineRoute,
} from './workflow-engine-proxy.service';

/** Engine response headers worth passing on. Cookies and hop-by-hop headers are not. */
const RELAYED_HEADERS = ['content-type', 'content-disposition', 'cache-control'] as const;

/** Everything after the `/engine` mount segment, still URL-encoded. */
function enginePath(req: AppRequest): string {
  const path = pathOf(req);
  // The first `/engine/` is always the mount: an id containing a slash arrives
  // encoded as %2F, so it cannot fake one.
  return path.slice(path.indexOf('/engine/') + '/engine'.length);
}

function searchOf(req: AppRequest): string {
  const at = req.url.indexOf('?');
  return at === -1 ? '' : req.url.slice(at + 1);
}

/** Relay a server-sent event stream chunk by chunk, keeping FoxSchema's headers. */
async function relayEventStream(upstream: Response, res: FastifyReply): Promise<void> {
  void res.status(upstream.status);
  void res.header('content-type', 'text/event-stream');
  void res.header('cache-control', 'no-cache');
  // Stops a reverse proxy buffering the stream into one late delivery.
  void res.header('x-accel-buffering', 'no');
  beginStream(res);

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      streamWrite(res, decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) streamWrite(res, tail);
  } catch {
    // The client left — which aborts the engine call — or the engine went away.
    // Either way there is nobody left to report it to.
  } finally {
    if (!res.raw.destroyed) streamEnd(res);
  }
}

function proxyTo(engine: WorkflowEngineProxyService, route: EngineRoute): RouteHandler {
  return async (req: AppRequest, res: FastifyReply) => {
    // Abort the engine call if the client goes away. This listens on the
    // response: for a request that carries a body, Node emits the request's
    // `close` once that body has been read — before any handler runs — not when
    // the client leaves, so it cannot signal a disconnect.
    const abort = new AbortController();
    res.raw.once('close', () => abort.abort());

    let upstream: Response;
    try {
      upstream = await engine.forward({
        method: route.method,
        path: enginePath(req),
        search: searchOf(req),
        body: req.body,
        signal: abort.signal,
        ...(route.startsRun ? { startsRun: true } : {}),
      });
    } catch (error) {
      if (error instanceof EngineNotAcceptingRunsError) {
        sendError(res, 'conflict', error.message);
        return;
      }
      if (error instanceof EngineUnavailableError) {
        sendError(res, 'unavailable', error.message);
        return;
      }
      if (abort.signal.aborted) return;
      throw error;
    }

    if (upstream.body && upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
      await relayEventStream(upstream, res);
      return;
    }

    let payload: Buffer;
    try {
      payload = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    }
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) void res.header(name, value);
    }
    void res.status(upstream.status);
    // The engine's own status and error body pass through unchanged, so the
    // designer reads engine errors exactly as it does against the engine.
    if (upstream.status === 204 || upstream.status === 304) res.send();
    else res.send(payload);
  };
}

export function createWorkflowRoutes(
  settings = new WorkflowSettingsService(),
  engine = new WorkflowEngineProxyService(settings),
  grants: Pick<WorkflowConnectionGrants, 'list' | 'grant' | 'revoke'> = new WorkflowConnectionGrants(),
): Router {
  const router = Router();

  // Saved connections, and which of them workflows may use. Only the owner can
  // grant one: the engine then resolves it on their behalf, per run. The
  // permission guard has already refused a caller with no user.
  router.get(
    '/connections',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      res.send({ connections: await grants.list(actorOf(req).scope!) });
    },
  );

  router.put(
    '/connections/:id/grant',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      const { id } = req.params as { id: string };
      const name = await grants.grant(actorOf(req).scope!, id);
      if (name === undefined) {
        sendError(res, 'not_found', 'Saved connection not found');
        return;
      }
      // The engine credential that points at the connection. Created here,
      // under the designer's permission, because it holds a reference and no
      // secret; the engine's own credential route stays admin-only because
      // everything else it stores is a secret.
      const credentialId = connectionCredentialId(id);
      let upstream: Response | undefined;
      try {
        upstream = await engine.forward({
          method: 'POST',
          path: '/credentials',
          search: '',
          body: {
            id: credentialId,
            name: (name || id).slice(0, 80),
            kind: 'database',
            source: 'foxschema',
            data: { connectionId: id },
          },
        });
      } catch (error) {
        if (!(error instanceof EngineUnavailableError)) throw error;
      }
      if (!upstream?.ok) {
        // A grant the engine cannot use is not worth keeping.
        await grants.revoke(actorOf(req).userId!, id);
        sendError(
          res,
          'unavailable',
          upstream
            ? `The workflow engine did not record the connection (HTTP ${upstream.status})`
            : 'The workflow engine is unreachable, so the connection was not linked',
        );
        return;
      }
      res.send({ ok: true, credentialId });
    },
  );

  router.delete(
    '/connections/:id/grant',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      const { id } = req.params as { id: string };
      if (await grants.revoke(actorOf(req).userId!, id)) {
        // Best effort: without the grant the engine can no longer resolve the
        // connection anyway, so a leftover credential only lingers in a list.
        await engine
          .forward({
            method: 'DELETE',
            path: `/credentials/${encodeURIComponent(connectionCredentialId(id))}`,
            search: '',
          })
          .catch(() => undefined);
      }
      res.send({ ok: true });
    },
  );

  router.get(
    '/settings',
    requirePermissions('workflow.access'),
    async (_req: AppRequest, res: FastifyReply) => {
      res.send({ config: await settings.getConfig() });
    },
  );

  router.put(
    '/settings',
    requirePermissions('workflow.admin'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = { ...((req.body ?? {}) as AdminConfigPut) };
      if (body.sinks !== undefined && !Array.isArray(body.sinks)) {
        sendError(res, 'invalid_input', 'sinks must be an array');
        return;
      }
      if (body.endpoint !== undefined) {
        if (typeof body.endpoint !== 'string') {
          sendError(res, 'invalid_input', 'endpoint must be a string');
          return;
        }
        // Checked where it is set, so the proxy never holds an endpoint it would
        // refuse — and saved in the same normalised form it fetches from.
        try {
          body.endpoint = engineBaseUrl(body.endpoint.trim());
        } catch (error) {
          if (!(error instanceof EngineUnavailableError)) throw error;
          sendError(res, 'invalid_input', error.message);
          return;
        }
      }
      res.send({ config: await settings.putConfig(body) });
    },
  );

  router.get(
    '/engine/health',
    requirePermissions('workflow.access'),
    async (_req: AppRequest, res: FastifyReply) => {
      res.send(await settings.probeEngineHealth());
    },
  );

  // One route per allowlisted engine endpoint, each with its own permission.
  // No wildcard: an engine path that is not listed has no route here at all.
  for (const route of ENGINE_ROUTES) {
    const method = route.method.toLowerCase() as Lowercase<EngineRoute['method']>;
    router[method](
      `/engine${route.path}`,
      requirePermissions(route.permission),
      proxyTo(engine, route),
    );
  }

  return router;
}
