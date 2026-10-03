/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The rate-limit decision, with no framework in it.
 *
 * Express and Fastify both need this policy while the migration is staged, and
 * two copies of a security control is how they drift — one gets a fix, the
 * other quietly does not. The decision lives here once; each server contributes
 * only "who is calling" and "how to write a 429".
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Ceiling, for RateLimit-Limit. */
  limit: number;
  /** Requests left in the window after this one. */
  remaining: number;
  /** Seconds until room frees up. Only meaningful when blocked. */
  retryAfterSec: number;
}

export interface RateLimitCoreOptions {
  windowMs: number;
  max: number;
}

/** How often a full sweep may run, so distinct keys cannot grow without bound. */
const SWEEP_EVERY_MS = 30_000;

/**
 * Hard ceiling on tracked keys.
 *
 * The periodic sweep bounds keys *over time*, not *between sweeps*: a flood
 * from rotating source addresses can add a key per request for a full 30
 * seconds, which is the memory exhaustion this limiter exists to prevent.
 */
const MAX_KEYS = 20_000;

export class RateLimitCore {
  private readonly buckets = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly options: RateLimitCoreOptions) {}

  /** Tracked keys — exposed so the memory bound is testable. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Record an attempt and say whether it may proceed.
   *
   * A sliding window of timestamps rather than a counter reset on a clock edge:
   * a fixed window lets a caller send `max` just before the boundary and `max`
   * just after, which is twice the intended rate back to back.
   */
  consume(key: string, now = Date.now()): RateLimitDecision {
    const { windowMs, max } = this.options;

    if (now - this.lastSweep > SWEEP_EVERY_MS) {
      this.lastSweep = now;
      for (const [k, hits] of this.buckets) {
        if (hits.length === 0 || now - hits[hits.length - 1] > windowMs) this.buckets.delete(k);
      }
    }

    let hits = this.buckets.get(key);
    if (!hits) {
      if (this.buckets.size >= MAX_KEYS) {
        // Sweep early — most entries at this point are usually expired.
        this.lastSweep = now;
        for (const [k, h] of this.buckets) {
          if (h.length === 0 || now - h[h.length - 1] > windowMs) this.buckets.delete(k);
        }
      }
      if (this.buckets.size >= MAX_KEYS) {
        // Still full: refuse the *new* key rather than evicting an existing
        // one. Eviction would be backwards here — under a rotating-address
        // flood the attacker's buckets are the freshest, so any recency-based
        // eviction discards the legitimate users and hands the attacker a
        // clean allowance. Refusing new keys degrades toward a global limit,
        // which is the safe direction.
        return {
          allowed: false,
          limit: max,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }
      hits = [];
      this.buckets.set(key, hits);
    }

    const cutoff = now - windowMs;
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    if (hits.length >= max) {
      const retryMs = Math.max(0, hits[0] + windowMs - now);
      return {
        allowed: false,
        limit: max,
        remaining: 0,
        // Never advertise 0 — a client reading it would retry instantly and be
        // refused again.
        retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }

    hits.push(now);
    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, max - hits.length),
      retryAfterSec: 0,
    };
  }

  /** Test seam and connection-edit reset. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Who to charge for a request.
 *
 * A session user is the fairest unit — it survives a changing IP and stops one
 * noisy caller from spending everyone else's allowance. IP is the fallback for
 * unauthenticated traffic, which is also the traffic most worth limiting.
 */
export function rateLimitKey(scope: string, userId: string | undefined, ip: string | undefined): string {
  return userId ? `${scope}:u:${userId}` : `${scope}:ip:${ip || 'unknown'}`;
}

/**
 * How many clients' allowance one connection may spend when it speaks for
 * others: a reverse proxy, or anyone in a range `trustProxy` believes.
 */
export const PEER_FACTOR = 10;

/**
 * The bucket for the connection itself, when an anonymous request names a
 * client other than the peer that sent it; undefined otherwise.
 *
 * `trustProxy` believes `X-Forwarded-For` from private-network peers, so one
 * such peer can claim a new address on every request and never meet its
 * per-address limit. Charging its own connection as well bounds that at
 * `PEER_FACTOR` clients' worth, while a real proxy's users share that much.
 */
export function peerRateLimitKey(
  scope: string,
  userId: string | undefined,
  ip: string | undefined,
  peer: string | undefined
): string | undefined {
  if (userId || !peer || peer === ip) return undefined;
  return `${scope}:peer:${peer}`;
}

export const RATE_LIMIT_MESSAGE =
  'Too many requests to the Fox Schema API. Please slow down and try again.';
