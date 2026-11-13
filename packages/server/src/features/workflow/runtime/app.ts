/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/app.ts).
 */
import { secretEquals } from '@foxschema/workflow-engine';
import rateLimit from '@fastify/rate-limit';
import { WORKFLOW_ENGINE_TOKEN_ENV } from '@foxschema/workflow-contract';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rawBody from 'fastify-raw-body';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from './zod-provider.js';
import { createContext, loadConfiguredPlugins, type AppContext } from './context.js';
import { middlewareRoutes } from './routes/middleware.js';
import { pipeRoutes } from './routes/pipes.js';
import { previewRoutes } from './routes/preview.js';
import { credentialRoutes } from './routes/credentials.js';
import { runRoutes } from './routes/runs.js';
import { triggerRoutes } from './routes/triggers.js';
import { variableRoutes } from './routes/variables.js';
import { workflowRoutes } from './routes/workflows.js';

/** What both listeners share: validation, rate limiting, the raw body webhooks sign, and health. */
function createServer(): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: process.env.FOXFLOW_TRUST_PROXY === 'true',
    // The run-event SSE endpoint hijacks the reply and never ends its
    // response, so it is never "idle" — Fastify's default ('idle') would wait
    // on it forever and `app.close()` would hang until the supervisor SIGKILLs.
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(rateLimit, { global: false });
  app.register(rawBody, { global: false, encoding: false, runFirst: true });
  app.get('/health', async () => ({ ok: true, service: 'workflow-server' }));
  return app;
}

/**
 * Why the engine API must not listen on `host`, or null when it may.
 *
 * Without a token the API is open to whoever can reach it — its credentials,
 * its workflows, and the right to run them. That is a dev setup on loopback;
 * on any other address it is an open door, so the engine refuses to start.
 */
export function openApiListenProblem(host: string, token: string | undefined): string | null {
  if (token) return null;
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return null;
  return (
    `Refusing to listen on ${host} without ${WORKFLOW_ENGINE_TOKEN_ENV}: the engine API would be open to ` +
    `anyone who can reach it. Set ${WORKFLOW_ENGINE_TOKEN_ENV} (the same value on FoxSchema), or keep HOST on loopback.`
  );
}

/** Refuse a request that does not present `token`, compared in constant time. */
function requireToken(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    // The engine's one constant-time compare, also used for webhook secrets.
    if (!secretEquals(presented, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/**
 * The engine API. Accepts a context for tests (inject in-memory stores);
 * defaults to a fresh one in production. Owns the context's lifecycle:
 * recovery and schedules start when it is ready and stop when it closes.
 *
 * `ingress: false` leaves trigger ingress to {@link buildIngressApp} on a
 * listener of its own, so this one can stay on loopback with every route
 * behind the service token.
 */
export function buildApp(
  ctx: AppContext = createContext(),
  {
    token = process.env[WORKFLOW_ENGINE_TOKEN_ENV],
    ingress = true,
  }: { token?: string; ingress?: boolean } = {},
): FastifyInstance {
  const app = createServer();

  // The API in a plugin of its own, so the token hook covers exactly these
  // routes. Trigger ingress is registered beside it, outside the hook: webhooks
  // and API endpoints authenticate their own callers, and the proxy never
  // fronts them. Without a token the API stays open, for a loopback-only dev
  // setup.
  app.register(
    async (api) => {
      if (token) api.addHook('onRequest', requireToken(token));
      api.register(credentialRoutes(ctx));
      api.register(pipeRoutes(ctx));
      api.register(previewRoutes());
      api.register(middlewareRoutes(ctx));
      api.register(workflowRoutes(ctx));
      api.register(runRoutes(ctx));
      api.register(variableRoutes(ctx));
    },
    { prefix: '/api' },
  );
  if (ingress) app.register(triggerRoutes(ctx), { prefix: '/api' });

  app.addHook('onReady', async () => {
    await loadConfiguredPlugins(ctx.registry);
    await ctx.scheduler.recover();
    await ctx.cron.recover();
    ctx.cron.start();
    // No recover() equivalent: a poll has no backlog of missed occurrences to
    // replay. Whatever the endpoint holds now is what the first tick sees.
    ctx.poll.start();
  });
  app.addHook('onClose', async () => {
    ctx.cron.stop();
    ctx.poll.stop();
    // Bounded: a wedged run (e.g. a sub-workflow waiting on a child that never
    // reaches a terminal state) must not block shutdown indefinitely.
    await Promise.race([
      ctx.scheduler.idle(),
      new Promise((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
    ctx.close?.();
  });

  return app;
}

/**
 * Trigger ingress alone, for a listener that can face the internet while the
 * engine API does not. It serves the same paths the API app would, so an
 * integration keeps its URL when ingress moves to its own port. It shares the
 * API app's context and leaves that context's lifecycle to it.
 */
export function buildIngressApp(ctx: AppContext): FastifyInstance {
  const app = createServer();
  app.register(triggerRoutes(ctx), { prefix: '/api' });
  return app;
}
