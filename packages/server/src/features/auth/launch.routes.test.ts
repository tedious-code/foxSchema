/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Using Fox before creating an account, then creating it and verifying the
 * email, over HTTP on a real listener.
 *
 * The launch link is a way in without a password, so its limits are the
 * point: it works once, briefly, only from this machine and only on a
 * personal install that nobody else can reach; it never lets anyone decide
 * who else gets in; it stops at the end of the grace period; and it ends for
 * good once the owner has an account. The verification code that follows
 * proves the address and does nothing else.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { AuthModule } from './auth.service';
import { AppSettingsStore } from '../admin/app-settings.service';
import { getStore } from '../../database/store';

let app: FastifyInstance;
let base = '';

/** What the Fox mail service was asked to send. */
const mailed: Array<{ email: string; code: string; expiresAt: string }> = [];
let mailService: http.Server;
let mailStatus = 202;
let previousMailUrl: string | undefined;

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
const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, ...extra });
const DAY_MS = 24 * 60 * 60 * 1000;

async function waitForMail(count: number): Promise<void> {
  for (let i = 0; i < 100 && mailed.length < count; i++) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(async () => {
  mailService = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (mailStatus < 300) mailed.push(JSON.parse(raw));
      res.statusCode = mailStatus;
      res.end();
    });
  });
  await new Promise<void>((r) => mailService.listen(0, '127.0.0.1', r));
  previousMailUrl = process.env.FOX_VERIFY_MAIL_URL;
  process.env.FOX_VERIFY_MAIL_URL = `http://127.0.0.1:${(mailService.address() as { port: number }).port}/verify-email`;

  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => mailService?.close(r));
  if (previousMailUrl === undefined) delete process.env.FOX_VERIFY_MAIL_URL;
  else process.env.FOX_VERIFY_MAIL_URL = previousMailUrl;
});

describe('using Fox before creating an account', () => {
  const auth = new AuthModule();
  let launchCookie = '';

  it('refuses a launch link on a shared server, or on a personal install open to the network', async () => {
    const token = (await auth.issueLaunchToken())!;
    expect(token).toBeTruthy();

    process.env.LOCAL_SINGLE_USER = 'false';
    expect((await call('POST', '/auth/launch', { token })).status).toBe(403);
    delete process.env.LOCAL_SINGLE_USER;

    process.env.LISTEN_HOST = '0.0.0.0';
    expect((await call('POST', '/auth/launch', { token })).status).toBe(403);
    delete process.env.LISTEN_HOST;
  });

  it('takes a launch link only from this machine, only once, and only while it is fresh', async () => {
    const token = (await auth.issueLaunchToken())!;
    // Through a proxy it is not this machine, whatever the socket says.
    expect((await call('POST', '/auth/launch', { token }, PROXIED)).status).toBe(403);

    const opened = await call('POST', '/auth/launch', { token });
    expect(opened.status).toBe(200);
    expect(opened.cookie).toMatch(/^sid=/);
    launchCookie = opened.cookie;
    expect((await call('POST', '/auth/launch', { token })).status).toBe(401);

    const stale = (await auth.issueLaunchToken())!;
    const store = await getStore();
    await store.run("UPDATE auth_codes SET expires_at = ? WHERE purpose = 'launch' AND used_at IS NULL", [
      new Date(Date.now() - 1000).toISOString(),
    ]);
    expect((await call('POST', '/auth/launch', { token: stale })).status).toBe(401);
    expect((await call('POST', '/auth/launch', { token: 'made-up' })).status).toBe(401);
  });

  it('says it is a launch session, and when the account is due', async () => {
    const me = await call('GET', '/auth/me', undefined, withCookie(launchCookie));
    expect(me.json.launch).toBe(true);
    expect(me.json.registration.required).toBe(false);
    const due = Date.parse(me.json.registration.dueAt) - Date.now();
    expect(due).toBeGreaterThan(6 * DAY_MS);
    expect(due).toBeLessThanOrEqual(7 * DAY_MS);
    // Still no account anyone can sign in with.
    expect((await call('GET', '/auth/setup')).json.setupRequired).toBe(true);
  });

  it('uses the app, but never decides who else gets in', async () => {
    expect((await call('GET', '/connections', undefined, withCookie(launchCookie))).status).toBe(200);

    const users = await call('GET', '/admin/users', undefined, withCookie(launchCookie));
    expect(users.status).toBe(403);
    expect(users.json.error).toMatch(/Create your account first/);
    const addUser = await call('POST', '/admin/users', { email: 'x@example.com', role: 'viewer' }, withCookie(launchCookie));
    expect(addUser.status).toBe(403);
    const sso = await call('PUT', '/admin/sign-in/public-url', { url: 'https://fox.example.com' }, withCookie(launchCookie));
    expect(sso.status).toBe(403);
  });

  it('stops at the end of the grace period: the account comes first', async () => {
    const settings = new AppSettingsStore();
    const started = (await settings.get('auth.launch.first_used_at'))!;
    await settings.set('auth.launch.first_used_at', new Date(Date.now() - 8 * DAY_MS).toISOString());
    try {
      const blocked = await call('GET', '/connections', undefined, withCookie(launchCookie));
      expect(blocked.status).toBe(403);
      expect(blocked.json.error).toMatch(/Create your account to keep using Fox/);
      expect((await call('GET', '/auth/me', undefined, withCookie(launchCookie))).json.registration.required).toBe(true);
      expect(await auth.issueLaunchToken()).toBeNull();
    } finally {
      await settings.set('auth.launch.first_used_at', started);
    }
  });
});

