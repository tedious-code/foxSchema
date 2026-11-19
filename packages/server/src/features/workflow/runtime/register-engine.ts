/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mount the workflow engine on the FoxSchema API: designer routes behind a
 * session + ENGINE_ROUTES RBAC & workspace-connection guards, and public
 * trigger ingress. In production every engine call is forwarded exclusively over
 * FoxSchema's private OS IPC channel to the sandboxed engine child process.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkflowDef } from '@foxschema/workflow-engine';
import { requirePermissions } from '../../../platform/authorization/rbac.guard';
import { defaultApiRateLimit } from '../../../platform/guards/rate-limit';
import { actorOf } from '../../../platform/http/actor-of';
import { runMiddlewares } from '../../../platform/http/fastify-bind';
import { sendError } from '../../../platform/http/respond';
import type { AppRequest, Middleware } from '../../../platform/http/types';
import { authGuard } from '../../../platform/identity/auth.guard';
import type { FeatureContext } from '../../../platform/feature-module';
import {
  ENGINE_NOT_ACCEPTING_MESSAGE,
  ENGINE_ROUTES,
  linkedConnectionsIn,
  type EngineRoute,
} from '../engine-routes';
import type { WorkflowConnectionGrants } from '../workflow-connection-grants.service';
import type { WorkflowSettingsService } from '../workflow-settings.service';
import { loadConfiguredPlugins, type AppContext } from './context.js';
import { getProductionWorkflowEngine, stopProductionWorkflowEngine } from './engine-host.js';
import type { WorkflowEngineBackend } from './sandbox-protocol.js';
import { credentialRoutes } from './routes/credentials.js';
import { middlewareRoutes } from './routes/middleware.js';
import { pipeRoutes } from './routes/pipes.js';
import { previewRoutes } from './routes/preview.js';
import { runRoutes } from './routes/runs.js';
import { triggerRoutes } from './routes/triggers.js';
import { variableRoutes } from './routes/variables.js';
import { workflowRoutes } from './routes/workflows.js';
import { serializerCompiler, validatorCompiler } from './zod-provider.js';

export const ENGINE_HTTP_PREFIX = '/api/workflow/engine';

const FOREIGN_CONNECTION_MESSAGE =
  'This workflow uses a saved connection from a workspace you are not a member of, so it cannot be saved, run or inspected by you.';

/** How long close waits for in-flight runs before tearing the engine down. */
const ENGINE_IDLE_CLOSE_MS = 2_000;

const INGRESS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const ENGINE_STRIPPED_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);
const INGRESS_STRIPPED_HEADERS = new Set([
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);
const RESPONSE_HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
]);

interface WorkflowDocumentReader {
  getWorkflow(id: string): Promise<WorkflowDef | undefined>;
  getRunSnapshot(id: string): Promise<WorkflowDef | undefined>;
  getRunLinkedConnections(runIds: readonly string[]): Promise<Record<string, string[]>>;
}

export interface RegisterWorkflowEngineOptions {
  /** Sandboxed IPC backend (default in production). */
  backend?: WorkflowEngineBackend;
  /** Direct in-process AppContext (used by unit tests and `FOXFLOW_SANDBOX_MODE=in-process`). */
  ctx?: AppContext;
  featureContext: FeatureContext;
  settings: Pick<WorkflowSettingsService, 'getConfig'>;
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>;
  /** Recover the scheduler and start cron/poll. Off in unit tests. */
  startLifecycle?: boolean;
  /** Tests that already attach a user skip the session cookie guard. */
  sessionGuard?: Middleware;
}

function relativeEnginePath(req: FastifyRequest): string {
  const pattern = (req.routeOptions?.url ?? req.url ?? '').split('?')[0] ?? '';
  return pattern.startsWith(ENGINE_HTTP_PREFIX)
    ? pattern.slice(ENGINE_HTTP_PREFIX.length) || '/'
    : pattern.startsWith('/')
      ? pattern
      : '/';
}

