/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Linking a saved connection to workflows: the grant, the engine credential
 * that points at it, and what happens when the engine cannot record it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { WorkflowConnectionSummary, WorkflowEngineConfig } from '@foxschema/workflow-contract';
import type { CredentialStore } from '@foxschema/workflow-engine';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../../platform/http/types';
import type { WorkflowSettingsService } from './workflow-settings.service';
import { createWorkflowRoutes } from './workflow.routes';

const CONNECTION: WorkflowConnectionSummary = {
  id: 'conn-1',
  name: 'Warehouse',
  dialect: 'postgres',
  hasPassword: true,
  granted: false,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(permissions: Permission[], engineOk = true) {
  const granted = new Set<string>();
  const engineCalls: Array<{ method: string; id?: string; body?: unknown }> = [];
  const settings = {
    getConfig: async (): Promise<WorkflowEngineConfig> => ({
      state: 'enabled',
      endpoint: '',
      maxParallel: 4,
      onOverlap: 'skip',
      processes: [],
      sinks: [],
    }),
  } as unknown as WorkflowSettingsService;
  const credentials = {
    create: async (input) => {
      engineCalls.push({ method: 'create', body: input });
      if (!engineOk) throw new Error('engine down');
      return { id: input.id ?? 'id', name: input.name, kind: input.kind, source: input.source ?? 'local', createdAt: '', updatedAt: '' };
    },
    remove: async (id) => {
      engineCalls.push({ method: 'remove', id });
      return true;
    },
  } as Pick<CredentialStore, 'create' | 'remove'>;
  const grants = {
    list: async () => [{ ...CONNECTION, granted: granted.has(CONNECTION.id) }],
    grant: async (_scope: unknown, id: string) => {
      if (id !== CONNECTION.id) return undefined;
      granted.add(id);
      return CONNECTION.name;
    },
    revoke: async (_user: string, id: string) => granted.delete(id),
    notUsableBy: async () => [],
  };

  const root = Router();
  root.use('/api/workflow', createWorkflowRoutes({ settings, grants, credentials }));
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'user-1';
    authed.appRole = 'viewer';
    authed.permissions = new Set(permissions);
  });
  bindRoutes(app, root.flatten());
  await app.ready();
  return { server: app, granted, engineCalls };
}

describe('workflow connection routes', () => {
  it('grants the connection and records an engine credential that only references it', async () => {
    const { server, granted, engineCalls } = await serve(['workflow.design']);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/connections/conn-1/grant' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, credentialId: 'foxschema-conn-1' });
    expect(granted.has('conn-1')).toBe(true);
    expect(engineCalls).toEqual([
      {
        method: 'create',
        body: {
          id: 'foxschema-conn-1',
          name: 'Warehouse',
          kind: 'database',
          source: 'foxschema',
          data: { connectionId: 'conn-1' },
        },
      },
    ]);
  });

  it('takes the grant back when the engine does not record the credential', async () => {
    const { server, granted } = await serve(['workflow.design'], false);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/connections/conn-1/grant' });
    expect(res.statusCode).toBe(503);
    expect(granted.has('conn-1')).toBe(false);
  });

  it('refuses a connection that is not the caller’s, without calling the engine', async () => {
    const { server, engineCalls } = await serve(['workflow.design']);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/connections/someone-else/grant' });
    expect(res.statusCode).toBe(404);
    expect(engineCalls).toEqual([]);
  });

  it('removes the engine credential when the grant is revoked', async () => {
    const { server, engineCalls } = await serve(['workflow.design']);
    await server.inject({ method: 'PUT', url: '/api/workflow/connections/conn-1/grant' });
    const res = await server.inject({ method: 'DELETE', url: '/api/workflow/connections/conn-1/grant' });
    expect(res.statusCode).toBe(200);
    expect(engineCalls.at(-1)).toEqual({ method: 'remove', id: 'foxschema-conn-1' });
  });

  it('needs workflow.design', async () => {
    const { server, engineCalls } = await serve(['workflow.access']);
    const res = await server.inject({ method: 'PUT', url: '/api/workflow/connections/conn-1/grant' });
    expect(res.statusCode).toBe(403);
    expect(engineCalls).toEqual([]);
  });
});
