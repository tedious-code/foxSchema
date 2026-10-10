/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * composeFeatures turns each mount's access level into its guard chain. A
 * mistake here would put a route in front of the wrong people, so each
 * level is pinned, and so is the one rate limiter shared by the whole group.
 */
import { describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import type { FastifyReply } from 'fastify';
import { Router } from '../platform/http/router';
import type { AppRequest } from '../platform/http/types';
import { composeFeatures, createFeatureContext } from './feature-registry';
import type { FeatureAccess, ServerFeatureModule } from './feature-module';

function feature(id: string, mounts: Array<{ prefix: string; access: FeatureAccess; rateLimited?: boolean }>): ServerFeatureModule {
  return {
    id,
    mounts: mounts.map((m) => ({
      ...m,
      routes: () => {
        const r = Router();
        r.get(`/${id}`, (_req: AppRequest, res: FastifyReply) => {
          res.send({ ok: true });
        });
        return r;
      },
    })),
  };
}

const ctx = createFeatureContext();

function guardsOf(features: ServerFeatureModule[]) {
  return new Map(composeFeatures(features, ctx).flatten().map((r) => [`${r.method} ${r.path}`, r.middlewares]));
}

describe('composeFeatures', () => {
  it('derives each mount’s guards from its access level', () => {
    const routes = guardsOf([
      feature('pub', [{ prefix: '/api/a', access: 'public' }]),
      feature('int', [{ prefix: '/api/b', access: 'internal' }]),
      feature('usr', [{ prefix: '/api/c', access: 'user' }]),
      feature('reg', [{ prefix: '/api/d', access: 'registered' }]),
      feature('lim', [{ prefix: '/api', access: 'user', rateLimited: true }]),
    ]);
    expect(routes.get('GET /api/a/pub')).toHaveLength(0);
    expect(routes.get('GET /api/b/int')).toHaveLength(0);
    expect(routes.get('GET /api/c/usr')).toHaveLength(1);
    expect(routes.get('GET /api/d/reg')).toHaveLength(2);
    expect(routes.get('GET /api/lim')).toHaveLength(2);
    // The same session guard everywhere, and registered adds a different second one.
    const session = routes.get('GET /api/c/usr')![0];
    expect(routes.get('GET /api/d/reg')![0]).toBe(session);
    expect(routes.get('GET /api/lim')![0]).toBe(session);
    expect(routes.get('GET /api/d/reg')![1]).not.toBe(routes.get('GET /api/lim')![1]);
  });

  it('gives every rate-limited mount the same limiter: one budget per caller, not one per feature', () => {
    const routes = guardsOf([
      feature('one', [{ prefix: '/api', access: 'user', rateLimited: true }]),
      feature('two', [{ prefix: '/api', access: 'user', rateLimited: true }]),
    ]);
    expect(routes.get('GET /api/one')![1]).toBe(routes.get('GET /api/two')![1]);
  });

  it('mounts public routes before guarded ones, whatever the registry order', () => {
    const order = composeFeatures(
      [feature('guarded', [{ prefix: '/api/x', access: 'user' }]), feature('open', [{ prefix: '/api/y', access: 'public' }])],
      ctx
    )
      .flatten()
      .map((r) => r.path);
    expect(order).toEqual(['/api/y/open', '/api/x/guarded']);
  });

  it('refuses a feature registered twice, and a public mount behind the per-caller limit', () => {
    expect(() => composeFeatures([feature('dup', []), feature('dup', [])], ctx)).toThrow(/registered twice/);
    expect(() => composeFeatures([feature('p', [{ prefix: '/api', access: 'public', rateLimited: true }])], ctx)).toThrow(
      /rate limit/
    );
  });
});
