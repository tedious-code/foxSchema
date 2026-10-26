/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Registers collected route declarations as Fastify routes.
 *
 * Each declaration becomes one `fastify.route(...)` call, with that route's
 * guards as its `preHandler` chain. No guard runs globally, so a rate limiter
 * on an upload path adds nothing to other routes.
 *
 * Handlers take Fastify's own request and reply — there is no adapter between
 * them and the framework.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppRequest, Middleware } from './types';
import type { RouteDefinition } from './router';

/**
 * Run a route's guards in order, then its handler.
 *
 * A guard that calls `next()` allows the request to continue. A guard that
 * responds without calling `next()` ends the request, and the handler is
 * skipped.
 */
async function runChain(
  middlewares: Middleware[],
  req: AppRequest,
  res: FastifyReply
): Promise<boolean> {
  for (const mw of middlewares) {
    let proceed = false;
    let failure: unknown;
    await mw(req, res, (error?: unknown) => {
      if (error) failure = error;
      else proceed = true;
    });
    if (failure) throw failure;
    if (!proceed) return false;
  }
  return true;
}

/** Express-style `:param` paths are Fastify's syntax too, so paths pass through. */
export function bindRoutes(app: FastifyInstance, routes: RouteDefinition[]): void {
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.path,
      // Read by the session guard (`req.routeOptions.config.reads`).
      config: { reads: route.reads === true },
      handler: async (request, reply) => {
        const proceed = await runChain(route.middlewares, request as AppRequest, reply);
        if (!proceed) return reply;
        await route.handler(request as AppRequest, reply);
        return reply;
      },
    });
  }
}
