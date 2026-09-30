/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * First-run setup and account creation over HTTP, on a real listener.
 *
 * Setup makes whoever completes it the admin, so the protection is the point:
 * from anywhere but this machine it needs the code printed in the server log,
 * a proxy header never makes a request look local, it runs once, and after it
 * only an admin can let anyone else in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { setupCode } from './setup-code';

let app: FastifyInstance;
let base = '';

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any; cookie: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

/** Looks like it came through a reverse proxy on this host. */
const PROXIED = { 'x-forwarded-for': '203.0.113.7' };

beforeAll(async () => {
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('first-run setup over HTTP', () => {
  let adminCookie = '';

  it('nobody signed in is an answer, not an error', async () => {
    const me = await call('GET', '/auth/me');
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ user: null });
  });

  it('asks a proxied caller for the setup code, and not a local one', async () => {
    expect((await call('GET', '/auth/setup')).json).toMatchObject({
      setupRequired: true,
      setupCodeRequired: false,
    });
    expect((await call('GET', '/auth/setup', undefined, PROXIED)).json).toMatchObject({
      setupRequired: true,
      setupCodeRequired: true,
    });
  });

  it('refuses a proxied setup without the right code', async () => {
    const creds = { email: 'owner@example.com', password: 'blue-lantern-42' };
    expect((await call('POST', '/auth/setup', creds, PROXIED)).status).toBe(403);
    expect((await call('POST', '/auth/setup', { ...creds, code: 'AAAA-AAAA' }, PROXIED)).status).toBe(403);
  });

  it('accepts a proxied setup with the code from the log, once', async () => {
    const creds = { email: 'owner@example.com', password: 'blue-lantern-42', code: setupCode().toLowerCase() };
    const done = await call('POST', '/auth/setup', creds, PROXIED);
    expect(done.status).toBe(200);
    expect(done.json.user.role).toBe('admin');
    adminCookie = done.cookie;

    const again = await call('POST', '/auth/setup', { email: 'late@example.com', password: 'late-pass-11' });
    expect(again.status).toBe(409);
    expect((await call('GET', '/auth/setup')).json.setupRequired).toBe(false);
  });

  it('keeps self-registration closed', async () => {
    const res = await call('POST', '/auth/register', { email: 'walk-in@example.com', password: 'walk-in-pass' });
    expect(res.status).toBe(403);
  });

  it('lets an admin add an account that can then sign in, and nobody else add one', async () => {
    const added = await call(
      'POST',
      '/admin/users',
      { email: 'teammate@example.com', password: 'green-river-17', role: 'viewer' },
      { cookie: adminCookie }
    );
    expect(added.status).toBe(200);
    expect(added.json.user.role).toBe('viewer');

    const login = await call('POST', '/auth/login', { email: 'teammate@example.com', password: 'green-river-17' });
    expect(login.status).toBe(200);

    const byViewer = await call(
      'POST',
      '/admin/users',
      { email: 'another@example.com', password: 'another-pass', role: 'admin' },
      { cookie: login.cookie }
    );
    expect(byViewer.status).toBe(403);
    expect((await call('POST', '/admin/users', { email: 'x@example.com', password: 'xxxxxxxx' })).status).toBe(401);
  });
});
