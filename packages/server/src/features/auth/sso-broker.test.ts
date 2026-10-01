/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * An assertion from the Fox sign-in service is a credential: it must carry
 * the service's signature, be meant for this install and this browser, be
 * fresh, and work once.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { SsoBroker } from './sso-broker';

const URL_BASE = 'https://broker.test/wp-json/foxschema/v1/sso';
const AUD = 'http://localhost:5199/api/auth/sso/broker/callback';
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const NOW_S = NOW / 1000;

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { kid, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x } };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function assertion(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {}) {
  const header = b64({ alg: 'EdDSA', typ: 'JWT', kid: key.kid });
  const payload = b64({
    iss: 'https://broker.test',
    aud: AUD,
    nonce: 'nonce-1',
    email: 'Ana@Example.com',
    email_verified: true,
    provider: 'github',
    iat: NOW_S,
    exp: NOW_S + 120,
    jti: Math.random().toString(36).slice(2),
    ...claims,
  });
  const sig = sign(null, Buffer.from(`${header}.${payload}`), key.privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function brokerWith(jwks: () => object[]) {
  let jwksCalls = 0;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/jwks')) {
      jwksCalls += 1;
      return { ok: true, json: async () => ({ keys: jwks() }) };
    }
    if (url.endsWith('/providers')) {
      return {
        ok: true,
        json: async () => ({ providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }, { id: 'evil', label: 'x' }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { broker: new SsoBroker(URL_BASE, fetchImpl), jwksCalls: () => jwksCalls };
}

const expectOk = { audience: AUD, nonce: 'nonce-1' };

describe('Fox sign-in service assertions', () => {
  const key = keyPair('k1');

  it('accepts a fresh, signed assertion for this install and this browser, once', async () => {
    const { broker } = brokerWith(() => [key.jwk]);
    const token = assertion(key);
    await expect(broker.verify(token, expectOk, NOW)).resolves.toEqual({ email: 'ana@example.com', provider: 'github' });
    await expect(broker.verify(token, expectOk, NOW)).rejects.toThrow(/already used/);
  });

  it('refuses an assertion meant for another site or another browser', async () => {
    const { broker } = brokerWith(() => [key.jwk]);
    await expect(broker.verify(assertion(key, { aud: 'https://evil.example/api/auth/sso/broker/callback' }), expectOk, NOW)).rejects.toThrow(/another site/);
    await expect(broker.verify(assertion(key, { nonce: 'someone-else' }), expectOk, NOW)).rejects.toThrow(/another sign-in/);
  });

  it('refuses expired, too old, wrong issuer, or unverified', async () => {
    const { broker } = brokerWith(() => [key.jwk]);
    await expect(broker.verify(assertion(key, { exp: NOW_S - 120 }), expectOk, NOW)).rejects.toThrow(/expired/);
    await expect(broker.verify(assertion(key, { iat: NOW_S - 3600, exp: NOW_S + 3600 }), expectOk, NOW)).rejects.toThrow(/too old/);
    await expect(broker.verify(assertion(key, { iss: 'https://evil.example' }), expectOk, NOW)).rejects.toThrow(/wrong issuer/);
    await expect(broker.verify(assertion(key, { email_verified: false }), expectOk, NOW)).rejects.toThrow(/did not verify/);
  });

  it('refuses a forged signature and a key the service never published', async () => {
    const { broker } = brokerWith(() => [key.jwk]);
    const other = keyPair('k1'); // same kid, different key
    await expect(broker.verify(assertion(other), expectOk, NOW)).rejects.toThrow(/bad signature/);
    const stranger = keyPair('k9');
    await expect(broker.verify(assertion(stranger), expectOk, NOW)).rejects.toThrow(/unknown signing key/);
    const [h, p] = assertion(key).split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${p}.`;
    await expect(broker.verify(unsigned, expectOk, NOW)).rejects.toThrow(/algorithm/);
    expect(h).toBeTruthy();
  });

  it('picks up a rotated key without waiting out the cache', async () => {
    const next = keyPair('k2');
    let published = [key.jwk];
    const { broker, jwksCalls } = brokerWith(() => published);
    await broker.verify(assertion(key), expectOk, NOW);
    published = [key.jwk, next.jwk];
    await expect(broker.verify(assertion(next), expectOk, NOW + 61_000)).resolves.toBeTruthy();
    expect(jwksCalls()).toBe(2);
  });

  it('offers only Google and GitHub, and nothing when the service is unreachable', async () => {
    const { broker } = brokerWith(() => [key.jwk]);
    expect((await broker.providers(NOW)).map((p) => p.id)).toEqual(['github', 'google']);
    const down = new SsoBroker(URL_BASE, (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(await down.providers(NOW)).toEqual([]);
  });

  it('sends the browser to the service with where to come back and the nonce', () => {
    const { broker } = brokerWith(() => []);
    const url = new URL(broker.startUrl('github', AUD, 'nonce-1'));
    expect(url.origin + url.pathname).toBe(`${URL_BASE}/start`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ provider: 'github', return_to: AUD, state: 'nonce-1' });
  });
});
