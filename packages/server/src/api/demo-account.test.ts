/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A demo account against a real server.
 *
 * Its login is public, so whatever it may write, every visitor shares. These
 * tests ask the server that ships, over a socket, the way `http-contract.test.ts`
 * does: a guard wired to the wrong mount passes every unit test and still
 * lets the demo save connections.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { getStore } from '../database/store';
import { READ_ONLY_ACCOUNT as DEMO_READ_ONLY } from '../platform/authorization/read-only';
import { FEATURES, createFeatureContext } from '../app/feature-registry';

let port = 0;
let app: FastifyInstance;
let admin = '';
let demo = '';
let demoId = '';
let viewer = '';

/** Every route the features mount, with its mount's access, built once. */
let routeTable: Array<{ method: string; path: string; access: string; reads: boolean }> | null = null;
function mountedRoutes() {
  if (!routeTable) {
    const ctx = createFeatureContext();
    routeTable = FEATURES.flatMap((f) => f.mounts).flatMap((m) =>
      m.routes(ctx).flatten(m.prefix).map((r) => ({ method: r.method, path: r.path, access: m.access, reads: r.reads === true }))
    );
  }
  return routeTable;
}

/**
 * The writes declared to only read (`reads` beside their handler). A read-only
 * account (the Demo role) may call exactly these: adding one here is a review
 * of whether it really changes nothing a visitor would share.
 */
const REVIEWED_READS = [
  'POST /api/compare',
  'POST /api/schema/db-access',
  'POST /api/schema/list',
  'POST /api/schema/load',
  'POST /api/schema/table-insight',
  'POST /api/sql/code-cell/transpile',
  'POST /api/sql/execute',
  'POST /api/workspaces/:id/select',
  'PUT /api/user/preferences',
];

const DEMO_EMAIL = 'demo-visitor@example.com';
const DEMO_PASSWORD = 'shared-demo-login-9';

