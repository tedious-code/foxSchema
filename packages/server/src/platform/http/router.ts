/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Collects route declarations so they can be registered with Fastify.
 *
 * This records the method, path, guards and handler for each route. It does not
 * match URLs, parse bodies or run middleware — Fastify does all of that.
 * `bindRoutes` walks what is collected here and registers each route
 * individually, so a guard attached to one path costs nothing on any other.
 *
 * The `router.get(path, ...guards, handler)` signature matches what route files
 * already used, so route declarations read the same as before.
 */
import type { HttpMethod, Middleware, RouteHandler } from './types';

/**
 * Declares that a route only reads, whatever its verb: `router.post('/sql/execute',
 * reads, handler)`. A POST that carries a SELECT in its body still reads. An
 * account without `app.write` (the Demo role) may call a route only when it is
 * a GET or declared this way; every other write refuses it before the handler.
 *
 * A route says so beside its own handler, so a new route is closed to a
 * read-only account until someone decides it reads.
 */
export const reads = Object.freeze({ reads: true as const });
type ReadsMarker = typeof reads;
type ChainItem = Middleware | RouteHandler | ReadsMarker;

export interface RouteDefinition {
  method: HttpMethod;
  /** As declared, relative to wherever this router is mounted. */
  path: string;
  /** Guards for this route only, in declaration order. */
  middlewares: Middleware[];
  handler: RouteHandler;
  /** Declared with `reads`: only reads, whatever its verb. */
  reads?: true;
}

interface MountedRouter {
  prefix: string;
  middlewares: Middleware[];
  router: RouteCollector;
}

export class RouteCollector {
  private readonly routes: RouteDefinition[] = [];
  private readonly mounted: MountedRouter[] = [];

  private add(method: HttpMethod, path: string, chain: ChainItem[]): void {
    const isRead = chain.includes(reads);
    const rest = chain.filter((c) => c !== reads) as (Middleware | RouteHandler)[];
    const handler = rest[rest.length - 1] as RouteHandler;
    const middlewares = rest.slice(0, -1) as Middleware[];
    this.routes.push({ method, path, middlewares, handler, ...(isRead ? { reads: true as const } : {}) });
  }

  get(path: string, ...chain: ChainItem[]): void {
    this.add('GET', path, chain);
  }
  post(path: string, ...chain: ChainItem[]): void {
    this.add('POST', path, chain);
  }
  put(path: string, ...chain: ChainItem[]): void {
    this.add('PUT', path, chain);
  }
  delete(path: string, ...chain: ChainItem[]): void {
    this.add('DELETE', path, chain);
  }
  patch(path: string, ...chain: ChainItem[]): void {
    this.add('PATCH', path, chain);
  }

  /**
   * Mount a sub-router, optionally behind a prefix and shared guards.
   *
   * Overloads mirror how the app already calls it: `use(router)`,
   * `use(prefix, router)`, and `use(prefix, ...guards, router)`.
   */
  use(...args: [RouteCollector] | [string, ...(Middleware | RouteCollector)[]]): void {
    if (args.length === 1 && args[0] instanceof RouteCollector) {
      this.mounted.push({ prefix: '', middlewares: [], router: args[0] });
      return;
    }
    const prefix = typeof args[0] === 'string' ? args[0] : '';
    const rest = (typeof args[0] === 'string' ? args.slice(1) : args) as (
      | Middleware
      | RouteCollector
    )[];
    const router = rest.find((r): r is RouteCollector => r instanceof RouteCollector);
    const middlewares = rest.filter((r): r is Middleware => !(r instanceof RouteCollector));
    if (!router) {
      // A guard-only `use(guard)` is not supported. Guards must be attached to
      // a specific route or to a mounted router, so it is always clear which
      // routes they cover.
      throw new Error('Router.use requires a router; guard-only use() is not supported.');
    }
    this.mounted.push({ prefix, middlewares, router });
  }

  /**
   * Flatten to absolute routes.
   *
   * Guards accumulate outermost-first, so a route ends up with exactly the
   * chain it would have had in Express — and nothing from a sibling mount.
   */
  flatten(prefix = '', inherited: Middleware[] = []): RouteDefinition[] {
    const out: RouteDefinition[] = [];
    const base = inherited;
    for (const r of this.routes) {
      out.push({
        method: r.method,
        path: joinPath(prefix, r.path),
        middlewares: [...base, ...r.middlewares],
        handler: r.handler,
        ...(r.reads ? { reads: r.reads } : {}),
      });
    }
    for (const m of this.mounted) {
      out.push(...m.router.flatten(joinPath(prefix, m.prefix), [...base, ...m.middlewares]));
    }
    return out;
  }
}

/** Join two path segments without doubling or dropping a slash. */
export function joinPath(prefix: string, path: string): string {
  const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (!path || path === '/') return a || '/';
  const b = path.startsWith('/') ? path : `/${path}`;
  return `${a}${b}` || '/';
}

/**
 * Callable factory, so route files keep reading `const router = Router();`
 * exactly as they did with Express.
 */
export function Router(): RouteCollector {
  return new RouteCollector();
}

/** The declared type of a route module's return value. */
export type Router = RouteCollector;
