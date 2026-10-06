/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Server Beam's pre-flight.
 *
 * A Beam cell is usually a copy: `sql.on('source')` reads and
 * `sql.on('target')` writes. Finding out the target is unreachable only when
 * the write is attempted means the read side has already run, and on a cell
 * that stages or deletes rows that leaves work half-applied with no way to
 * finish it. These tests are about failing before anything runs, and about
 * saying enough in the message to act on.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorRoutes } from './editor.routes';
import { bindRoutes } from '../../platform/http/fastify-bind';
import type { AuthedRequest } from '../../platform/http/types';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const RESOLVED = {
  dialect: 'postgres',
  schema: 'public',
  option: { host: 'db.internal', port: 5432, database: 'orders', password: 'hunter2' },
};

async function serve(
  over: Partial<Parameters<typeof createEditorRoutes>[0]> = {},
  actor: Pick<AuthedRequest, 'appRole' | 'permissions'> = { appRole: 'admin' }
) {
  const router = createEditorRoutes({
    resolveRef: vi.fn().mockResolvedValue(RESOLVED),
    MAX_STATEMENTS: 10,
    MAX_STATEMENT_LENGTH: 10_000,
    isRunnableStatement: () => true,
    ...over,
  });
  app = Fastify();
  // The route runs behind the auth guard; these tests are about the pre-flight,
  // so the request arrives already authenticated as an admin.
  app.addHook('onRequest', async (req) => {
    // The auth fields live on AuthedRequest, not on every FastifyRequest.
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'test-user';
    authed.appRole = actor.appRole;
    authed.permissions = actor.permissions;
  });
  bindRoutes(app, router.flatten());
  await app.ready();
  return app;
}

const beamCell = (aliases: string[]) => ({
  kind: 'js',
  body: "return await sql.on('target')`SELECT 1`;",
  beam: aliases.map((alias, i) => ({ alias, connectionId: `c${i}` })),
  allowWrites: false,
});

describe('Server Beam pre-flight', () => {
  it('refuses before running when an endpoint is unreachable', async () => {
    const testConnection = vi
      .fn()
      // source is fine, target is not — the ordering that matters.
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.9:5432'));

    const server = await serve({ testConnection });
    const res = await server.inject({
      method: 'POST',
      url: '/sql/code-cell',
      payload: beamCell(['source', 'target']),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.json() as { error: string; code: string };
    // Which alias, so the reader knows which half of the copy is broken.
    expect(body.error).toContain("sql.on('target')");
    expect(body.error).toContain('db.internal:5432/orders');
    expect(body.error).toContain('ECONNREFUSED');
    // And that no part of the cell ran, which is the point of checking first.
    expect(body.error).toContain('Nothing was run');
  });

  it('never puts the password in the message', async () => {
    // The text reaches the browser and a toast; the option carries a password.
    const server = await serve({
      testConnection: vi.fn().mockResolvedValue({ success: false }),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/sql/code-cell',
      payload: beamCell(['source']),
    });
    expect(res.json().error).not.toContain('hunter2');
  });

  it('treats a probe that answers false as unreachable', async () => {
    // Some drivers resolve with `success: false` rather than throwing.
    const server = await serve({
      testConnection: vi.fn().mockResolvedValue({ success: false }),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/sql/code-cell',
      payload: beamCell(['source']),
    });
    expect(res.json().error).toContain('refused the connection');
  });

  it('checks every endpoint, not only the first', async () => {
    const testConnection = vi.fn().mockResolvedValue({ success: true });
    const server = await serve({ testConnection });
    await server.inject({ method: 'POST', url: '/sql/code-cell', payload: beamCell(['source', 'target']) });
    expect(testConnection).toHaveBeenCalledTimes(2);
  });

  it('keeps working when no probe is available', async () => {
    // The dependency is optional; without it the old behaviour stands rather
    // than the route failing closed on every Beam cell.
    const server = await serve({ testConnection: undefined });
    const res = await server.inject({
      method: 'POST',
      url: '/sql/code-cell',
      payload: beamCell(['source']),
    });
    // It got past the pre-flight — whatever happens next is the cell's business.
    expect(res.json().error ?? '').not.toContain('cannot reach');
  });
});

describe('TypeScript cells compile on the server', () => {
  const transpile = (body: unknown) =>
    app!.inject({ method: 'POST', url: '/sql/code-cell/transpile', payload: body as object });

  it('returns the JavaScript, types stripped, without running it', async () => {
    await serve();
    // Running this would throw; compiling it must not.
    const res = await transpile({ source: 'const n: number = 2;\nthrow new Error(`ran ${n}`);' });
    expect(res.statusCode).toBe(200);
    const { js } = res.json() as { js: string };
    expect(js).toContain('const n = 2;');
    expect(js).not.toContain(': number');
  });

  it('answers a type error with the compiler’s words, as a 400', async () => {
    await serve();
    const res = await transpile({ source: 'const x: = 1;' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/Type expected|expected/i);
  });

  it('is refused to someone who cannot open the SQL editor', async () => {
    await serve({}, { appRole: 'viewer', permissions: new Set() });
    expect((await transpile({ source: 'const a: number = 1;' })).statusCode).toBe(403);
  });

  it('refuses a missing or oversized source', async () => {
    await serve();
    expect((await transpile({})).statusCode).toBe(400);
    expect((await transpile({ source: 'x'.repeat(100_001) })).statusCode).toBe(400);
  });
});

