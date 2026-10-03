/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forgot password, invites, lockout and sign-in settings over HTTP, on a real
 * listener. The replies must not say which emails have accounts, a code must
 * reach the person (or the admin who asked for it), and the settings screen
 * must never hand a secret back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { AuthModule } from './auth.service';
import { MAX_FAILURES } from './sign-in-throttle';
import { DEFAULT_TRUST_PROXY, trustProxySetting } from '../../api/fastify-server';

let app: FastifyInstance;
let base = '';
const auth = new AuthModule();

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie = ''
): Promise<{ status: number; json: any; cookie: string; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, headers: res.headers };
}

let admin = '';

beforeAll(async () => {
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  admin = (await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' })).cookie;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('forgot password over HTTP', () => {
  it('answers the same for an email with an account and one without', async () => {
    const known = await call('POST', '/auth/password/forgot', { email: 'boss@example.com' });
    const unknown = await call('POST', '/auth/password/forgot', { email: 'nobody@example.com' });
    expect(known.status).toBe(200);
    expect(known.json).toEqual(unknown.json);
    expect(known.json).toEqual({ ok: true, delivery: 'log' });
  });

  it('redeems a code: the page learns whose it is, then a new password signs in', async () => {
    const { code } = await auth.issueCode(
      (await auth.login('boss@example.com', 'blue-lantern-42')).user.id,
      'reset'
    );
    expect((await call('POST', '/auth/password/code', { code: 'WRONG-CODE-0000' })).status).toBe(404);
    expect((await call('POST', '/auth/password/code', { code })).json).toEqual({
      email: 'boss@example.com',
      purpose: 'reset',
    });
    const weak = await call('POST', '/auth/password/reset', { code, password: 'password123' });
    expect(weak.status).toBe(400);
    const done = await call('POST', '/auth/password/reset', { code, password: 'green-river-17' });
    expect(done.status).toBe(200);
    expect(done.cookie).toMatch(/^sid=/);
    expect((await call('GET', '/auth/me', undefined, done.cookie)).json.user.email).toBe('boss@example.com');
    // The admin's earlier session ended with the reset.
    expect((await call('GET', '/auth/me', undefined, admin)).json.user).toBeNull();
    admin = done.cookie;
  });
});

describe('sign-in lockout over HTTP', () => {
  it('answers 429 with Retry-After once an email has failed too often', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await call('POST', '/auth/login', { email: 'target@example.com', password: 'guess-guess-1' })).status).toBe(401);
    }
    const locked = await call('POST', '/auth/login', { email: 'target@example.com', password: 'guess-guess-1' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('signing out other sessions over HTTP', () => {
  it('needs a session, and ends only the others', async () => {
    expect((await call('POST', '/auth/sign-out-others')).status).toBe(401);
    await auth.createUser('ned@example.com', 'amber-forest-8', 'viewer');
    const first = (await call('POST', '/auth/login', { email: 'ned@example.com', password: 'amber-forest-8' })).cookie;
    const second = (await call('POST', '/auth/login', { email: 'ned@example.com', password: 'amber-forest-8' })).cookie;
    const res = await call('POST', '/auth/sign-out-others', undefined, second);
    expect(res.status).toBe(200);
    expect(res.json.signedOut).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/auth/me', undefined, first)).json.user).toBeNull();
    expect((await call('GET', '/auth/me', undefined, second)).json.user).toMatchObject({ email: 'ned@example.com' });
  });
});

describe('a malformed session cookie', () => {
  it('reads as signed out, not as a server error', async () => {
    const bad = 'sid=%E0%A4%A';
    expect(await call('GET', '/auth/me', undefined, bad)).toMatchObject({ status: 200, json: { user: null } });
    expect((await call('GET', '/connections', undefined, bad)).status).toBe(401);
  });
});

describe('invites over HTTP', () => {
  it('an admin invites without a password; the code signs the person up once', async () => {
    const invited = await call('POST', '/admin/users', { email: 'new@example.com', role: 'viewer' }, admin);
    expect(invited.status).toBe(200);
    expect(invited.json.invite).toMatchObject({ delivery: 'log', link: '' });
    const code = invited.json.invite.code as string;

    const users = (await call('GET', '/admin/users', undefined, admin)).json.users as any[];
    expect(users.find((u) => u.email === 'new@example.com')).toMatchObject({ passwordSet: false });

    expect((await call('POST', '/auth/password/code', { code })).json).toEqual({
      email: 'new@example.com',
      purpose: 'invite',
    });
    expect((await call('POST', '/auth/password/reset', { code, password: 'amber-forest-8' })).status).toBe(200);
    expect((await call('POST', '/auth/password/reset', { code, password: 'amber-forest-9' })).status).toBe(400);
    expect((await call('POST', '/auth/login', { email: 'new@example.com', password: 'amber-forest-8' })).status).toBe(200);
  });

  it('an admin can issue a fresh code: a reset once the person has a password', async () => {
    const users = (await call('GET', '/admin/users', undefined, admin)).json.users as any[];
    const id = users.find((u) => u.email === 'new@example.com').id;
    const res = await call('POST', `/admin/users/${id}/code`, {}, admin);
    expect(res.json).toMatchObject({ purpose: 'reset', delivery: 'log' });

    const viewer = (await call('POST', '/auth/login', { email: 'new@example.com', password: 'amber-forest-8' })).cookie;
    expect((await call('POST', `/admin/users/${id}/code`, {}, viewer)).status).toBe(403);
    expect((await call('POST', '/admin/users', { email: 'x@example.com' }, viewer)).status).toBe(403);
  });
});

describe('sign-in settings over HTTP', () => {
  it('saves a provider for admins only and never returns its secret', async () => {
    const put = await call('PUT', '/admin/sign-in/providers/github', { clientId: 'gh', clientSecret: 'shh-secret' }, admin);
    expect(put.status).toBe(200);
    const got = await call('GET', '/admin/sign-in', undefined, admin);
    const github = got.json.providers.find((p: any) => p.id === 'github');
    expect(github).toMatchObject({ configured: true, source: 'app', hasSecret: true, clientId: 'gh' });
    expect(github.redirectUri).toMatch(/\/api\/auth\/sso\/github\/callback$/);
    expect(JSON.stringify(got.json)).not.toContain('shh-secret');

    expect((await call('GET', '/auth/sso/providers')).json.providers).toEqual([{ id: 'github', label: 'GitHub' }]);

    // Through a proxy (the Vite dev server), the provider must send people
    // back to the page they came from, not to the API's own port.
    const start = await fetch(`${base}/auth/sso/github/start`, {
      redirect: 'manual',
      headers: { 'x-forwarded-host': 'localhost:5199', 'x-forwarded-proto': 'http' },
    });
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:5199/api/auth/sso/github/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await call('GET', '/admin/sign-in')).status).toBe(401);
  });
});

describe('trusted proxies', () => {
  it('believes forwarding headers only from this machine and private networks by default', () => {
    expect(trustProxySetting(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(DEFAULT_TRUST_PROXY).not.toBe(true);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
