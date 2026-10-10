/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A request with no body must not claim a JSON one.
 *
 * Fastify refuses `Content-Type: application/json` with an empty body before
 * any route runs (400 FST_ERR_CTP_EMPTY_JSON_BODY). `authApi` and
 * `migrationApi` each had a private fetch wrapper that always set that header,
 * so under Fastify four actions failed while the UI carried on as if they had
 * worked:
 *   - sign-out cleared only the browser state; a reload signed back in
 *   - deleting a saved connection did nothing
 *   - deleting a migration run, or clearing the history, hid the rows until the
 *     panel reopened
 * Both now go through the shared client, which sets the header only when there
 * is a body. The migration cases are in `features/migrations/api/migrationApi.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { apiDeleteConnection, apiLogout } from './authApi';

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

function contentType(init: RequestInit): string | undefined {
  const headers = new Headers(init.headers);
  return headers.get('content-type') ?? undefined;
}

describe('bodyless requests send no JSON content type', () => {
  it.each([
    ['sign out', () => apiLogout(), 'POST'],
    ['delete a saved connection', () => apiDeleteConnection('c1'), 'DELETE'],
  ])('%s', async (_label, send, method) => {
    const calls = captureRequests();
    await send();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe(method);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(contentType(calls[0]!.init)).toBeUndefined();
    expect(calls[0]!.init.credentials).toBe('include');
  });
});
