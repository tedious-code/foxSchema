/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { AuthedRequest } from '../../platform/http/types';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { SqlActivityFeed } from '../../platform/sql-activity/sql-activity';
import { createSqlTraceRoutes } from './sql-trace.routes';
import { SqlTraceService } from './sql-trace.service';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(permissions: Permission[], dialect = 'postgres') {
  const resolveRef = vi.fn().mockResolvedValue({ dialect, schema: 'public', option: { password: 'pw' } });
  const activity = new SqlActivityFeed();
  const probeSessions = vi.fn().mockResolvedValue({ ok: true, sessions: [] });
  const service = new SqlTraceService({ activity, probeSessions });
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = req.headers['x-user'] === 'other' ? 'u2' : 'u1';
    authed.appRole = 'owner';
    authed.permissions = new Set(permissions);
  });
  bindRoutes(app, createSqlTraceRoutes({ service, resolveRef }).flatten());
  await app.ready();
  const start = (payload: Record<string, unknown>) => app!.inject({ method: 'POST', url: '/start', payload });
  return { server: app, resolveRef, activity, start };
}

describe('sql-trace routes', () => {
  it('needs utility.trace on every route', async () => {
    const { server, resolveRef, start } = await serve(['utility.access', 'editor.run']);
    expect((await start({ connectionId: 'c1', mode: 'fox' })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/t1/events' })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/t1/stop' })).statusCode).toBe(403);
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('traces only a saved connection, in a known mode', async () => {
    const { start } = await serve(['utility.trace']);
    expect((await start({ mode: 'fox', dialect: 'postgres', option: {} })).statusCode).toBe(400);
    expect((await start({ connectionId: 'c1', mode: 'everything' })).statusCode).toBe(400);
  });

  it('resolves the connection, so a trace needs access to it', async () => {
    const { resolveRef, start } = await serve(['utility.trace']);
    await start({ connectionId: 'c1', mode: 'fox', password: 'session-pw' });
    expect(resolveRef.mock.calls[0]![1]).toEqual({ connectionId: 'c1', password: 'session-pw' });
  });

  it('refuses live on an engine with no session list', async () => {
    const { start } = await serve(['utility.trace'], 'sqlite');
    const res = await start({ connectionId: 'c1', mode: 'live' });
    expect(res.statusCode).toBe(400);
  });

  it('starts, reads and stops a Fox activity trace', async () => {
    const { server, activity, start } = await serve(['utility.trace']);
    const started = await start({ connectionId: 'c1', mode: 'fox' });
    expect(started.statusCode).toBe(200);
    const { id } = started.json().status;
    activity.report({ connectionId: 'c1', text: 'SELECT 1', user: 'app', database: null, durationMs: 1, rows: 1, error: null, at: new Date() });

    const page = await server.inject({ method: 'GET', url: `/${id}/events?after=0` });
    expect(page.json().events.map((e: { text: string }) => e.text)).toEqual(['SELECT 1']);
    // The session password never comes back.
    expect(page.body).not.toContain('pw');

    const stopped = await server.inject({ method: 'POST', url: `/${id}/stop` });
    expect(stopped.json().status).toMatchObject({ running: false, stopReason: 'stopped' });
  });

  it('answers someone else’s trace as missing', async () => {
    const { server, start } = await serve(['utility.trace']);
    const { id } = (await start({ connectionId: 'c1', mode: 'fox' })).json().status;
    const res = await server.inject({ method: 'GET', url: `/${id}/events`, headers: { 'x-user': 'other' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a bad cursor', async () => {
    const { server } = await serve(['utility.trace']);
    expect((await server.inject({ method: 'GET', url: '/t1/events?after=-1' })).statusCode).toBe(400);
  });
});
