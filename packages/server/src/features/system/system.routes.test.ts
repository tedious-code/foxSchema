/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * App info records the active metadata database and key scheme as it answers,
 * and a failure to record never fails the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import type { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { createSystemRoutes } from './system.routes';

function appInfo(settings: Pick<AppSettingsStore, 'set'>) {
  const route = createSystemRoutes(settings as AppSettingsStore)
    .flatten()
    .find((r) => r.method === 'GET' && r.path === '/app-info');
  if (!route) throw new Error('GET /app-info is not registered');
  let body: unknown;
  const reply = { send: (b: unknown) => ((body = b), reply) } as unknown as FastifyReply;
  return { run: () => route.handler({} as AppRequest, reply), body: () => body as { db: { engine: string } } };
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('GET /app-info', () => {
  it('records the metadata engine, its path and the key scheme', async () => {
    process.env.APP_DB_ENGINE = 'sqlite';
    process.env.APP_DB_PATH = '/tmp/fox-meta.db';
    const set = vi.fn(async (_key: string, _value: string) => undefined);
    const call = appInfo({ set });
    await call.run();
    expect(Object.fromEntries(set.mock.calls.map(([k, v]) => [k, v]))).toMatchObject({
      'db.engine': 'sqlite',
      'db.path': '/tmp/fox-meta.db',
    });
    expect(set.mock.calls.map(([k]) => k)).toContain('key.scheme');
    expect(call.body().db.engine).toBe('sqlite');
  });

  it('still answers when recording fails', async () => {
    const call = appInfo({ set: async () => Promise.reject(new Error('read-only database')) });
    await call.run();
    expect(call.body().db).toBeTruthy();
  });
});
