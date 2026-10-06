/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Fastify edge.
 *
 * Migrating a 38-route API in one commit is how migrations break. This is the
 * staged shape instead: Fastify owns the socket and the request lifecycle, and
 * enforces every security policy natively in hooks that run before anything
 * else. The existing Express routers are mounted underneath through
 * one framework. Every route is a native Fastify registration, so no route
 * changes behaviour on the day the server swaps.
 *
 * What that buys immediately:
 *
 * - Rate limiting, security headers and idempotency move into `onRequest` /
 *   `onSend` hooks, so they apply to *every* request including 404s and
 *   malformed bodies — Express middleware ordering had already let eight
 *   sub-routers slip past a limiter once.
 * - A request timeout at the edge, which Express did not have. Note the body
 *   limit is *not* Fastify's while Express owns body parsing — the number that
 *   bites is `BODY_LIMIT` in server.ts, shared by both.
 * - Fastify's error and 404 handling, so an unhandled throw returns JSON
 *   instead of an HTML stack page.
 *
 * The policies themselves are shared with the Express server (`api/policy/*`),
 * so the two cannot drift while both exist. Selected with `FOX_SERVER=fastify`.
 *
 * ## Performance, measured
 *
 * 50 concurrent keep-alive connections, load generator in its own process:
 *
 *     fastify, no express bridge     53474 req/s   p50 0.82ms   p99 2.50ms
 *     express                        15209 req/s   p50 2.80ms   p99 9.15ms
 *     fastify + express bridge        6786 req/s   p50 5.42ms   p99 11.10ms
 *
 * Fastify itself is ~3.5x Express on this route. The bridge is what costs:
 * `app.use()` runs Express's whole middleware chain on every request, native
 * routes included, and that alone is an 8x drop.
 *
 * So this edge is currently *slower* than plain Express, and the migration only
 * pays once routes become native handlers. That is the honest trade for having
 * hooks that mount ordering cannot bypass, a request timeout, and JSON errors —
 * and it is why `FOX_SERVER` defaults to express.
 *
 * An earlier in-process benchmark reported Fastify as slower with a *better*
 * tail. Both halves were artifacts of the client sharing the server's event
 * loop; anyone re-measuring should keep the load generator in its own process.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { BODY_LIMIT, buildApiRoutes } from './server';
import { ERROR_STATUS, type ErrorCode } from '@foxschema/shared';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { isAssetPath, staticOptions } from './static-assets';
import { bindRoutes } from '../platform/http/fastify-bind';
import {
  isAllowedOrigin,
  originVerdict,
  requestOriginFrom,
} from '../platform/guards/origin-policy';
import { loggerConfig } from '../platform/logger/logger';

import { securityHeadersFor } from '../platform/guards/security-headers-core';
import { pathOf } from '../platform/http/reply';
import { RateLimitCore, RATE_LIMIT_MESSAGE, rateLimitKey } from '../platform/guards/rate-limit-core';

export interface FastifyServerOptions {
  /** Send HSTS. Off by default; see the header policy for why. */
  hsts?: boolean;
  /** Largest accepted request body. */
  bodyLimitBytes?: number;
  /** Abort a request that takes longer than this. */
  requestTimeoutMs?: number;
  /**
   * Built frontend to serve alongside the API, for the single-origin server.
   * Omitted by the API-only server and by tests, which want a 404 to be a 404.
   */
  staticDir?: string;
}

/**
 * The one body limit. Express used to parse first under `@fastify/express`,
 * which made its own limit the effective one and let the edge default to 32MB
 * while Express enforced 10; with a single server there is a single number.
 */
/**
 * The edge must not be looser than the layer behind it.
 *
 * Fastify defaulted to 32MB while Express enforced FOX_BODY_LIMIT (10mb), so a
 * 20MB body passed the edge and was rejected deeper in — surfacing as a 400
 * about bad JSON rather than the 413 it actually was. One limit, enforced
 * where the bytes arrive.
 */
