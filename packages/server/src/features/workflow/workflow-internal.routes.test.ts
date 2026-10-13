/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The route that hands decrypted connections to the workflow engine sits
 * outside the user session. Everything here is about who it refuses.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONNECTION_RESOLVE_PATH,
  WORKFLOW_ENGINE_CONFIG_PATH,
  WORKFLOW_INTERNAL_PREFIX,
  type ResolvedWorkflowConnection,
  type WorkflowEngineConfig,
} from '@foxschema/workflow-contract';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { Router } from '../../platform/http/router';
import { engineTokenGuard } from '../../platform/guards/engine-token';
import { createWorkflowInternalRoutes } from './workflow-internal.routes';

const TOKEN = 'a-long-shared-service-token';
const RESOLVED: ResolvedWorkflowConnection = {
  dialect: 'postgres',
  option: { host: 'db.internal', password: 'from-foxschema' },
};

const SAVED_CONFIG: WorkflowEngineConfig = {
  state: 'draining',
  endpoint: 'http://engine.internal:8081',
  maxParallel: 3,
  onOverlap: 'skip',
  processes: [],
  sinks: [{ kind: 'json', enabled: true, target: 'runs.jsonl' }],
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Mounted where the feature registry mounts it — behind the token guard it puts
 * on every `internal` mount — with a grants stand-in that records lookups.
 */
async function serve(token: string | undefined) {
  const lookedUp: string[] = [];
  const root = Router();
  root.use(
    WORKFLOW_INTERNAL_PREFIX,
    engineTokenGuard(token),
    createWorkflowInternalRoutes(
      {
        resolveForEngine: async (id: string) => {
          lookedUp.push(id);
          return id === 'granted' ? RESOLVED : undefined;
        },
      },
      { getConfig: async () => SAVED_CONFIG },
    ),
  );
  app = Fastify();
  bindRoutes(app, root.flatten());
  await app.ready();
  return { server: app, lookedUp };
}

function resolve(server: FastifyInstance, body: unknown, authorization?: string) {
  return server.inject({
    method: 'POST',
    url: WORKFLOW_CONNECTION_RESOLVE_PATH,
    payload: body as Record<string, unknown>,
    headers: authorization ? { authorization } : {},
  });
}

describe('workflow internal routes', () => {
  it('hands a granted connection to a caller holding the token, uncached', async () => {
    const { server } = await serve(TOKEN);
    const res = await resolve(server, { connectionId: 'granted' }, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RESOLVED);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['no authorization header', undefined],
    ['the wrong token', 'Bearer not-the-token-at-all-nope'],
    ['the token with a byte appended', `Bearer ${TOKEN}x`],
    ['the token under another scheme', `Basic ${TOKEN}`],
  ])('refuses %s without looking anything up', async (_label, authorization) => {
    const { server, lookedUp } = await serve(TOKEN);
    const res = await resolve(server, { connectionId: 'granted' }, authorization);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('from-foxschema');
    expect(lookedUp).toEqual([]);
  });

  it('answers 503 when no token is configured, rather than opening up', async () => {
    const { server, lookedUp } = await serve(undefined);
    const res = await resolve(server, { connectionId: 'granted' }, 'Bearer anything');
    expect(res.statusCode).toBe(503);
    expect(lookedUp).toEqual([]);
  });

  it('gives one answer for an unknown connection and an ungranted one', async () => {
    const { server } = await serve(TOKEN);
    const res = await resolve(server, { connectionId: 'not-granted' }, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(404);
  });

  it('gives the engine the settings it applies, and nothing else', async () => {
    const { server } = await serve(TOKEN);
    const res = await server.inject({
      method: 'GET',
      url: WORKFLOW_ENGINE_CONFIG_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'draining', maxParallel: 3, sinks: SAVED_CONFIG.sinks });
  });

  it('holds the settings behind the token too', async () => {
    const { server } = await serve(TOKEN);
    const res = await server.inject({ method: 'GET', url: WORKFLOW_ENGINE_CONFIG_PATH });
    expect(res.statusCode).toBe(401);
  });

  it('requires a connection id', async () => {
    const { server, lookedUp } = await serve(TOKEN);
    const res = await resolve(server, {}, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(400);
    expect(lookedUp).toEqual([]);
  });
});
