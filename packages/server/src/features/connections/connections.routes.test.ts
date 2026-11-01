/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The connection name rule, applied where a name is saved. It is the same
 * rule as the credential form's (checkConnectionName).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStore } from '../../platform/connections/connection-store.service';
import type { AuthedRequest } from '../../platform/http/types';
import { fakeReply } from '../../platform/http/route-doubles';
import { createConnectionStoreRoutes } from './connections.routes';

function setup() {
  const store = {
    create: vi.fn(async (_scope: unknown, input: { name?: string }) => ({ id: 'c1', name: input.name ?? '' })),
    update: vi.fn(async (_scope: unknown, id: string, input: { name?: string }) => ({ id, name: input.name ?? '' })),
  };
  const routes = createConnectionStoreRoutes(store as unknown as ConnectionStore).flatten();
  const call = async (method: 'POST' | 'PUT', name: unknown) => {
    const route = routes.find((r) => r.method === method && r.path === (method === 'POST' ? '/' : '/:id'))!;
    const { reply, sent } = fakeReply();
    const req = {
      userId: 'u1',
      workspaceId: 'w1',
      params: { id: 'c1' },
      body: { name, dialect: 'postgres', option: { host: '127.0.0.1' } },
    } as unknown as AuthedRequest;
    await route.handler(req, reply);
    return sent;
  };
  return { store, call };
}

describe('saving a connection name', () => {
  it.each(['POST', 'PUT'] as const)('keeps a name the app itself makes, trimmed (%s)', async (method) => {
    const { store, call } = setup();
    await call(method, '  127.0.0.1/foxdb  ');
    const saved = method === 'POST' ? store.create.mock.calls[0]![1] : store.update.mock.calls[0]![2];
    expect(saved.name).toBe('127.0.0.1/foxdb');
  });

  it.each(['POST', 'PUT'] as const)('refuses a name with a control character, saving nothing (%s)', async (method) => {
    const { store, call } = setup();
    const sent = await call(method, 'Prod\nDB');
    expect(sent.status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('refuses a name over the limit', async () => {
    const { call } = setup();
    expect((await call('POST', 'x'.repeat(121))).status).toBe(400);
  });
});
