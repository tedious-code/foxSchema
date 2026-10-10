/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The HTTP contract: what every route answers, asserted against a real server.
 *
 * This exists because the Express-to-Fastify migration rewrites the transport
 * under 80 routes whose logic does not change — precisely the edit unit tests
 * cannot see. This codebase has already produced the proof: a route that passed
 * typecheck and the whole suite hung forever in production, because middleware
 * was wired wrong. Only a live request found it.
 *
 * Two design decisions worth keeping:
 *
 * **A real listener, not `app.inject()`.** The obvious harness is Fastify's
 * inject, and it is wrong here: routes still served through the `@fastify/express`
 * bridge get a synthetic req/res that Express cannot write to, so every POST
 * comes back 500 with an empty body while the same request over a socket
 * answers 400 correctly. A harness that reports false failures is worse than
 * none — it trains you to ignore it.
 *
 * **The table is the Express baseline.** Every expectation below was recorded
 * from the Express server before it was removed, so this suite still asserts
 * "nothing changed when the server swapped" — it is the only thing that does.
 *
 * The expectations are what the API does today, captured deliberately: this is
 * a regression net, not a wish list. It started with two shrinking allow-lists
 * for behaviour that was wrong — 6 routes answering 500 to an empty body, and
 * 50 of 51 error responses with no machine-readable code. Both reached zero, so
 * both assertions are now unconditional.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Its own metadata DB. It used to fall through to the developer's dev
// database and write preferences and signup state into it.
process.env.APP_DB_PATH = ':memory:';
import { isApiErrorBody } from '@foxschema/shared';

interface RouteExpectation {
  method: string;
  path: string;
  /** Status for a request with no meaningful input — an empty JSON body. */
  status: number;
}

/**
 * Every route the API serves, with what it answers to an empty request.
 *
 * A placeholder UUID is substituted for `:params`, so "not found" is the
 * expected answer for anything that looks a record up — that is the point:
 * a *reachable* route that cannot find a record, rather than a crash.
 */
