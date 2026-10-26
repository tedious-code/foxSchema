/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the SQL editor tells a SQL Tracer: each statement it ran on a saved
 * connection someone is tracing, and nothing when nobody is.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRoutes } from '../../platform/http/fastify-bind';
import type { AuthedRequest } from '../../platform/http/types';
import { SqlActivityFeed, type SqlActivity } from '../../platform/sql-activity/sql-activity';

vi.mock('./sql-execute.service', async (importActual) => ({
  ...(await importActual<typeof import('./sql-execute.service')>()),
  runStatements: vi.fn(async () => [
    { ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, durationMs: 3 },
    { ok: false, error: 'relation "nope" does not exist', durationMs: 1 },
  ]),
}));

const { createEditorRoutes } = await import('./editor.routes');

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(sqlActivity: SqlActivityFeed) {
  const router = createEditorRoutes({
    resolveRef: vi.fn().mockResolvedValue({
      dialect: 'postgres',
      schema: 'public',
      option: { host: 'db', database: 'shop', username: 'app', password: 'hunter2' },
    }),
    MAX_STATEMENTS: 10,
    MAX_STATEMENT_LENGTH: 10_000,
    isRunnableStatement: () => true,
    sqlActivity,
  });
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'u1';
    authed.appRole = 'admin';
  });
  bindRoutes(app, router.flatten());
  await app.ready();
  return app;
}

const run = (server: FastifyInstance, payload: Record<string, unknown>) =>
  server.inject({ method: 'POST', url: '/sql/execute', payload: { statements: ['SELECT 1', 'SELECT * FROM nope'], ...payload } });

describe('SQL editor → SQL Tracer', () => {
  it('reports each statement it ran on a traced saved connection', async () => {
    const feed = new SqlActivityFeed();
    const heard: SqlActivity[] = [];
    feed.listen('c1', (a) => heard.push(a));
    expect((await run(await serve(feed), { connectionId: 'c1' })).statusCode).toBe(200);
    expect(heard.map(({ text, user, database, rows, error }) => ({ text, user, database, rows, error }))).toEqual([
      { text: 'SELECT 1', user: 'app', database: 'shop', rows: 1, error: null },
      { text: 'SELECT * FROM nope', user: 'app', database: 'shop', rows: null, error: 'relation "nope" does not exist' },
    ]);
  });

  it('reports nothing for a connection nobody traces', async () => {
    const feed = new SqlActivityFeed();
    const heard: SqlActivity[] = [];
    feed.listen('c1', (a) => heard.push(a));
    await run(await serve(feed), { connectionId: 'c2' });
    await run(app!, { dialect: 'postgres', option: {} });
    expect(heard).toEqual([]);
  });
});
