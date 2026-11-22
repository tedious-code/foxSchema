/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-process engine routes: who may reach them, grants, and admission.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { AdminConfigPut, WorkflowEngineConfig } from '@foxschema/shared';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../../platform/http/types';
import { createFeatureContext } from '../../app/feature-registry';
import { ENGINE_ROUTES } from './engine-routes';
import { createContext } from './runtime/context';
import { registerWorkflowEngine } from './runtime/register-engine';
import type { WorkflowSettingsService } from './workflow-settings.service';
import { createWorkflowRoutes } from './workflow.routes';

const ALL_WORKFLOW: Permission[] = ['workflow.access', 'workflow.design', 'workflow.run', 'workflow.admin'];

let app: FastifyInstance | undefined;
let engineCtx: ReturnType<typeof createContext> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  engineCtx?.close();
  engineCtx = undefined;
});

const usesForeign = {
  id: 'wf-1',
  name: 'wf-1',
  version: 1,
  pipelines: [
    {
      id: 'main',
      name: 'Main',
      pipes: [{ id: 'q', role: 'source', type: 'source.triggerPayload', credentialId: 'foxschema-conn-a', config: {}, concurrency: 1 }],
      edges: [],
    },
  ],
  triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  dependencies: [],
  middleware: [],
};

async function serve(
  permissions: Permission[],
  options: {
    state?: WorkflowEngineConfig['state'];
    foreignConnections?: string[];
  } = {},
) {
  const puts: AdminConfigPut[] = [];
  const config = (): WorkflowEngineConfig => ({
    state: options.state ?? 'enabled',
    endpoint: '',
    maxParallel: 4,
    onOverlap: 'skip',
    processes: [],
    sinks: [],
  });
  const settings = {
    getConfig: async () => config(),
    putConfig: async (body: AdminConfigPut) => {
      puts.push(body);
      return { ...config(), ...body };
    },
    probeEngineHealth: async () => ({ ok: true, acceptsRuns: config().state === 'enabled' }),
  } as unknown as WorkflowSettingsService;

  engineCtx = createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
  const root = Router();
  root.use(
    '/api/workflow',
    createWorkflowRoutes({
      settings,
      grants: {
        list: async () => [],
        grant: async () => undefined,
        revoke: async () => false,
        notUsableBy: async (_userId: string, ids: readonly string[]) =>
          ids.filter((id) => (options.foreignConnections ?? []).includes(id)),
      },
    }),
  );

  app = Fastify({ forceCloseConnections: true });
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'user-1';
    authed.appRole = 'viewer';
    authed.permissions = new Set(permissions);
  });
  bindRoutes(app, root.flatten());
  await registerWorkflowEngine(app, {
    ctx: engineCtx,
    featureContext: createFeatureContext(),
    settings,
    grants: {
      notUsableBy: async (_userId: string, ids: readonly string[]) =>
        ids.filter((id) => (options.foreignConnections ?? []).includes(id)),
    },
    sessionGuard: (_req, _res, next) => next(),
  });
  await app.ready();
  return { server: app, puts, ctx: engineCtx };
}

