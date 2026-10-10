/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deleting a migration run, or clearing the history, sends no body, so it must
 * not claim a JSON one: Fastify refuses that before any route runs, and the
 * rows only looked deleted until the panel reopened. The other bodyless
 * requests are covered in `shared/api/bodyless-requests.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { apiClearMigrations, apiDeleteMigration } from './migrationApi';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureRequests() {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, statusText: '', text: async () => '{"ok":true,"removed":0}' } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

describe('migration deletes send no JSON content type', () => {
  it.each([
    ['delete a migration run', () => apiDeleteMigration('r1')],
    ['clear migration history', () => apiClearMigrations()],
  ])('%s', async (_label, send) => {
    const calls = captureRequests();
    await send();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBeNull();
    expect(calls[0]!.init.credentials).toBe('include');
  });
});