function pathMatches(pattern: string, path: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

function matchEngineRoute(method: string, path: string): EngineRoute | undefined {
  const m = method.toUpperCase();
  return ENGINE_ROUTES.find(
    (route) => route.method === m && (route.path === path || pathMatches(route.path, path)),
  );
}

function engineRouteOf(req: FastifyRequest): EngineRoute | undefined {
  return matchEngineRoute(req.method, relativeEnginePath(req));
}

function withZodCompilers(instance: FastifyInstance): void {
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
}

/** Extract workflowIds called via `workflow.sub` pipes inside any workflow document. */
function referencedSubWorkflowIds(document: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (
        obj.type === 'workflow.sub' &&
        obj.config &&
        typeof obj.config === 'object' &&
        typeof (obj.config as Record<string, unknown>).workflowId === 'string'
      ) {
        const subId = ((obj.config as Record<string, unknown>).workflowId as string).trim();
        if (subId) ids.add(subId);
      }
      for (const item of Object.values(obj)) visit(item);
    }
  };
  visit(document);
  return [...ids];
}

/** Transitively resolve `workflow.sub` callees (bounded depth) so connection grants cover the call graph. */
async function expandSubWorkflowDocuments(
  initial: unknown[],
  reader: WorkflowDocumentReader,
): Promise<unknown[]> {
  const out = [...initial];
  const seen = new Set<string>();
  let frontier = initial.flatMap((doc) => referencedSubWorkflowIds(doc));
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const subId of frontier) {
      if (seen.has(subId)) continue;
      seen.add(subId);
      const subDoc = await reader.getWorkflow(subId);
      if (!subDoc) continue;
      out.push(subDoc);
      next.push(...referencedSubWorkflowIds(subDoc));
    }
    frontier = next;
  }
  return out;
}

/** Stored workflow or run snapshot whose linked connections the caller must be allowed to use. */
async function storedDocumentsFor(
  route: EngineRoute,
  req: FastifyRequest,
  reader: WorkflowDocumentReader,
): Promise<unknown[]> {
  const id = (req.params as { id?: string }).id ?? '';
  if (!id || route.connections === 'body' || route.connections === 'run-list') return [];
  if (route.connections === 'body-and-stored' || route.connections === 'workflow') {
    const stored = await reader.getWorkflow(id);
    return stored ? expandSubWorkflowDocuments([stored], reader) : [];
  }
  const snapshot = await reader.getRunSnapshot(id);
  return snapshot ? [snapshot] : [];
}

async function runsCallerMaySee(
  reader: WorkflowDocumentReader,
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>,
  userId: string,
  payload: unknown,
): Promise<unknown> {
  if (!Array.isArray(payload)) return payload;
  const entries: Array<{ run: unknown; id: string }> = [];
  for (const run of payload) {
    const id =
      run && typeof run === 'object' && 'id' in run && typeof (run as { id: unknown }).id === 'string'
        ? (run as { id: string }).id
        : '';
    if (id) entries.push({ run, id });
  }
  if (entries.length === 0) return [];

  // Single batch IPC round trip for all runs, followed by a single workspace-grant check.
  const linkedByRun = await reader.getRunLinkedConnections(entries.map((e) => e.id));
  const allLinkedIds = [...new Set(Object.values(linkedByRun).flat())];
  const forbidden = new Set(
    allLinkedIds.length > 0 ? await grants.notUsableBy(userId, allLinkedIds) : [],
  );

  const visible: unknown[] = [];
  for (const { run, id } of entries) {
    const linked = linkedByRun[id];
    if (!linked) continue;
    if (linked.every((connId) => !forbidden.has(connId))) {
      visible.push(run);
    }
  }
  return visible;
}

async function refuseForeignConnections(
  reply: FastifyReply,
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>,
  userId: string,
  documents: unknown[],
): Promise<boolean> {
  const used = [...new Set(documents.flatMap((document) => linkedConnectionsIn(document)))];
  if ((await grants.notUsableBy(userId, used)).length === 0) return false;
  sendError(reply, 'forbidden', FOREIGN_CONNECTION_MESSAGE);
  return true;
}

