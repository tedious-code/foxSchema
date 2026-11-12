/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Google sign-in that also connects Google Cloud, over HTTP, with Google's
 * token and profile endpoints stubbed. Off until an admin turns it on; the
 * first grant saves "Google Cloud" in the person's personal workspace; a
 * grant the person turned down, or a later one, changes nothing; and the
 * sign-in itself never depends on it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../../platform/identity/auth.service';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';

const CLOUD = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const realFetch = globalThis.fetch;
let app: FastifyInstance;
let base = '';
let admin = '';

async function call(method: string, path: string, body?: unknown, cookie = '') {
  const res = await realFetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as any;
  return {
    status: res.status,
    json,
    location: res.headers.get('location') ?? '',
    cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]!),
  };
}

/** Google answers the token request with `token`, and the profile with `email`. */
function stubGoogle(token: Record<string, unknown>, email: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'ya29.signin', ...token });
      if (url.startsWith('https://openidconnect.googleapis.com/')) return json({ email, email_verified: true });
      return realFetch(input, init);
    })
  );
}

/** A whole Google sign-in as a browser does it; returns the authorize URL and where it ended. */
async function signIn(token: Record<string, unknown>, email: string) {
  const start = await call('GET', '/auth/sso/google/start');
  const authorize = new URL(start.location);
  const state = start.cookies.find((c) => c.startsWith('sso_state='))!;
  stubGoogle(token, email);
  const back = await call('GET', `/auth/sso/google/callback?code=c&state=${authorize.searchParams.get('state')}`, undefined, state);
  vi.unstubAllGlobals();
  return { authorize, location: back.location, sid: back.cookies.find((c) => c.startsWith('sid=') && c !== 'sid=') };
}

async function cloudCredentials(email: string) {
  const { AuthModule } = await import('../../platform/identity/auth.service');
  const { CloudProviderCredentialsStore } = await import('../admin/cloud-provider-credentials.service');
  const { getStore } = await import('../../database/store');
  const row = await (await getStore()).get<{ id: string; app_role: string }>('SELECT id, app_role FROM users WHERE email = ?', [email]);
  const user = { id: row!.id, email, onboardingCompleted: true, role: row!.app_role, permissions: [] } as unknown as AuthUser;
  const scope = { userId: user.id, workspaceId: await new AuthModule().personalWorkspaceId(user) };
  const store = new CloudProviderCredentialsStore();
  return Promise.all(
    (await store.list(scope)).map(async (c) => ({
      name: c.name,
      provider: c.provider,
      refreshToken: ((await store.getDecryptedById(scope, c.id))?.credentials as { refreshToken?: string }).refreshToken,
    }))
  );
}

beforeAll(async () => {
  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const setup = await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' });
  admin = setup.cookies.find((c) => c.startsWith('sid='))!;
  const { AuthModule } = await import('../../platform/identity/auth.service');
  await new AuthModule().createUser('pat@example.com', 'amber-forest-8', 'editor');
  await new AuthModule().createUser('lee@example.com', 'amber-forest-8', 'editor');
}, 120_000);

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  delete process.env.SSO_GOOGLE_CLIENT_ID;
  delete process.env.SSO_GOOGLE_CLIENT_SECRET;
  await app?.close();
});

describe('Google sign-in that also connects Google Cloud', () => {
  it('is off until an admin turns it on: plain sign-in scopes, nothing saved', async () => {
    expect((await call('GET', '/admin/sign-in', undefined, admin)).json.googleCloud).toEqual({
      enabled: false,
      source: null,
      dedicatedClient: false,
    });
    const off = await signIn({ refresh_token: '1//ignored', scope: `openid email ${CLOUD}` }, 'pat@example.com');
    expect(off.authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(off.authorize.searchParams.get('access_type')).toBe('online');
    expect(off.location).toBe('/');
    expect(await cloudCredentials('pat@example.com')).toEqual([]);
  });

  it('only an admin may turn it on', async () => {
    const pat = await signIn({}, 'pat@example.com');
    expect((await call('PUT', '/admin/sign-in/google-cloud', { enabled: true }, pat.sid)).status).toBe(403);
    expect((await call('PUT', '/admin/sign-in/google-cloud', { enabled: 'yes' }, admin)).status).toBe(400);
    expect((await call('PUT', '/admin/sign-in/google-cloud', { enabled: true }, admin)).status).toBe(200);
    expect((await call('GET', '/admin/sign-in', undefined, admin)).json.googleCloud).toMatchObject({ enabled: true, source: 'app' });
  });

  it('turned on, the first grant saves "Google Cloud" in the personal workspace; a later one changes nothing', async () => {
    const first = await signIn({ refresh_token: '1//first', scope: `openid email profile ${CLOUD}` }, 'pat@example.com');
    expect(first.authorize.searchParams.get('scope')).toBe(`openid email profile ${CLOUD}`);
    expect(first.authorize.searchParams.get('access_type')).toBe('offline');
    expect(first.location).toBe('/');
    expect((await call('GET', '/auth/me', undefined, first.sid)).json.user.email).toBe('pat@example.com');
    expect(await cloudCredentials('pat@example.com')).toEqual([
      { name: 'Google Cloud', provider: 'gcp', refreshToken: '1//first' },
    ]);

    // Google sends no refresh token once granted; were it to send another, the saved one stays.
    await signIn({ scope: `openid email profile ${CLOUD}` }, 'pat@example.com');
    await signIn({ refresh_token: '1//second', scope: `openid email profile ${CLOUD}` }, 'pat@example.com');
    expect(await cloudCredentials('pat@example.com')).toEqual([
      { name: 'Google Cloud', provider: 'gcp', refreshToken: '1//first' },
    ]);
  });

  it('never asks when Google Cloud has its own client: the grant would not refresh with it', async () => {
    process.env.GCP_OAUTH_CLIENT_ID = 'gcp.apps.googleusercontent.com';
    process.env.GCP_OAUTH_CLIENT_SECRET = 'gcp-secret';
    try {
      expect((await call('GET', '/admin/sign-in', undefined, admin)).json.googleCloud).toEqual({
        enabled: true,
        source: 'app',
        dedicatedClient: true,
      });
      const signedIn = await signIn({ refresh_token: '1//other-client', scope: `openid email profile ${CLOUD}` }, 'lee@example.com');
      expect(signedIn.authorize.searchParams.get('scope')).toBe('openid email profile');
      expect(signedIn.location).toBe('/');
      expect(await cloudCredentials('lee@example.com')).toEqual([]);
    } finally {
      delete process.env.GCP_OAUTH_CLIENT_ID;
      delete process.env.GCP_OAUTH_CLIENT_SECRET;
    }
  });

  it('signs in without saving anything when the person turned the cloud access down', async () => {
    const declined = await signIn({ refresh_token: '1//r', scope: 'openid email profile' }, 'lee@example.com');
    expect(declined.location).toBe('/');
    expect(declined.sid).toBeTruthy();
    expect(await cloudCredentials('lee@example.com')).toEqual([]);
  });

  it('turned off again, a sign-in saves nothing even if Google sends a grant', async () => {
    expect((await call('PUT', '/admin/sign-in/google-cloud', { enabled: false }, admin)).status).toBe(200);
    await signIn({ refresh_token: '1//r', scope: `openid email profile ${CLOUD}` }, 'lee@example.com');
    expect(await cloudCredentials('lee@example.com')).toEqual([]);
  });
});