describe('creating the account, and verifying the email', () => {
  const auth = new AuthModule();
  let launchCookie = '';
  let accountCookie = '';

  beforeAll(async () => {
    const token = (await auth.issueLaunchToken())!;
    launchCookie = (await call('POST', '/auth/launch', { token })).cookie;
  });

  it('needs no setup code from the launch session, and ends it', async () => {
    // Never shown to a launch session; the account form offers Fox news instead.
    expect((await call('GET', '/signup/state')).json).toEqual({ shown: false });
    // Proxied, so neither "this machine" nor a setup code is what lets it through.
    const created = await call(
      'POST',
      '/auth/setup',
      { email: 'owner@example.com', password: 'blue-lantern-42' },
      withCookie(launchCookie, PROXIED)
    );
    expect(created.status).toBe(200);
    accountCookie = created.cookie;

    expect((await call('GET', '/auth/me', undefined, withCookie(launchCookie))).json).toEqual({ user: null });
    expect(await auth.issueLaunchToken()).toBeNull();
    // ...so the next load does not ask about Fox news a second time.
    await vi.waitFor(async () => expect((await call('GET', '/signup/state')).json).toEqual({ shown: true }));
  });

  it('emails a verification code through the Fox mail service when the install has no mail server', async () => {
    await waitForMail(1);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]).toMatchObject({ email: 'owner@example.com' });
    expect(mailed[0]!.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const me = await call('GET', '/auth/me', undefined, withCookie(accountCookie));
    expect(me.json).toMatchObject({ launch: false, registration: null, emailVerification: { verified: false } });
  });

  it('takes the right code and nothing else, and the code never sets a password', async () => {
    const code = mailed[0]!.code;
    expect((await call('POST', '/auth/password/reset', { code, password: 'another-pass-99' })).status).toBe(400);
    expect((await call('POST', '/auth/verify', { code: 'AAAA-BBBB-CCCC' }, withCookie(accountCookie))).status).toBe(400);
    expect((await call('POST', '/auth/verify', { code })).status).toBe(401);

    expect((await call('POST', '/auth/verify', { code }, withCookie(accountCookie))).status).toBe(200);
    expect((await call('GET', '/auth/me', undefined, withCookie(accountCookie))).json.emailVerification).toEqual({
      verified: true,
    });
    // Used once.
    expect((await call('POST', '/auth/verify', { code }, withCookie(accountCookie))).status).toBe(400);
    expect((await call('POST', '/auth/verify/send', {}, withCookie(accountCookie))).json).toMatchObject({ verified: true });
  });

  it('says so when the code cannot be sent', async () => {
    const store = await getStore();
    await store.run('UPDATE users SET email_verified_at = NULL WHERE email = ?', ['owner@example.com']);
    mailStatus = 503;
    const failed = await call('POST', '/auth/verify/send', {}, withCookie(accountCookie));
    expect(failed.status).toBe(503);
    expect(failed.json.error).toMatch(/could not send it \(503\)/);

    process.env.FOX_VERIFY_MAIL_URL = 'off';
    const off = await call('POST', '/auth/verify/send', {}, withCookie(accountCookie));
    expect(off.status).toBe(503);
    expect(off.json.error).toMatch(/turned off/);
  });
});