function forwardHeaders(
  headers: FastifyRequest['headers'],
  stripped: ReadonlySet<string>,
  hasBody: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    const lower = key.toLowerCase();
    if (stripped.has(lower)) continue;
    if (!hasBody && lower === 'content-type') continue;
    out[lower] = val;
  }
  return out;
}

function childEngineUrl(req: FastifyRequest): string {
  const raw = req.raw.url ?? req.url;
  if (raw.startsWith(ENGINE_HTTP_PREFIX)) {
    return `/engine${raw.slice(ENGINE_HTTP_PREFIX.length) || '/'}`;
  }
  return raw.startsWith('/engine') ? raw : `/engine${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function childIngressUrl(req: FastifyRequest): string {
  const raw = req.raw.url ?? req.url;
  if (raw.startsWith('/api/')) {
    return `/ingress${raw.slice('/api'.length)}`;
  }
  return raw.startsWith('/ingress') ? raw : `/ingress${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function applyProxyHeaders(
  reply: FastifyReply,
  headers: Record<string, string | string[]>,
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (RESPONSE_HOP_BY_HOP.has(key.toLowerCase())) continue;
    reply.header(key, value);
  }
}

async function registerSandboxEngineApi(
  api: FastifyInstance,
  backend: WorkflowEngineBackend,
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>,
): Promise<void> {
  for (const route of ENGINE_ROUTES) {
    if (route.method === 'GET' && route.path === '/runs/:id/events/stream') {
      api.get('/runs/:id/events/stream', async (req, reply) => {
        const { id } = req.params as { id: string };
        const rawAfter = (req.query as { after?: string }).after;
        const parsedAfter = rawAfter === undefined ? 0 : Number(rawAfter);
        if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
          return reply.code(400).send({ error: 'invalid after query parameter' });
        }

        const bufferedChunks: string[] = [];
        let endedEarly = false;
        let onLiveChunk: ((chunk: string) => void) | undefined;
        let onLiveEnd: (() => void) | undefined;

        let headSettled = false;
        let resolveHead!: (status: number) => void;
        const headPromise = new Promise<number>((resolve) => {
          resolveHead = resolve;
        });
        const settleHead = (status: number) => {
          if (headSettled) return;
          headSettled = true;
          resolveHead(status);
        };

        const stop = backend.openRunEventsStream(id, parsedAfter, {
          onHead: (statusCode) => settleHead(statusCode),
          onChunk: (chunk) => {
            if (onLiveChunk) onLiveChunk(chunk);
            else bufferedChunks.push(chunk);
          },
          onEnd: () => {
            // If the child crashes or exits before sending `sse.head`, unblock
            // the handler with 503 instead of hanging indefinitely.
            settleHead(503);
            if (onLiveEnd) onLiveEnd();
            else endedEarly = true;
          },
        });

        const onClientClose = () => {
          settleHead(499);
          stop();
        };
        req.raw.on('close', onClientClose);
        const statusCode = await headPromise;
        req.raw.off('close', onClientClose);
        if (statusCode === 499) {
          stop();
          reply.hijack();
          return;
        }
        if (statusCode !== 200) {
          stop();
          if (statusCode === 404) {
            return reply.code(404).send({ error: 'not found' });
          }
          sendError(reply, 'unavailable', 'Workflow engine sandbox is not ready');
          return;
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        reply.raw.on('close', stop);

        for (const chunk of bufferedChunks) {
          reply.raw.write(chunk);
        }
        bufferedChunks.length = 0;

        if (endedEarly) {
          stop();
          reply.raw.end();
          return;
        }

        onLiveChunk = (chunk) => {
          if (!reply.raw.destroyed) reply.raw.write(chunk);
        };
        onLiveEnd = () => {
          stop();
          if (!reply.raw.destroyed) reply.raw.end();
        };
      });
      continue;
    }

    api.route({
      method: route.method,
      url: route.path,
      handler: async (req, reply) => {
        const hasBody = req.body !== undefined;
        const bodyBuffer = hasBody
          ? Buffer.isBuffer(req.body)
            ? req.body
            : typeof req.body === 'string'
              ? Buffer.from(req.body)
              : Buffer.from(JSON.stringify(req.body))
          : undefined;
        const headers = forwardHeaders(req.headers, ENGINE_STRIPPED_HEADERS, hasBody);
        if (hasBody && !Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
          headers['content-type'] = 'application/json';
        }

        let res;
        try {
          res = await backend.injectHttp({
            method: req.method,
            url: childEngineUrl(req),
            headers,
            ...(bodyBuffer ? { bodyBase64: bodyBuffer.toString('base64') } : {}),
          });
        } catch {
          sendError(reply, 'unavailable', 'Workflow engine sandbox is unavailable; retry shortly');
          return;
        }

        if (route.connections === 'run-list' && res.statusCode === 200) {
          const userId = actorOf(req as AppRequest).userId;
          if (!userId) return [];
          const parsed = JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf8')) as unknown;
          return runsCallerMaySee(backend, grants, userId, parsed);
        }

        applyProxyHeaders(reply, res.headers);
        reply.code(res.statusCode);
        if (res.statusCode === 204 || res.statusCode === 304) {
          return reply.send();
        }
        return reply.send(Buffer.from(res.bodyBase64, 'base64'));
      },
    });
  }
}

async function registerSandboxIngress(
  ingress: FastifyInstance,
  backend: WorkflowEngineBackend,
): Promise<void> {
  // Capture exact raw bytes across all webhook content types inside this
  // encapsulated scope so HMAC signatures inside the sandbox see identical bytes.
  ingress.removeAllContentTypeParsers();
  ingress.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  for (const method of INGRESS_METHODS) {
    for (const url of ['/hooks/*', '/triggers/:workflowId/:triggerId']) {
      ingress.route({
        method,
        url,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        handler: async (req, reply) => {
          const rawBuf = Buffer.isBuffer(req.body) ? req.body : undefined;
          const headers = forwardHeaders(req.headers, INGRESS_STRIPPED_HEADERS, Boolean(rawBuf));
          let res;
          try {
            res = await backend.injectHttp({
              method,
              url: childIngressUrl(req),
              headers,
              ...(rawBuf && rawBuf.byteLength > 0 ? { bodyBase64: rawBuf.toString('base64') } : {}),
            });
          } catch {
            return reply.code(503).send({ error: 'workflow engine sandbox unavailable' });
          }

          applyProxyHeaders(reply, res.headers);
          reply.code(res.statusCode);
          if (res.statusCode === 204 || res.statusCode === 304) {
            return reply.send();
          }
          return reply.send(Buffer.from(res.bodyBase64, 'base64'));
        },
      });
    }
  }
}

export async function registerWorkflowEngine(
  app: FastifyInstance,
  options: RegisterWorkflowEngineOptions,
): Promise<void> {
  const { featureContext, settings, grants } = options;
  const ctx = options.ctx;
  const backend = options.backend;
  if (!backend && !ctx) {
    throw new Error('registerWorkflowEngine requires either backend or ctx');
  }

  const reader: WorkflowDocumentReader = backend
    ? backend
    : {
        getWorkflow: (id) => ctx!.workflows.get(id),
        getRunSnapshot: (id) => ctx!.runs.getSnapshot(id),
        async getRunLinkedConnections(runIds) {
          const out: Record<string, string[]> = {};
          for (const runId of runIds) {
            const snapshot = await ctx!.runs.getSnapshot(runId);
            if (snapshot) out[runId] = linkedConnectionsIn(snapshot);
          }
          return out;
        },
      };

  const sessionGuards: Middleware[] = options.sessionGuard
    ? [options.sessionGuard]
    : [authGuard(featureContext.auth), defaultApiRateLimit()];

  const useSandboxProxy = Boolean(backend && (backend.mode === 'sandbox' || !ctx));

  await app.register(
    async (api) => {
      if (!useSandboxProxy) {
        withZodCompilers(api);
      }
      // Auth and RBAC before Fastify validates the body, so a caller without
      // the permission is 403 even when the payload would be 400.
      api.addHook('onRequest', async (req, reply) => {
        const authed = await runMiddlewares(sessionGuards, req as AppRequest, reply);
        if (!authed) return;
        const route = engineRouteOf(req);
        if (!route) {
          sendError(reply, 'not_found', 'Not found');
          return;
        }
        const allowed = await runMiddlewares(
          [requirePermissions(route.permission)],
          req as AppRequest,
          reply,
        );
        if (!allowed) return;
        if (route.startsRun && (await settings.getConfig()).state !== 'enabled') {
          sendError(reply, 'conflict', ENGINE_NOT_ACCEPTING_MESSAGE);
          return;
        }
      });
      api.addHook('preHandler', async (req, reply) => {
        const route = engineRouteOf(req);
        if (!route?.connections) return;
        const userId = actorOf(req as AppRequest).userId;
        if (!userId) {
          sendError(reply, 'unauthenticated', 'Authentication required');
          return;
        }
        if (route.connections === 'body' || route.connections === 'body-and-stored') {
          const docs = await expandSubWorkflowDocuments([req.body], reader);
          if (await refuseForeignConnections(reply, grants, userId, docs)) return;
        }
        if (route.connections === 'body' || route.connections === 'run-list') return;
        await refuseForeignConnections(reply, grants, userId, await storedDocumentsFor(route, req, reader));
      });

      if (useSandboxProxy) {
        await registerSandboxEngineApi(api, backend!, grants);
      } else {
        api.addHook('preSerialization', async (req, _reply, payload) => {
          const route = engineRouteOf(req);
          if (route?.connections !== 'run-list') return payload;
          const userId = actorOf(req as AppRequest).userId;
          if (!userId) return [];
          return runsCallerMaySee(reader, grants, userId, payload);
        });
        await api.register(credentialRoutes(ctx!));
        await api.register(pipeRoutes(ctx!));
        await api.register(previewRoutes());
        await api.register(middlewareRoutes(ctx!));
        await api.register(workflowRoutes(ctx!, { extra: false }));
        await api.register(runRoutes(ctx!, { extra: false }));
        await api.register(variableRoutes(ctx!, { extra: false }));
      }
    },
    { prefix: ENGINE_HTTP_PREFIX },
  );

  await app.register(
    async (ingress) => {
      await ingress.register(rateLimit, { global: false });
      if (useSandboxProxy) {
        await registerSandboxIngress(ingress, backend!);
      } else {
        withZodCompilers(ingress);
        await ingress.register(triggerRoutes(ctx!));
      }
    },
    { prefix: '/api' },
  );

  if (options.startLifecycle) {
    if (useSandboxProxy) {
      app.addHook('onReady', async () => {
        await backend!.startLifecycle();
      });
      app.addHook('onClose', async () => {
        if (getProductionWorkflowEngine()?.backend === backend) {
          await stopProductionWorkflowEngine();
        } else {
          await backend!.close();
        }
      });
    } else {
      app.addHook('onReady', async () => {
        await loadConfiguredPlugins(ctx!.registry);
        await ctx!.scheduler.recover();
        await ctx!.cron.recover();
        ctx!.cron.start();
      });
      app.addHook('onClose', async () => {
        ctx!.cron.stop();
        await Promise.race([
          ctx!.scheduler.idle(),
          new Promise<void>((resolve) => setTimeout(resolve, ENGINE_IDLE_CLOSE_MS).unref()),
        ]);
        if (getProductionWorkflowEngine()?.ctx === ctx) {
          await stopProductionWorkflowEngine();
        } else {
          ctx!.close();
        }
      });
    }
  }
}
