/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Running a migration needs `schema.migrate`, checked at the route.
 *
 * `/migration/execute` applies DDL to a real database, and unlike Compare it
 * has no service of its own that checks the permission again: the route guard
 * is the only thing between a viewer and the target. So the refusal has to
 * come before anything else, the connection lookup included.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { AuthedRequest } from '../auth/auth.routes';
import { bindRoutes } from '../../platform/http/fastify-bind';
import { createMigrationRoutes } from './migration.routes';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(permissions: Permission[]) {
  // Rejecting stops a permitted request at the connection lookup, so nothing
  // past the guard needs a real database.
  const resolveRef = vi.fn().mockRejectedValue(new Error('no such connection'));
  const executeMigration = vi.fn();
  const router = createMigrationRoutes({
    resolveRef,
    migrationModule: { executeMigration },
    migrationHistory: {} as never,
    connectionModule: {},
    sqlGenerator: {},
    captureLiveSchema: vi.fn(),
    normalizeTableSchemas: vi.fn(),
    gitMigrations: { read: vi.fn(), recordApplied: vi.fn(), commitRequired: vi.fn(), canSee: vi.fn() },
  });
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'some-user';
    authed.appRole = 'viewer';
    authed.permissions = new Set(permissions);
  });
  bindRoutes(app, router.flatten());
  await app.ready();
  return { server: app, resolveRef, executeMigration };
}

const execute = (server: FastifyInstance) =>
  server.inject({
    method: 'POST',
    url: '/migration/execute',
    payload: { connectionId: 'c1', steps: [{ sql: 'DROP TABLE orders' }] },
  });

describe('POST /migration/execute', () => {
  it('refuses an actor without schema.migrate before looking up the connection', async () => {
    // Everything short of migrating: browsing, comparing, running SQL.
    const { server, resolveRef, executeMigration } = await serve(['schema.browse', 'schema.compare', 'editor.run']);
    const res = await execute(server);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
    expect(resolveRef).not.toHaveBeenCalled();
    expect(executeMigration).not.toHaveBeenCalled();
  });

  it('lets an actor with schema.migrate past the guard', async () => {
    const { server, resolveRef } = await serve(['schema.migrate']);
    const res = await execute(server);

    expect(res.json().code).not.toBe('forbidden');
    expect(resolveRef).toHaveBeenCalledOnce();
  });
});
