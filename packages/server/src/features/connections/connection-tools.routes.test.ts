/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who may install a driver. Checking one is for everyone signed in — the SQL
 * editor asks on every failed run — but installing runs npm on the server.
 */
import { describe, expect, it } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { ConnectionModule } from '@foxschema/db';
import type { AuthedRequest, Middleware } from '../../platform/http/types';
import { fakeReply } from '../../platform/http/route-doubles';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import { createConnectionToolRoutes } from './connection-tools.routes';

const routes = createConnectionToolRoutes({
  connectionModule: {} as ConnectionModule,
  resolveRef: (async () => {
    throw new Error('not used');
  }) as unknown as ConnectionResolver['resolveRef'],
}).flatten();

const route = (method: string, path: string) => {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`${method} ${path} is not registered`);
  return found;
};

/** What a route's guards answer `caller`, or 'passed' when they let it through. */
async function guardsAnswer(middlewares: unknown[], caller: Partial<AuthedRequest>) {
  const { reply, sent } = fakeReply();
  for (const middleware of middlewares as Middleware[]) {
    let passed = false;
    await middleware(caller as AuthedRequest, reply, () => (passed = true));
    if (!passed) return sent;
  }
  return 'passed' as const;
}

const caller = (appRole: 'viewer' | 'editor' | 'owner' | 'admin', permissions: Permission[] = []) => ({
  userId: `${appRole}-1`,
  appRole,
  permissions: new Set<Permission>(permissions),
});

describe('driver routes', () => {
  it('refuses an install from an account without admin.drivers, whatever its workspace role', async () => {
    const install = route('POST', '/driver/install');
    for (const role of ['viewer', 'editor', 'owner'] as const) {
      const sent = await guardsAnswer(install.middlewares, caller(role, ['editor.run', 'editor.ddl', 'workspace.settings']));
      expect(sent, role).not.toBe('passed');
      if (sent === 'passed') continue;
      expect(sent.status, role).toBe(403);
      expect(sent.body.missing, role).toEqual(['admin.drivers']);
    }
  });

  it('lets an admin install, and an account granted admin.drivers', async () => {
    const install = route('POST', '/driver/install');
    expect(await guardsAnswer(install.middlewares, caller('admin'))).toBe('passed');
    expect(await guardsAnswer(install.middlewares, caller('editor', ['admin.drivers']))).toBe('passed');
  });

  it('leaves checking a driver open to everyone signed in', async () => {
    const check = route('GET', '/driver/check');
    expect(await guardsAnswer(check.middlewares, caller('viewer'))).toBe('passed');
  });
});