describe('in-process engine — who may reach it', () => {
  it('guards every allowlisted route: no permission, 403', async () => {
    const { server } = await serve([]);
    for (const route of ENGINE_ROUTES) {
      const url = `/api/workflow/engine${route.path.replace(/:[A-Za-z]+/g, 'x')}`;
      const res = await server.inject({ method: route.method, url });
      expect(res.statusCode, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('refuses an edit to a reader', async () => {
    const { server } = await serve(['workflow.access']);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('takes workflow.admin, not design, to store an engine credential', async () => {
    const designer = await serve(['workflow.design']);
    const denied = await designer.server.inject({
      method: 'POST',
      url: '/api/workflow/engine/credentials',
      payload: { name: 'n', kind: 'http', source: 'local', data: {} },
    });
    expect(denied.statusCode).toBe(403);
    await app?.close();
    app = undefined;
    engineCtx?.close();
    engineCtx = undefined;

    const admin = await serve(['workflow.admin']);
    const allowed = await admin.server.inject({
      method: 'POST',
      url: '/api/workflow/engine/credentials',
      payload: { name: 'n', kind: 'http', source: 'local', data: { token: 'x' } },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('does not expose trigger ingress, or anything else off the allowlist', async () => {
    const { server } = await serve(ALL_WORKFLOW);
    for (const [method, url] of [
      ['POST', '/api/workflow/engine/triggers/wf-1/hook'],
      ['GET', '/api/workflow/engine/setup/credentials'],
      ['POST', '/api/workflow/engine/workflows/wf-1/dry-run'],
      ['POST', '/api/workflow/engine/agent/propose-workflow'],
      ['POST', '/api/workflow/engine/workflows/wf-1/pipelines'],
      ['GET', '/api/workflow/engine/runs/x/snapshot'],
    ] as const) {
      const res = await server.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe('in-process engine — engine state', () => {
  it('refuses to start a run while the engine is not accepting runs', async () => {
    for (const state of ['draining', 'disabled'] as const) {
      const { server } = await serve(['workflow.run'], { state });
      const res = await server.inject({ method: 'POST', url: '/api/workflow/engine/workflows/wf-1/run' });
      expect(res.statusCode, state).toBe(409);
      expect(res.json().code).toBe('conflict');
      await app?.close();
      app = undefined;
      engineCtx?.close();
      engineCtx = undefined;
    }
  });
});

describe('PUT /api/workflow/settings', () => {
  const put = (server: FastifyInstance, payload: unknown) =>
    server.inject({ method: 'PUT', url: '/api/workflow/settings', payload: payload as object });

  it('ignores an endpoint field: the engine runs in this process', async () => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const res = await put(server, { endpoint: 'http://attacker.test', state: 'draining' });
    expect(res.statusCode).toBe(200);
    expect(puts).toEqual([{ endpoint: 'http://attacker.test', state: 'draining' }]);
  });

  it('takes workflow.admin', async () => {
    const { server, puts } = await serve(['workflow.access', 'workflow.design', 'workflow.run']);
    const res = await put(server, { state: 'disabled' });
    expect(res.statusCode).toBe(403);
    expect(puts).toEqual([]);
  });

  it.each([
    ['an unknown state', { state: 'paused' }],
    ['an unknown overlap policy', { onOverlap: 'replace' }],
    ['an unknown sink kind', { sinks: [{ kind: 'syslog', enabled: true }] }],
    ['sinks that are not an array', { sinks: 'json' }],
  ])('refuses %s and saves nothing', async (_label, payload) => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const res = await put(server, payload);
    expect(res.statusCode).toBe(400);
    expect(puts).toEqual([]);
  });

  it('saves every known value', async () => {
    const { server, puts } = await serve(ALL_WORKFLOW);
    const body = { state: 'draining', onOverlap: 'queue', sinks: [{ kind: 'events', enabled: true }] };
    const res = await put(server, body);
    expect(res.statusCode).toBe(200);
    expect(puts).toEqual([body]);
  });
});

describe('in-process engine — saved connections stay with their workspace', () => {
  const all = ['workflow.access', 'workflow.design', 'workflow.run'] as Permission[];

  it('refuses to save a workflow that uses another workspace’s connection', async () => {
    const { server } = await serve(all, { foreignConnections: ['conn-a'] });
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: usesForeign });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to run or delete it after reading the stored document', async () => {
    const { server, ctx } = await serve(all, { foreignConnections: ['conn-a'] });
    await ctx.workflows.put(usesForeign as never);
    const ran = await server.inject({ method: 'POST', url: '/api/workflow/engine/workflows/wf-1/run' });
    expect(ran.statusCode).toBe(403);
    const deleted = await server.inject({ method: 'DELETE', url: '/api/workflow/engine/workflows/wf-1' });
    expect(deleted.statusCode).toBe(403);
  });

  it('refuses an import whose package names the connection', async () => {
    const { server } = await serve(all, { foreignConnections: ['conn-a'] });
    const res = await server.inject({
      method: 'POST',
      url: '/api/workflow/engine/workflows/import',
      payload: { package: { format: 'foxflow.workflow', workflow: usesForeign } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a member of the connection’s workspace through the grant check', async () => {
    const { server } = await serve(all);
    const saved = await server.inject({ method: 'PUT', url: '/api/workflow/engine/workflows/wf-1', payload: usesForeign });
    expect(saved.statusCode).not.toBe(403);
  });

  it('omits a run whose snapshot uses a connection the caller cannot use', async () => {
    const own = {
      ...usesForeign,
      id: 'wf-own',
      name: 'wf-own',
      pipelines: [
        {
          ...usesForeign.pipelines[0],
          pipes: [{ ...usesForeign.pipelines[0]!.pipes[0]!, credentialId: 'foxschema-conn-b' }],
        },
      ],
    };
    const { server, ctx } = await serve(all, { foreignConnections: ['conn-a'] });
    await ctx.workflows.put(usesForeign as never);
    await ctx.workflows.put(own as never);
    const hidden = await ctx.scheduler.enqueue(usesForeign as never);
    const shown = await ctx.scheduler.enqueue(own as never);
    expect(hidden.accepted && hidden.run).toBeTruthy();
    expect(shown.accepted && shown.run).toBeTruthy();
    const res = await server.inject({ method: 'GET', url: '/api/workflow/engine/runs' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(shown.run!.id);
    expect(ids).not.toContain(hidden.run!.id);
  });
});