async function call(method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    redirect: 'manual',
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

beforeAll(async () => {
  const { createFastifyApp } = await import('./fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;

  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo-admin@example.com', password: 'correct-horse-staple-9' }),
  });
  expect(setup.status, await setup.clone().text()).toBe(200);
  admin = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;

  const made = await call('POST', '/admin/users', admin, { email: DEMO_EMAIL, password: DEMO_PASSWORD, role: 'demo' });
  expect(made.status, made.text).toBe(200);
  demoId = made.json.user.id;
  demo = await login(DEMO_EMAIL, DEMO_PASSWORD);

  const v = await call('POST', '/admin/users', admin, { email: 'demo-viewer@example.com', password: 'viewer-pass-12', role: 'viewer' });
  expect(v.status, v.text).toBe(200);
  viewer = await login('demo-viewer@example.com', 'viewer-pass-12');
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('a demo account', () => {
  it('has the Demo role’s permissions, and no more in a workspace that made it an owner', async () => {
    const me = (await call('GET', '/auth/me', demo)).json;
    expect(me.user.role).toBe('demo');
    expect([...me.user.permissions].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.demo].sort());

    // An admin makes the shared demo login an owner somewhere. Every visitor
    // would get an owner's keys there; it still acts as Demo.
    const ws = (await call('POST', '/workspaces', admin, { name: 'Demo data' })).json.workspace;
    expect((await call('PUT', `/workspaces/${ws.id}/members/${demoId}`, admin, { role: 'owner' })).status).toBe(200);
    const there = (await call('GET', '/auth/me', demo, undefined, { 'x-fox-workspace': ws.id })).json;
    // It acts as a viewer there, so every service that reads its role sees one.
    expect(there.workspace).toMatchObject({ id: ws.id, role: 'viewer' });
    for (const p of ['editor.dml', 'editor.ddl', 'editor.grant', 'schema.migrate', 'workspace.members', 'secrets.view']) {
      expect(there.user.permissions, p).not.toContain(p);
    }
    expect(there.user.permissions).toContain('editor.run');
    // The pending invites (other people's emails) and script writing stay closed.
    expect((await call('GET', `/workspaces/${ws.id}/invites`, demo)).status).toBe(403);
    expect((await call('GET', '/workspaces/scripts', demo, undefined, { 'x-fox-workspace': ws.id })).json.canWrite).toBe(false);
    // Nor does it run its own workspace's members.
    const own = (await call('GET', '/workspaces', demo)).json.workspaces.find((w: { personal: boolean }) => w.personal);
    expect((await call('GET', `/workspaces/${own.id}/invites`, demo)).status).toBe(403);
  });

  it('is refused every write behind sign-in except the few that read — before the route runs', async () => {
    const guarded = mountedRoutes().filter((r) => (r.access === 'user' || r.access === 'registered') && r.method !== 'GET');
    expect(guarded.length).toBeGreaterThan(50);
    const allowed = new Set(guarded.filter((r) => r.reads).map((r) => `${r.method} ${r.path}`));

    const wrong: string[] = [];
    for (const route of guarded) {
      const key = `${route.method} ${route.path}`;
      const path = route.path.replace(/^\/api/, '').replace(/:(\w+)/g, '00000000-0000-0000-0000-000000000000');
      const { status, json } = await call(route.method, path, demo, {});
      const refusedAsDemo = status === 403 && json?.error === DEMO_READ_ONLY;
      if (allowed.has(key) === refusedAsDemo) wrong.push(`${key} → ${status} ${json?.error ?? ''}`);
    }
    expect(wrong, 'allow-listed routes must pass the guard; every other write must be refused').toEqual([]);
  }, 120_000);

  it('declares reads on exactly the reviewed writes — a new one is a deliberate change here', () => {
    const declared = mountedRoutes()
      .filter((r) => r.reads && r.method !== 'GET')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(declared).toEqual(REVIEWED_READS);
  });

  it('runs the reads it is allowed: the guard lets them through to their own checks', async () => {
    // An empty request reaches the route and is refused for its input, not for being a demo.
    const run = await call('POST', '/sql/execute', demo, {});
    expect(run.status).toBe(400);
    expect(run.json.error).not.toBe(DEMO_READ_ONLY);
    expect((await call('PUT', '/user/preferences', demo, { onboardingCompleted: true })).status).toBe(200);
    expect((await call('GET', '/connections', demo)).status).toBe(200);
    // And it switches between the workspaces it is in.
    const own = (await call('GET', '/workspaces', demo)).json.workspaces.find((w: { personal: boolean }) => w.personal);
    expect((await call('POST', `/workspaces/${own.id}/select`, demo, {})).status).toBe(200);
  });

  it('cannot sign the other visitors out', async () => {
    const otherVisitor = await login(DEMO_EMAIL, DEMO_PASSWORD);
    const res = await call('POST', '/auth/sign-out-others', demo, {});
    expect(res.status).toBe(403);
    expect(res.json.error).toBe(DEMO_READ_ONLY);
    expect((await call('GET', '/auth/me', otherVisitor)).json.user?.email).toBe(DEMO_EMAIL);
    // Everyone else still can.
    expect((await call('POST', '/auth/sign-out-others', viewer, {})).status).toBe(200);
  });

  it('cannot have verification mail sent to its address by a visitor', async () => {
    const res = await call('POST', '/auth/verify/send', demo, {});
    expect(res.status).toBe(403);
    expect(res.json.error).toBe(DEMO_READ_ONLY);
  });

  it('cannot have its password reset by a visitor: forgot sends nothing for it', async () => {
    const store = await getStore();
    const codes = async (email: string) =>
      Number(
        (
          await store.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM auth_codes c JOIN users u ON u.id = c.user_id WHERE u.email = ? AND c.purpose = 'reset'`,
            [email]
          )
        )?.n ?? 0
      );
    // The reply is the same either way; the code is issued after it.
    expect((await call('POST', '/auth/password/forgot', '', { email: 'demo-viewer@example.com' })).status).toBe(200);
    expect((await call('POST', '/auth/password/forgot', '', { email: DEMO_EMAIL })).status).toBe(200);
    await expect.poll(() => codes('demo-viewer@example.com'), { timeout: 5_000 }).toBe(1);
    expect(await codes(DEMO_EMAIL)).toBe(0);
  });
});

describe('demo mode', () => {
  it('shows the sign-in page its hint only while on, and only an admin sets it', async () => {
    expect((await call('GET', '/auth/setup', '')).json.demo).toEqual({ on: false });

    const hint = `Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`;
    const saved = await call('PUT', '/admin/sign-in/demo', admin, { on: true, hint });
    expect(saved.status, saved.text).toBe(200);
    expect((await call('GET', '/auth/setup', '')).json.demo).toEqual({ on: true, hint });

    expect((await call('PUT', '/admin/sign-in/demo', demo, { on: false })).status).toBe(403);
    expect((await call('PUT', '/admin/sign-in/demo', viewer, { on: false })).status).toBe(403);
    expect((await call('PUT', '/admin/sign-in/demo', admin, { hint: 'x'.repeat(301) })).status).toBe(400);
    expect((await call('PUT', '/admin/sign-in/demo', admin, { on: 'yes' })).status).toBe(400);

    // Off again: the hint is kept for next time, and not shown.
    expect((await call('PUT', '/admin/sign-in/demo', admin, { on: false })).status).toBe(200);
    expect((await call('GET', '/auth/setup', '')).json.demo).toEqual({ on: false });
    expect((await call('GET', '/admin/sign-in', admin)).json.demo).toEqual({ on: false, hint });
  });
});
