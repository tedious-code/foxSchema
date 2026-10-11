/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * App info records the active metadata database and key scheme as it answers,
 * and a failure to record never fails the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRequest } from '../../platform/http/types';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import type { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { createSystemRoutes } from './system.routes';

function appInfo(settings: Pick<AppSettingsStore, 'set'>) {
  const handler = routeHandler(createSystemRoutes(settings as AppSettingsStore), 'GET', '/app-info');
  const { reply, sent } = fakeReply();
  return { run: () => handler({} as AppRequest, reply), body: () => sent.body as { db: { engine: string } } };
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
