/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionModule } from '@foxschema/db';
import type { Permission } from '@foxschema/shared';
import type { AuthedRequest } from '../../platform/http/types';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { createAccessRoutes } from './access.routes';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(permissions: Permission[]) {
  const resolveRef = vi.fn().mockResolvedValue({
    dialect: 'unsupported',
    schema: 'public',
    option: {},
  });
  const router = createAccessRoutes({
    resolveRef,
    connectionModule: {} as ConnectionModule,
  });
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'viewer-user';
    authed.appRole = 'viewer';
    authed.permissions = new Set(permissions);
  });
  bindRoutes(app, router.flatten());
  await app.ready();
  return { server: app, resolveRef };
}

describe('table insight permissions', () => {
  it('allows viewers who can run Data Peek queries', async () => {
    const { server, resolveRef } = await serve(['editor.run']);
    const res = await server.inject({
      method: 'POST',
      url: '/schema/table-insight',
      payload: { connectionId: 'c1', table: 'orders' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).not.toBe('forbidden');
    expect(resolveRef).toHaveBeenCalledOnce();
  });

  it('does not grant SQL Editor insight through Utilities alone', async () => {
    const { server, resolveRef } = await serve(['utility.access']);
    const res = await server.inject({
      method: 'POST',
      url: '/schema/table-insight',
      payload: { connectionId: 'c1', table: 'orders' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden', missing: ['editor.run'] });
    expect(resolveRef).not.toHaveBeenCalled();
  });
});

describe('db-access catalog permissions', () => {
  it('allows Access workspace viewers with access.access (not only utility.access)', async () => {
    const { server, resolveRef } = await serve(['access.access']);
    const res = await server.inject({
      method: 'POST',
      url: '/schema/db-access',
      payload: { connectionId: 'c1' },
    });

    // Unsupported dialect fails after the permission check — not 403.
    expect(res.statusCode).not.toBe(403);
    expect(resolveRef).toHaveBeenCalledOnce();
  });

  it('still allows Utilities → Database Access via utility.access', async () => {
    const { server, resolveRef } = await serve(['utility.access']);
    const res = await server.inject({
      method: 'POST',
      url: '/schema/db-access',
      payload: { connectionId: 'c1' },
    });

    expect(res.statusCode).not.toBe(403);
    expect(resolveRef).toHaveBeenCalledOnce();
  });

  it('rejects callers with neither utility.access nor access.*', async () => {
    const { server, resolveRef } = await serve(['editor.run']);
    const res = await server.inject({
      method: 'POST',
      url: '/schema/db-access',
      payload: { connectionId: 'c1' },
    });

    expect(res.statusCode).toBe(403);
    expect(resolveRef).not.toHaveBeenCalled();
  });
});