function parseByteSize(value: string): number {
  const FALLBACK = 10 * 1024 * 1024;
  // No quantifier inside a quantified group: the nested form was flagged as a
  // ReDoS risk. This admits '1.2.3', so Number does the real validation — which
  // it had to anyway, since the old pattern let NaN through as a body limit.
  const m = /^([\d.]+)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!m) return FALLBACK;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0) return FALLBACK;
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[
    (m[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'
  ];
  return Math.floor(amount * scale);
}

const DEFAULT_BODY_LIMIT = parseByteSize(BODY_LIMIT);

/**
 * The shared error code for a status Fastify produced itself.
 *
 * Derived from `ERROR_STATUS` rather than a second hand-written table, so the
 * two cannot drift; `failed` covers anything without a mapping.
 */
function codeForStatus(status: number): ErrorCode {
  const match = (Object.entries(ERROR_STATUS) as [ErrorCode, number][]).find(
    ([, code]) => code === status
  );
  return match?.[0] ?? 'failed';
}

/**
 * A request still running after this is not going to finish usefully, and it is
 * holding a socket and a database connection while it waits.
 */
const DEFAULT_REQUEST_TIMEOUT = 120_000;

/** Peers whose X-Forwarded-* headers are believed: this machine and private networks. */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/**
 * `FOX_TRUST_PROXY` as Fastify takes it: `true`/`false`, or a comma-separated
 * list of addresses and CIDR ranges (`10.0.0.0/8, 192.0.2.7`).
 */
export function trustProxySetting(raw: string | undefined): boolean | string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_TRUST_PROXY;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export async function createFastifyApp(
  options: FastifyServerOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify owns the logger, which is what gives every line a request id
    // without a correlation mechanism of our own.
    logger: loggerConfig(),
    // Proxy headers make req.ip meaningful behind the CLI launcher, Docker or
    // a reverse proxy, but only a proxy may set them. Trusting them from
    // anyone let a client choose its own address with X-Forwarded-For and
    // walk past every per-address limit, sign-in included. So: trusted from
    // loopback and private-network peers only (FOX_TRUST_PROXY overrides).
    trustProxy: trustProxySetting(process.env.FOX_TRUST_PROXY),
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
  });

  const hsts = options.hsts ?? process.env.FOX_HSTS === '1';

  // --- Origin policy, then CORS -------------------------------------------
  // The API holds database credentials and can run migrations, so only named
  // origins may call it with cookies. Refusing here rather than inside the cors
  // plugin turns a deliberate policy decision into a 403 the caller can read,
  // instead of the 500 that throwing produces — and keeps a refused
  // cross-origin request from ever reaching a route.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Host is the authority the browser addressed; paired with Origin it is the
    // same-origin check Docker / foxschema open need under NODE_ENV=production
    // (browsers send Origin on same-origin fetch, contrary to an earlier assumption).
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    const verdict = originVerdict(req.headers.origin, {
      requestOrigin: requestOriginFrom(req.protocol, host),
    });
    if (verdict.allowed) return;
    return reply.code(verdict.status).send({ ok: false, error: verdict.error, code: 'forbidden' });
  });

  await app.register(fastifyCors, {
    // The hook above has already refused anything not on the allowlist, so this
    // only ever sees permitted origins. It re-checks the static allowlist rather
    // than reflecting whatever arrives: if the hook is ever reordered or removed,
    // the failure should be a missing header, not a silently open API.
    // Same-origin requests do not need ACAO; returning false here only omits it.
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    // The frontend sends `credentials: 'include'` (session cookie).
    credentials: true,
  });

  // --- Security headers, before any route can answer ----------------------
  // An onRequest hook covers 404s, rate-limit rejections and error responses,
  // which is exactly where Express middleware ordering tends to leave gaps.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    for (const [key, value] of Object.entries(securityHeadersFor(pathOf(req), { hsts }))) {
      reply.header(key, value);
    }
    reply.removeHeader('x-powered-by');
  });

  // --- Floodgate ----------------------------------------------------------
  // Ahead of every route, and ahead of the Express layer entirely, so nothing
  // mounted on a more specific path can slip past it.
  const floodgate = new RateLimitCore({
    windowMs: 60_000,
    max: Number(process.env.FOX_RATE_LIMIT_GLOBAL_MAX) || 1200,
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api')) return;
    const decision = floodgate.consume(rateLimitKey('api-global', undefined, req.ip));
    reply.header('RateLimit-Limit', String(decision.limit));
    reply.header('RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSec));
      reply.header('RateLimit-Reset', String(decision.retryAfterSec));
      // Returning the reply short-circuits: no route, no Express, no database.
      return reply.code(429).send({ ok: false, error: RATE_LIMIT_MESSAGE });
    }
  });

  // --- Natively ported routes ---------------------------------------------
  // Registered before the Express bridge so they never touch it. This is the
  // migration path: each route moved here stops paying for two frameworks.
  // Health is first because it is trivial, has no dependencies, and is polled
  // constantly by the CLI launcher and the UI's offline banner.
  // `silent` because the CLI launcher and the UI's offline banner poll this
  // constantly; at info it would be most of the log volume and none of the
  // signal.
  // --- The built frontend, when this server also serves it -----------------
  if (options.staticDir) {
    await app.register(fastifyStatic, staticOptions(options.staticDir));
  }

  // --- The API ------------------------------------------------------------
  // Every route registered individually, with its own guards as its own
  // preHandler chain. There is no bridge and no shared middleware chain: a
  // limiter on an upload path costs nothing on /api/health.
  bindRoutes(app, buildApiRoutes());

  // Fastify allows exactly one not-found handler per instance, so it has one
  // owner: this function. When a staticDir is given, anything that is not an
  // API path and matched no file is the client-side router's problem and gets
  // index.html; an API path always gets JSON, because a 404 there is real.
  // A missing /assets/ file is a real 404 too: a tab left open across a release
  // asks for a chunk the new build no longer has, and index.html in its place
  // fails as a module with a misleading MIME error. On a 404 the page reloads.
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api') && !isAssetPath(req.url) && options.staticDir) {
      return reply.sendFile('index.html', options.staticDir);
    }
    return reply.code(404).send({ ok: false, error: 'Not found', code: 'not_found' });
  });

  // An unhandled throw must not return an HTML stack page to a JSON client.
  // The single place a request failure is logged. The database layer reports
  // timings at debug and re-throws; logging there as well would turn one
  // failure into several lines saying the same thing.
  app.setErrorHandler((error: unknown, req, reply) => {
    const code = (error as { statusCode?: number })?.statusCode ?? 500;
    // A 4xx is the caller's mistake, not a server failure — logging those at
    // error makes the level meaningless.
    if (code >= 500) {
      req.log.error({ err: error, method: req.method, url: req.url }, 'request failed');
    } else {
      req.log.debug({ err: error, method: req.method, url: req.url }, 'request rejected');
    }
    return errorReply(error, reply);
  });

  function errorReply(error: unknown, reply: FastifyReply) {
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    const errCode = (error as { code?: string })?.code;
    // Fastify's own text is "Request body is too large", which does not say
    // what "too large" is. Naming the limit is the difference between an error
    // a caller can act on and one they have to go looking for.
    const message =
      errCode === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? `Request body is larger than the ${BODY_LIMIT} limit.`
        : error instanceof Error
          ? error.message
          : 'Request failed.';
    reply.code(status).send({
      ok: false,
      // A 5xx must not leak internals; a 4xx is the caller's own mistake and
      // is more useful stated plainly.
      error: status >= 500 ? 'Internal server error.' : message,
      // Framework-level failures are answered before any route runs, so they
      // never passed through `sendError` and were the one class of error
      // without a code — a client parsing `code` had to special-case exactly
      // the responses it is least able to predict.
      code: codeForStatus(status),
    });
  }

  return app;
}
