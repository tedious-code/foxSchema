/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Google / GitHub through the Fox sign-in service, over HTTP, against a local
 * stand-in for foxschema.com. Off until an admin turns it on; an install's
 * own provider keys win; the assertion must come back to the browser that
 * started; and, as with any SSO, only an existing account signs in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KID = 'test-key';
let service: Server;
let serviceOrigin = '';
let app: FastifyInstance;
let base = '';
let admin = '';

/** What the real service does after the provider verified `email`. */
function assertionFor(returnTo: string, nonce: string, email: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'EdDSA', typ: 'JWT', kid: KID });
  const p = enc({ iss: serviceOrigin, aud: returnTo, nonce, email, email_verified: true, provider: 'github', iat: now, exp: now + 120, jti: randomUUID() });
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

async function call(method: string, path: string, body?: unknown, cookie = '') {
  const res = await fetch(`${base}${path}`, {
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

/** Start a sign-in as a browser would: the redirect to the service, and the state cookie. */
async function start(provider: string) {
  const res = await call('GET', `/auth/sso/${provider}/start`);
  const url = new URL(res.location);
  const state = res.cookies.find((c) => c.startsWith('sso_state='))!;
  return { url, state, returnTo: url.searchParams.get('return_to')!, nonce: url.searchParams.get('state')! };
}

beforeAll(async () => {
  service = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/jwks')) {
      const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
      res.end(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', kid: KID, x }] }));
    } else if (req.url?.endsWith('/providers')) {
      res.end(JSON.stringify({ providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
  serviceOrigin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  process.env.FOX_SSO_BROKER_URL = `${serviceOrigin}/wp-json/foxschema/v1/sso`;

  const { createFastifyApp } = await import('../../api/fastify-server');
  app = await createFastifyApp({});
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const setup = await call('POST', '/auth/setup', { email: 'boss@example.com', password: 'blue-lantern-42' });
  admin = setup.cookies.find((c) => c.startsWith('sid='))!;
}, 120_000);

afterAll(async () => {
  delete process.env.FOX_SSO_BROKER_URL;
  await app?.close();
  await new Promise((r) => service.close(r));
});

describe('the Fox sign-in service', () => {
  it('is off until an admin turns it on', async () => {
    expect((await call('GET', '/auth/sso/providers')).json.providers).toEqual([]);
    expect((await call('GET', '/auth/sso/github/start')).status).toBe(404);
    expect((await call('GET', '/admin/sign-in', undefined, admin)).json.broker).toMatchObject({ enabled: false });

    expect((await call('PUT', '/admin/sign-in/broker', { enabled: true }, admin)).status).toBe(200);
    expect((await call('GET', '/auth/sso/providers')).json.providers).toEqual([
      { id: 'github', label: 'GitHub' },
      { id: 'google', label: 'Google' },
    ]);
  });

  it('sends the browser to the service with this install as the place to come back', async () => {
    const { url, state, returnTo, nonce } = await start('github');
    expect(url.origin).toBe(serviceOrigin);
    expect(url.pathname).toBe('/wp-json/foxschema/v1/sso/start');
    expect(url.searchParams.get('provider')).toBe('github');
    expect(returnTo).toMatch(/\/api\/auth\/sso\/broker\/callback$/);
    expect(state).toBe(`sso_state=${nonce}.broker`);
  });

  it('signs in an existing account from a valid assertion', async () => {
    const { state, returnTo, nonce } = await start('github');
    const assertion = assertionFor(returnTo, nonce, 'Boss@Example.com');
    const back = await call('GET', `/auth/sso/broker/callback?assertion=${assertion}&state=${nonce}`, undefined, state);
    expect(back.location).toBe('/');
    const sid = back.cookies.find((c) => c.startsWith('sid=') && c !== 'sid=')!;
    expect((await call('GET', '/auth/me', undefined, sid)).json.user.email).toBe('boss@example.com');

    // The same assertion a second time is refused.
    const again = await call('GET', `/auth/sso/broker/callback?assertion=${assertion}&state=${nonce}`, undefined, state);
    expect(decodeURIComponent(again.location)).toMatch(/already used/);
  });

  it('keeps admin accounts out when an admin says so, and lets everyone else in', async () => {
    const { AuthModule } = await import('./auth.service');
    await new AuthModule().createUser('pat@example.com', 'amber-forest-8', 'editor');
    const signIn = async (email: string) => {
      const { state, returnTo, nonce } = await start('github');
      const back = await call('GET', `/auth/sso/broker/callback?assertion=${assertionFor(returnTo, nonce, email)}&state=${nonce}`, undefined, state);
      return { location: decodeURIComponent(back.location), sid: back.cookies.find((c) => c.startsWith('sid=') && c !== 'sid=') };
    };
    expect((await call('PUT', '/admin/sign-in/broker', { admins: false }, admin)).status).toBe(200);
    try {
      const boss = await signIn('boss@example.com');
      expect(boss.location).toMatch(/Admin accounts cannot sign in through this service/);
      expect(boss.sid).toBeUndefined();
      expect((await signIn('pat@example.com')).location).toBe('/');
    } finally {
      await call('PUT', '/admin/sign-in/broker', { admins: true }, admin);
    }
    expect((await signIn('boss@example.com')).location).toBe('/');
  });

  it('refuses an assertion that comes back to a browser that did not start the sign-in', async () => {
    const { returnTo, nonce } = await start('github');
    const assertion = assertionFor(returnTo, nonce, 'boss@example.com');
    const theirs = await start('github'); // the victim's own browser state
    const back = await call('GET', `/auth/sso/broker/callback?assertion=${assertion}&state=${nonce}`, undefined, theirs.state);
    expect(decodeURIComponent(back.location)).toMatch(/sso_error=Invalid or expired SSO state/);
    expect(back.cookies.some((c) => c.startsWith('sid=') && c !== 'sid=')).toBe(false);
  });

  it('shows only the messages the service sends, never words from the link', async () => {
    const shown = async (error: string) => {
      const { state, nonce } = await start('github');
      const back = await call('GET', `/auth/sso/broker/callback?error=${encodeURIComponent(error)}&state=${nonce}`, undefined, state);
      return new URL(back.location, 'http://fox.test').searchParams.get('sso_error');
    };
    expect(await shown('Sign-in was cancelled.')).toBe('Sign-in was cancelled.');
    expect(await shown('Your session expired. Call 555-0100 to restore access.')).toBe(
      'The Fox sign-in service could not sign you in. Start the sign-in again.'
    );
  });

  it('never creates an account', async () => {
    const { state, returnTo, nonce } = await start('google');
    const back = await call(
      'GET',
      `/auth/sso/broker/callback?assertion=${assertionFor(returnTo, nonce, 'stranger@example.com')}&state=${nonce}`,
      undefined,
      state
    );
    expect(decodeURIComponent(back.location)).toMatch(/No account for stranger@example.com/);
  });

  it("an install's own GitHub app takes the place of the service's", async () => {
    await call('PUT', '/admin/sign-in/providers/github', { clientId: 'own', clientSecret: 'own-secret' }, admin);
    const res = await call('GET', '/auth/sso/github/start');
    expect(new URL(res.location).origin).toBe('https://github.com');
    expect((await call('GET', '/auth/sso/providers')).json.providers.map((p: { id: string }) => p.id)).toEqual([
      'github',
      'google',
    ]);
    await call('DELETE', '/admin/sign-in/providers/github', undefined, admin);
  });

  it('stops honouring assertions once turned off', async () => {
    const { state, returnTo, nonce } = await start('github');
    await call('PUT', '/admin/sign-in/broker', { enabled: false }, admin);
    const back = await call(
      'GET',
      `/auth/sso/broker/callback?assertion=${assertionFor(returnTo, nonce, 'boss@example.com')}&state=${nonce}`,
      undefined,
      state
    );
    expect(decodeURIComponent(back.location)).toMatch(/turned off/);
  });
});
