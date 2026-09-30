/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Email me Fox news" when someone creates their account.
 *
 * The email goes to the same foxschema.com signup endpoint as the first-run
 * wizard (which notifies contact@foxschema.com), only when the person ticked
 * the box, only for a new account, and a failure there never costs anyone
 * their sign-up. Its own file: the reset limiter is per server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { AuthModule } from './auth.service';

let app: FastifyInstance;
let base = '';
let admin = '';
const auth = new AuthModule();

async function call(method: string, path: string, body?: unknown, cookie = '') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

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

describe('"Email me Fox news" on a new account', () => {
  let webhook: Server;
  const received: Array<{ email: string; source: string; secret?: string }> = [];

  beforeAll(async () => {
    // Stands in for foxschema.com's signup endpoint, which emails contact@foxschema.com.
    webhook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ ...JSON.parse(body), secret: req.headers['x-foxschema-signup-secret'] as string });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => webhook.listen(0, '127.0.0.1', r));
    process.env.SIGNUP_WEBHOOK_URL = `http://127.0.0.1:${(webhook.address() as { port: number }).port}/signup`;
    process.env.SIGNUP_WEBHOOK_SECRET = 'test-secret';
  });

  afterAll(async () => {
    delete process.env.SIGNUP_WEBHOOK_URL;
    delete process.env.SIGNUP_WEBHOOK_SECRET;
    await new Promise((r) => webhook.close(r));
  });

  const invite = async (email: string) =>
    (await call('POST', '/admin/users', { email, role: 'viewer' }, admin)).json.invite.code as string;
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it('subscribes an invited person who ticked it, and only them', async () => {
    const yes = await invite('opt-in@example.com');
    const no = await invite('opt-out@example.com');
    expect((await call('POST', '/auth/password/reset', { code: yes, password: 'amber-forest-8', subscribe: true })).status).toBe(200);
    expect((await call('POST', '/auth/password/reset', { code: no, password: 'amber-forest-8' })).status).toBe(200);
    await settle();
    expect(received).toEqual([{ email: 'opt-in@example.com', source: 'web', secret: 'test-secret' }]);
  });

  it('never subscribes on a password reset, which is not a sign-up', async () => {
    received.length = 0;
    const { code } = await auth.issueCode(
      (await auth.login('opt-out@example.com', 'amber-forest-8')).user.id,
      'reset'
    );
    expect((await call('POST', '/auth/password/reset', { code, password: 'amber-forest-9', subscribe: true })).status).toBe(200);
    await settle();
    expect(received).toEqual([]);
  });

  it('a signup service that is down does not stop the account being created', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'http://127.0.0.1:9/unreachable';
    const code = await invite('down@example.com');
    const res = await call('POST', '/auth/password/reset', { code, password: 'amber-forest-8', subscribe: true });
    expect(res.status).toBe(200);
    expect(res.cookie).toMatch(/^sid=/);
  });
});
