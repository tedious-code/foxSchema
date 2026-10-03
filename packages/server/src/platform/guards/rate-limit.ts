import type { FastifyReply } from 'fastify';
import type { AuthedRequest, Middleware, NextFunction } from '../../platform/http/types';
import {
  PEER_FACTOR,
  peerRateLimitKey,
  RateLimitCore,
  RATE_LIMIT_MESSAGE,
  rateLimitKey,
} from './rate-limit-core';
import { sendError } from '../../platform/http/respond';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket namespace, so one endpoint's flood cannot spend another's allowance. */
  name?: string;
  message?: string;
}

/**
 * A per-route guard over the shared limiter.
 *
 * The sliding-window decision lives in `rate-limit-core`, which the server's
 * global floodgate uses too, so both enforce one policy.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { windowMs, max, name = 'default' } = options;
  const message = options.message ?? RATE_LIMIT_MESSAGE;
  const core = new RateLimitCore({ windowMs, max });
  const peers = new RateLimitCore({ windowMs, max: max * PEER_FACTOR });

  return (req: AuthedRequest, res: FastifyReply, next: NextFunction): void => {
    // Signed-in callers get their own bucket; anonymous ones share by IP.
    const decision = core.consume(rateLimitKey(name, req.userId, req.ip));

    res.header('RateLimit-Limit', String(decision.limit));
    res.header('RateLimit-Remaining', String(decision.remaining));

    // A forwarded address is only a claim: the connection that made it pays too.
    const peerKey = decision.allowed ? peerRateLimitKey(name, req.userId, req.ip, req.raw?.socket?.remoteAddress) : undefined;
    const blocked = !decision.allowed ? decision : peerKey ? peers.consume(peerKey) : undefined;

    if (blocked && !blocked.allowed) {
      res.header('Retry-After', String(blocked.retryAfterSec));
      res.header('RateLimit-Reset', String(blocked.retryAfterSec));
      sendError(res, 'rate_limited', message);
      return;
    }
    next();
  };
}

/**
 * Per-user limit for the routes that reach a database.
 *
 * Mounted after the guard so it can charge a session rather than an address.
 * Before this existed, 28 of the 38 routes in `createApiRoutes` had no limit at
 * all, including every one that opens a connection.
 */
export function defaultApiRateLimit(): Middleware {
  return rateLimit({
    name: 'api',
    windowMs: 60_000,
    max: Number(process.env.FOX_RATE_LIMIT_MAX) || 600,
  });
}