const ROUTES: RouteExpectation[] = [
  { method: 'GET', path: '/api/activity', status: 200 },
  { method: 'GET', path: '/api/admin/role-permissions', status: 200 },
  { method: 'PUT', path: '/api/admin/role-permissions/:role', status: 400 },
  { method: 'GET', path: '/api/admin/sign-in', status: 200 },
  { method: 'PUT', path: '/api/admin/sign-in/broker', status: 400 },
  { method: 'DELETE', path: '/api/admin/sign-in/mail', status: 200 },
  { method: 'PUT', path: '/api/admin/sign-in/mail', status: 400 },
  { method: 'POST', path: '/api/admin/sign-in/mail/test', status: 400 },
  { method: 'DELETE', path: '/api/admin/sign-in/providers/:id', status: 404 },
  { method: 'PUT', path: '/api/admin/sign-in/providers/:id', status: 404 },
  { method: 'PUT', path: '/api/admin/sign-in/public-url', status: 200 },
  { method: 'GET', path: '/api/admin/policy', status: 200 },
  { method: 'PUT', path: '/api/admin/policy', status: 400 },
  { method: 'GET', path: '/api/admin/users', status: 200 },
  { method: 'POST', path: '/api/admin/users', status: 400 },
  { method: 'PUT', path: '/api/admin/users/:id/active', status: 400 },
  { method: 'POST', path: '/api/admin/users/:id/code', status: 404 },
  { method: 'PUT', path: '/api/admin/users/:id/password', status: 400 },
  { method: 'PUT', path: '/api/admin/users/:id/role', status: 400 },
  { method: 'POST', path: '/api/admin/users/:id/transfer-admin', status: 404 },
  { method: 'GET', path: '/api/app-info', status: 200 },
  { method: 'GET', path: '/api/app-secrets', status: 200 },
  { method: 'POST', path: '/api/app-secrets', status: 400 },
  { method: 'DELETE', path: '/api/app-secrets/:id', status: 404 },
  { method: 'PUT', path: '/api/app-secrets/:id', status: 404 },
  { method: 'GET', path: '/api/app-secrets/providers', status: 200 },
  { method: 'POST', path: '/api/app-secrets/providers', status: 400 },
  { method: 'DELETE', path: '/api/app-secrets/providers/:id', status: 404 },
  { method: 'PUT', path: '/api/app-secrets/providers/:id', status: 404 },
  { method: 'POST', path: '/api/app-secrets/resolve', status: 200 },
  { method: 'POST', path: '/api/auth/login', status: 401 },
  { method: 'POST', path: '/api/auth/logout', status: 200 },
  { method: 'POST', path: '/api/auth/sign-out-others', status: 401 },
  { method: 'GET', path: '/api/auth/me', status: 200 },
  { method: 'POST', path: '/api/auth/password/code', status: 404 },
  { method: 'POST', path: '/api/auth/password/forgot', status: 200 },
  { method: 'POST', path: '/api/auth/password/reset', status: 400 },
  { method: 'POST', path: '/api/auth/register', status: 403 },
  { method: 'GET', path: '/api/auth/setup', status: 200 },
  { method: 'POST', path: '/api/auth/setup', status: 409 },
  { method: 'GET', path: '/api/auth/sso/:provider/callback', status: 302 },
  { method: 'GET', path: '/api/auth/sso/broker/callback', status: 302 },
  { method: 'GET', path: '/api/auth/sso/:provider/start', status: 404 },
  { method: 'GET', path: '/api/auth/sso/providers', status: 200 },
  { method: 'POST', path: '/api/compare', status: 400 },
  { method: 'POST', path: '/api/connection/test', status: 400 },
  { method: 'GET', path: '/api/connections', status: 200 },
  { method: 'POST', path: '/api/connections', status: 400 },
  { method: 'DELETE', path: '/api/connections/:id', status: 404 },
  { method: 'PUT', path: '/api/connections/:id', status: 400 },
  { method: 'POST', path: '/api/data-migrate/execute', status: 400 },
  { method: 'GET', path: '/api/data-migrations', status: 200 },
  { method: 'DELETE', path: '/api/data-migrations/:id', status: 404 },
  { method: 'GET', path: '/api/data-migrations/:id', status: 404 },
  { method: 'POST', path: '/api/data-migrations/:id/finish', status: 400 },
  { method: 'POST', path: '/api/data-migrations/start', status: 400 },
  { method: 'POST', path: '/api/db/test', status: 400 },
  { method: 'GET', path: '/api/driver/check', status: 400 },
  { method: 'POST', path: '/api/driver/install', status: 400 },
  { method: 'GET', path: '/api/files/browse', status: 200 },
  { method: 'GET', path: '/api/files/capacity', status: 200 },
  { method: 'POST', path: '/api/files/detect-columns', status: 400 },
  { method: 'POST', path: '/api/files/import', status: 400 },
  { method: 'DELETE', path: '/api/files/imports', status: 200 },
  { method: 'GET', path: '/api/files/imports', status: 200 },
  { method: 'DELETE', path: '/api/files/imports/:id', status: 404 },
  { method: 'POST', path: '/api/files/sessions', status: 400 },
  { method: 'DELETE', path: '/api/files/sessions/:id', status: 200 },
  { method: 'PUT', path: '/api/files/sessions/:id/chunk', status: 400 },
  { method: 'POST', path: '/api/files/sessions/:id/commit', status: 404 },
  { method: 'GET', path: '/api/git/repos', status: 200 },
  { method: 'POST', path: '/api/git/repos', status: 400 },
  { method: 'DELETE', path: '/api/git/repos/:id', status: 404 },
  { method: 'PUT', path: '/api/git/repos/:id', status: 404 },
  { method: 'GET', path: '/api/git/repos/:id/branches', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/commit', status: 404 },
  { method: 'GET', path: '/api/git/repos/:id/file', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/migrations', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/preview', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/branches', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/fetch', status: 404 },
  { method: 'GET', path: '/api/git/repos/:id/activity', status: 200 },
  { method: 'GET', path: '/api/git/repos/:id/log', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/pull', status: 404 },
  { method: 'POST', path: '/api/git/repos/:id/push', status: 404 },
  { method: 'POST', path: '/api/lokee/capture', status: 400 },
  { method: 'GET', path: '/api/lokee/databases', status: 200 },
  { method: 'GET', path: '/api/lokee/databases/:id/compare', status: 400 },
  { method: 'GET', path: '/api/lokee/databases/:id/graph', status: 200 },
  { method: 'GET', path: '/api/lokee/databases/:id/inspect', status: 400 },
  { method: 'POST', path: '/api/lokee/databases/:id/revert', status: 400 },
  { method: 'GET', path: '/api/lokee/databases/:id/revert/plan', status: 400 },
  { method: 'GET', path: '/api/lokee/databases/:id/versions', status: 200 },
  { method: 'PATCH', path: '/api/lokee/databases/:id/versions/:versionId', status: 404 },
  { method: 'POST', path: '/api/migration/execute', status: 400 },
  { method: 'DELETE', path: '/api/migrations', status: 200 },
  { method: 'GET', path: '/api/migrations', status: 200 },
  { method: 'DELETE', path: '/api/migrations/:id', status: 404 },
  { method: 'GET', path: '/api/migrations/:id', status: 404 },
  { method: 'POST', path: '/api/migrations/delete', status: 200 },
  { method: 'POST', path: '/api/schema/db-access', status: 400 },
  { method: 'POST', path: '/api/schema/dba-utility', status: 400 },
  { method: 'POST', path: '/api/schema/table-insight', status: 400 },
  { method: 'POST', path: '/api/schema/index-fragmentation', status: 400 },
  { method: 'POST', path: '/api/schema/index-fragmentation-batch', status: 400 },
  { method: 'POST', path: '/api/schema/list', status: 400 },
  { method: 'POST', path: '/api/schema/load', status: 400 },
  { method: 'POST', path: '/api/signup', status: 400 },
  { method: 'POST', path: '/api/signup/skip', status: 200 },
  { method: 'GET', path: '/api/signup/state', status: 200 },
  { method: 'POST', path: '/api/sql/code-cell', status: 400 },
  { method: 'POST', path: '/api/sql/code-cell/transpile', status: 400 },
  { method: 'POST', path: '/api/sql/execute', status: 400 },
  { method: 'POST', path: '/api/updates/apply', status: 403 },
  { method: 'GET', path: '/api/updates/check', status: 200 },
  { method: 'GET', path: '/api/backup-settings', status: 200 },
  { method: 'PUT', path: '/api/backup-settings/:dialect', status: 400 },
  { method: 'GET', path: '/api/user/preferences', status: 200 },
  { method: 'PUT', path: '/api/user/preferences', status: 200 },
  { method: 'GET', path: '/api/workspaces', status: 200 },
  { method: 'POST', path: '/api/workspaces', status: 400 },
  { method: 'PATCH', path: '/api/workspaces/:id', status: 404 },
  { method: 'POST', path: '/api/workspaces/:id/archive', status: 404 },
  { method: 'GET', path: '/api/workspaces/:id/members', status: 404 },
  { method: 'PUT', path: '/api/workspaces/:id/members/:userId', status: 400 },
  { method: 'DELETE', path: '/api/workspaces/:id/members/:userId', status: 404 },
  { method: 'POST', path: '/api/workspaces/:id/select', status: 404 },
  { method: 'GET', path: '/api/workspaces/invites', status: 200 },
  { method: 'GET', path: '/api/workspaces/all', status: 200 },
  { method: 'GET', path: '/api/workspaces/discover', status: 200 },
  { method: 'POST', path: '/api/workspaces/:id/join', status: 404 },
  { method: 'POST', path: '/api/workspaces/invites/:inviteId/accept', status: 404 },
  { method: 'POST', path: '/api/workspaces/invites/:inviteId/decline', status: 404 },
  { method: 'GET', path: '/api/workspaces/:id/invites', status: 404 },
  { method: 'POST', path: '/api/workspaces/:id/invites', status: 400 },
  { method: 'DELETE', path: '/api/workspaces/:id/invites/:inviteId', status: 404 },
  { method: 'GET', path: '/api/health', status: 200 },
  { method: 'GET', path: '/api/config', status: 200 },
  { method: 'POST', path: '/api/auth/launch', status: 401 },
  { method: 'POST', path: '/api/auth/verify', status: 401 },
  { method: 'POST', path: '/api/auth/verify/send', status: 401 },
  { method: 'POST', path: '/api/lokee/databases/:id/force-migrate', status: 400 },
  { method: 'POST', path: '/api/lokee/databases/:id/force-migrate/plan', status: 400 },
  { method: 'GET', path: '/api/workflow/settings', status: 200 },
  { method: 'PUT', path: '/api/workflow/settings', status: 200 },
  { method: 'GET', path: '/api/workflow/connections', status: 200 },
  { method: 'PUT', path: '/api/workflow/connections/:id/grant', status: 404 },
  { method: 'DELETE', path: '/api/workflow/connections/:id/grant', status: 200 },
  { method: 'GET', path: '/api/workflow-internal/engine-config', status: 503 },
  { method: 'POST', path: '/api/workflow-internal/connections/resolve', status: 503 },
];

const KEY = '0'.repeat(64);

/**
 * Routes that answer without a session. Everything else must refuse one:
 * every install signs in, so a route missing its guard is a hole.
 */
const PUBLIC = [
  /^\/api\/health$/,
  /^\/api\/config$/,
  /^\/api\/auth\//,
  /^\/api\/signup/,
  // Called by the workflow engine with its service token, never a session;
  // they answer 503 until that token is configured.
  /^\/api\/workflow-internal\//,
];

/**
 * Mounted but not probed here: the workflow proxy forwards these to the
 * workflow engine, a separate process with its own tests
 * (`apps/workflow-server`), so what an empty request gets depends on whether
 * that process is running. Everything else a feature mounts is in ROUTES.
 */
const PROXIED = [/^\/api\/workflow\/engine\//];

/** The session the probes run as: the admin first-run setup creates. */
let sessionCookie = '';

function url(path: string): string {
  return path.replace(/:(\w+)/g, '00000000-0000-0000-0000-000000000000');
}

/** Started on an ephemeral port so parallel test files cannot collide. */
async function startFastify(): Promise<{ port: number; stop: () => Promise<void> }> {
  const { createFastifyApp } = await import('./fastify-server');
  const app: FastifyInstance = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  return { port, stop: () => app.close() };
}

interface Probe {
  status: number;
  body: unknown;
  text: string;
}

async function probe(port: number, route: RouteExpectation, withSession = true): Promise<Probe> {
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(route.method);
  // Auth routes run without the session: logout would otherwise end it for
  // every probe after it.
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (withSession && !route.path.startsWith('/api/auth/')) headers.cookie = sessionCookie;
  const res = await fetch(`http://127.0.0.1:${port}${url(route.path)}`, {
    method: route.method,
    redirect: 'manual',
    headers,
    ...(hasBody ? { body: '{}' } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON — the assertions below say when that is allowed */
  }
  return { status: res.status, body, text };
}

describe('HTTP contract', () => {
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      process.env.APP_ENCRYPTION_KEY ||= KEY;
      ({ port, stop } = await startFastify());
      // First-run setup from this machine (no code needed) creates the admin.
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'contract-admin@example.com', password: 'contract-pass-1' }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      sessionCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    }, 120_000);

    afterAll(async () => {
      await stop?.();
    });

    it('covers every route the API declares', () => {
      // Guards against the table silently falling behind the router files.
      // 81 is the count at the time of writing; a new route must be added here
      // deliberately, which is the point.
      //
      // 80 -> 81: POST /api/schema/table-insight, behind dbaUtilityLimiter and
      // requirePermissions('editor.run') because it powers Data Peek.
      //
      // 81 -> 84: POST /api/admin/users and GET/POST /api/auth/setup, when
      // sign-in became mandatory and self-registration closed.
      //
      // 84 -> 95: forgot password (/api/auth/password/*), an admin's fresh
      // invite or reset code, and the sign-in settings screen (/api/admin/sign-in).
      //
      // 95 -> 97: the Fox sign-in service switch and its callback.
      //
      // 97 -> 107: migration repositories (/api/git).
      //
      // 107 -> 111: committing migrations (preview, commit, list, read a file).
      //
      // 111 -> 112: who changed a Git repository (/api/git/repos/:id/activity).
      //
      // 112 -> 113: sign out other sessions (/api/auth/sign-out-others).
      //
      // 115 -> 116: TypeScript code cells compile on the server
      // (/api/sql/code-cell/transpile) instead of downloading the compiler.
      //
      // 116 -> 119: one admin or several (/api/admin/policy) and handing the
      // admin role over (/api/admin/users/:id/transfer-admin).
      //
      // 119 -> 127: shared workspaces (/api/workspaces).
      //
      // 127 -> 133: invites (/api/workspaces/invites, /api/workspaces/:id/invites).
      //
      // 133 -> 134: every workspace, for an admin (/api/workspaces/all).
      //
      // 134 -> 136: public workspaces (/api/workspaces/discover, /:id/join).
      //
      // 136 -> 150: routes that were served but never listed, found when the
      // table was first compared with what the feature registry mounts:
      // health and config, the launch link and email verification, Lokee's
      // force-migrate, the workflow settings and connection grants, and the
      // two routes the workflow engine calls.
      expect(ROUTES.length).toBe(150);
      expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
    });

    it('lists exactly the routes the feature registry serves', async () => {
      // The count above only says the table did not shrink. This says each
      // route a feature mounts is in it, and each row is still served — so a
      // new feature's routes are listed here, with their answers, before it
      // ships.
      const { buildApiRoutes } = await import('./server');
      const key = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
      const served = buildApiRoutes().filter((r) => !PROXIED.some((p) => p.test(r.path)));
      expect(served.map(key).sort()).toEqual(ROUTES.map(key).sort());
    });

    it('sets the security headers on a live response, and no framework banner', async () => {
      // The policy itself is unit-tested; what is asserted here is that the
      // onRequest hook is actually installed, on the server that ships.
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      // Version and stack are free reconnaissance.
      expect(res.headers.get('x-powered-by')).toBeNull();
    });

    it('answers 404, not 403, for a workspace the caller is not in — on every protected route', async () => {
      // A missing id and someone else's private workspace must look the same.
      const res = await fetch(`http://127.0.0.1:${port}/api/connections`, {
        headers: { cookie: sessionCookie, 'x-fox-workspace': '00000000-0000-4000-8000-000000000000' },
      });
      expect(res.status).toBe(404);
      expect(isApiErrorBody(await res.json())).toBe(true);
    });

    it('says which workspace the session acts in, with the permissions it has there', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie: sessionCookie } });
      const body = (await res.json()) as { user: { permissions: string[] }; workspace: { personal: boolean; role: string } };
      expect(body.workspace).toMatchObject({ personal: true, role: 'owner' });
      expect(body.user.permissions.length).toBeGreaterThan(0);
      // A workspace the browser remembers but cannot open falls back instead of failing the boot.
      const stale = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { cookie: sessionCookie, 'x-fox-workspace': '00000000-0000-4000-8000-000000000000' },
      });
      expect(((await stale.json()) as { workspace: { personal: boolean } }).workspace.personal).toBe(true);
    });

    it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
      '%s answers as specified',
      async (key, route) => {
        const { status, body, text } = await probe(port, route);

        // A route that does not answer at all is the failure this whole file
        // exists to catch — the hang, or a 404 from a lost mount.
        expect(status, `${key} returned an unexpected status (body: ${text.slice(0, 200)})`).toBe(
          route.status
        );

        if (status >= 400 && status !== 302) {
          // No exceptions to either rule. Both started as allow-lists — 6 routes
          // answered 500 to an empty body, and 50 of 51 error responses carried
          // no code — and both lists reached zero, so they are gone. A new route
          // that regresses either fails here rather than being added to a list.
          expect(status, `${key} answers 500 to an empty body — add input validation`).not.toBe(
            500
          );
          expect(
            isApiErrorBody(body),
            `${key} must answer with the shared error contract { ok, error, code }`
          ).toBe(true);
        }
      },
      30_000
    );

    it.each(
      ROUTES.filter((r) => !PUBLIC.some((p) => p.test(r.path))).map(
        (r) => [`${r.method} ${r.path}`, r] as const
      )
    )(
      '%s refuses a request with no session',
      async (key, route) => {
        const { status, body } = await probe(port, route, false);
        expect(status, `${key} answered ${status} without a session`).toBe(401);
        expect(isApiErrorBody(body)).toBe(true);
      },
      30_000
    );
  });
