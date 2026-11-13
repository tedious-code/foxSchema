/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/middleware.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function doc(middleware: unknown[]) {
  return {
    name: 'mw',
    middleware,
    pipelines: [
      {
        id: 'main',
        name: 'main',
        pipes: [
          { id: 'src', role: 'source', type: 'source.triggerPayload', config: {} },
        ],
        edges: [],
      },
    ],
  };
}

describe('workflow middleware references (API)', () => {
  it('rejects unknown middleware names at save, accepts registered ones', async () => {
    const ctx = createContext({
      databasePath: ':memory:',
      encryptionKey: randomBytes(32),
    });
    ctx.middleware.register('metrics', async (_ctx, next) => next());
    const app = buildApp(ctx);

    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/workflows/mw',
      payload: doc(['metrics', 'ghost']),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('unknown middleware: ghost');

    const known = await app.inject({
      method: 'PUT',
      url: '/api/workflows/mw',
      payload: doc([{ name: 'metrics', config: { sample: 1 } }]),
    });
    expect(known.statusCode).toBe(200);
    expect(known.json().middleware).toEqual([
      { name: 'metrics', config: { sample: 1 } },
    ]);
    await app.close();
  });

  it('lists registered middleware with tiers (built-in log included)', async () => {
    const ctx = createContext({
      databasePath: ':memory:',
      encryptionKey: randomBytes(32),
    });
    ctx.middleware.register('gate', async (_ctx, next) => next(), {
      tiers: ['engine'],
    });
    const app = buildApp(ctx);

    const res = await app.inject({ method: 'GET', url: '/api/middleware' });
    expect(res.statusCode).toBe(200);
    expect(res.json().middleware).toEqual(
      expect.arrayContaining([
        { name: 'log', tiers: ['engine', 'workflow', 'pipeline'] },
        { name: 'gate', tiers: ['engine'] },
      ]),
    );
    await app.close();
  });
});
