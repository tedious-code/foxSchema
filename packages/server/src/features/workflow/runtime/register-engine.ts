/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mount the in-process engine's Fastify plugins on the FoxSchema API:
 * designer routes behind a session + ENGINE_ROUTES, public trigger ingress.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

export interface RegisterWorkflowEngineOptions {
  ctx: AppContext;
  featureContext: FeatureContext;
  settings: Pick<WorkflowSettingsService, 'getConfig'>;
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>;
  /** Recover the scheduler and start cron/poll. Off in unit tests. */
  startLifecycle?: boolean;
  /** Tests that already attach a user skip the session cookie guard. */
  sessionGuard?: Middleware;
}

function relativeEnginePath(req: FastifyRequest): string {
  const pattern = (req.routeOptions?.url ?? '').split('?')[0] ?? '';
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
  return ENGINE_ROUTES.find((route) => route.method === m && (route.path === path || pathMatches(route.path, path)));
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
  ctx: AppContext,
): Promise<unknown[]> {
  const out = [...initial];
  const seen = new Set<string>();
  let frontier = initial.flatMap((doc) => referencedSubWorkflowIds(doc));
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const subId of frontier) {
      if (seen.has(subId)) continue;
      seen.add(subId);
      const subDoc = await ctx.workflows.get(subId);
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
  ctx: AppContext,
): Promise<unknown[]> {
  const id = (req.params as { id?: string }).id ?? '';
  if (!id || route.connections === 'body' || route.connections === 'run-list') return [];
  if (route.connections === 'body-and-stored' || route.connections === 'workflow') {
    const stored = await ctx.workflows.get(id);
    return stored ? expandSubWorkflowDocuments([stored], ctx) : [];
  }
  const snapshot = await ctx.runs.getSnapshot(id);
  return snapshot ? [snapshot] : [];
}

async function runsCallerMaySee(
  ctx: AppContext,
  grants: Pick<WorkflowConnectionGrants, 'notUsableBy'>,
  userId: string,
  payload: unknown,
): Promise<unknown> {
  if (!Array.isArray(payload)) return payload;
  const visible: unknown[] = [];
  for (const run of payload) {
    const id =
      run && typeof run === 'object' && 'id' in run && typeof (run as { id: unknown }).id === 'string'
        ? (run as { id: string }).id
        : '';
    if (!id) continue;
    const snapshot = await ctx.runs.getSnapshot(id);
    if (!snapshot) continue;
    if ((await grants.notUsableBy(userId, linkedConnectionsIn(snapshot))).length === 0) {
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

export async function registerWorkflowEngine(
  app: FastifyInstance,
  options: RegisterWorkflowEngineOptions,
): Promise<void> {
  const { ctx, featureContext, settings, grants } = options;
  const sessionGuards: Middleware[] = options.sessionGuard
    ? [options.sessionGuard]
    : [authGuard(featureContext.auth), defaultApiRateLimit()];

  await app.register(async (api) => {
    withZodCompilers(api);
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
        const docs = await expandSubWorkflowDocuments([req.body], ctx);
        if (await refuseForeignConnections(reply, grants, userId, docs)) return;
      }
      if (route.connections === 'body' || route.connections === 'run-list') return;
      await refuseForeignConnections(reply, grants, userId, await storedDocumentsFor(route, req, ctx));
    });
    api.addHook('preSerialization', async (req, _reply, payload) => {
      const route = engineRouteOf(req);
      if (route?.connections !== 'run-list') return payload;
      const userId = actorOf(req as AppRequest).userId;
      if (!userId) return [];
      return runsCallerMaySee(ctx, grants, userId, payload);
    });
    await api.register(credentialRoutes(ctx));
    await api.register(pipeRoutes(ctx));
    await api.register(previewRoutes());
    await api.register(middlewareRoutes(ctx));
    await api.register(workflowRoutes(ctx, { extra: false }));
    await api.register(runRoutes(ctx, { extra: false }));
    await api.register(variableRoutes(ctx, { extra: false }));
  }, { prefix: ENGINE_HTTP_PREFIX });

  await app.register(async (ingress) => {
    withZodCompilers(ingress);
    await ingress.register(rateLimit, { global: false });
    await ingress.register(triggerRoutes(ctx));
  }, { prefix: '/api' });

  if (options.startLifecycle) {
    app.addHook('onReady', async () => {
      await loadConfiguredPlugins(ctx.registry);
      await ctx.scheduler.recover();
      await ctx.cron.recover();
      ctx.cron.start();
    });
    app.addHook('onClose', async () => {
      ctx.cron.stop();
      await Promise.race([
        ctx.scheduler.idle(),
        new Promise<void>((resolve) => setTimeout(resolve, ENGINE_IDLE_CLOSE_MS).unref()),
      ]);
      if (getProductionWorkflowEngine()?.ctx === ctx) {
        await stopProductionWorkflowEngine();
      } else {
        ctx.close();
      }
    });
  }
}
