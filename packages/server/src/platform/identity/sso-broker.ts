/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Fox sign-in service: Google and GitHub sign-in without registering an
 * OAuth app for every install.
 *
 * foxschema.com holds one Google client and one GitHub app. An install whose
 * admin turned the service on sends the browser there; the service does the
 * OAuth exchange, checks the provider verified the email, and sends the
 * browser back with a signed assertion:
 *
 *   EdDSA (Ed25519) JWT  { iss, aud: this install's callback URL, nonce,
 *                          email, email_verified, provider, iat, exp, jti }
 *
 * The install trusts it only when the signature checks against the service's
 * published key, `aud` is exactly its own callback (an assertion minted for
 * another site is useless here), `nonce` matches the state cookie this
 * browser got when it started (an assertion cannot be replayed into someone
 * else's browser), it is unexpired, and its `jti` has not been seen. Then, as
 * with any SSO, only an existing account signs in.
 *
 * Turning it on means trusting foxschema.com to say who is signing in, and
 * letting it see those emails (it does not store them). That is why it is
 * off until an admin turns it on.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export const DEFAULT_BROKER_URL = 'https://foxschema.com/wp-json/foxschema/v1/sso';
/** Providers the service may offer. */
const BROKER_PROVIDERS = new Set(['google', 'github']);
const FETCH_TIMEOUT_MS = 5000;
const PROVIDERS_TTL_MS = 5 * 60 * 1000;
const KEYS_TTL_MS = 60 * 60 * 1000;
/** Clock skew tolerated on `iat` / `exp`. */
const SKEW_S = 60;
/** Longest assertion life accepted, whatever `exp` says. */
const MAX_AGE_S = 5 * 60;

export function brokerUrl(): string {
  return (process.env.FOX_SSO_BROKER_URL || DEFAULT_BROKER_URL).replace(/\/+$/, '');
}

/** The `iss` the service signs with: its origin. */
export function brokerIssuer(url = brokerUrl()): string {
  return new URL(url).origin;
}

export interface BrokerProvider {
  id: 'google' | 'github';
  label: string;
}

type Fetch = typeof fetch;

interface Jwk {
  kty?: string;
  crv?: string;
  kid?: string;
  x?: string;
}

export class SsoBroker {
  private providersCache: { at: number; providers: BrokerProvider[] } | null = null;
  private keysCache: { at: number; keys: Map<string, KeyObject> } | null = null;
  private lastKeyRefresh = 0;
  private seen = new Map<string, number>();

  constructor(
    private url = brokerUrl(),
    private fetchImpl: Fetch = (...a) => fetch(...a)
  ) {}

  get baseUrl(): string {
    return this.url;
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`The Fox sign-in service answered ${res.status}.`);
    return res.json();
  }

  /** What the service offers right now; empty when it cannot be reached. */
  async providers(now = Date.now()): Promise<BrokerProvider[]> {
    if (this.providersCache && now - this.providersCache.at < PROVIDERS_TTL_MS) return this.providersCache.providers;
    try {
      const body = (await this.getJson('/providers')) as { providers?: Array<{ id?: unknown; label?: unknown }> };
      const providers = (body.providers ?? [])
        .filter((p) => typeof p.id === 'string' && BROKER_PROVIDERS.has(p.id))
        .map((p) => ({ id: p.id as BrokerProvider['id'], label: typeof p.label === 'string' ? p.label : String(p.id) }));
      this.providersCache = { at: now, providers };
      return providers;
    } catch {
      return [];
    }
  }

  /** Where to send the browser to start signing in. */
  startUrl(provider: string, returnTo: string, state: string): string {
    const params = new URLSearchParams({ provider, return_to: returnTo, state });
    return `${this.url}/start?${params.toString()}`;
  }

  private async keys(now: number, refresh: boolean): Promise<Map<string, KeyObject>> {
    if (this.keysCache && !refresh && now - this.keysCache.at < KEYS_TTL_MS) return this.keysCache.keys;
    const body = (await this.getJson('/jwks')) as { keys?: Jwk[] };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.kid || !jwk.x) continue;
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
    }
    this.keysCache = { at: now, keys };
    this.lastKeyRefresh = now;
    return keys;
  }

  /**
   * The email an assertion vouches for, after every check. Throws a message
   * fit for the sign-in page otherwise.
   */
  async verify(token: string, expect: { audience: string; nonce: string }, now = Date.now()): Promise<{ email: string; provider: string }> {
    const fail = (why: string): never => {
      throw new Error(`Sign-in through foxschema.com was refused: ${why}. Start the sign-in again.`);
    };
    const parts = (token ?? '').split('.');
    if (parts.length !== 3) fail('malformed assertion');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return fail('malformed assertion');
    }
    if (header.alg !== 'EdDSA' || !header.kid) fail('unexpected signature algorithm');

    let keys = await this.keys(now, false);
    // A new key after a rotation: look again, at most once a minute.
    if (!keys.has(header.kid!) && now - this.lastKeyRefresh > 60_000) keys = await this.keys(now, true);
    const key = keys.get(header.kid!);
    if (!key) return fail('unknown signing key');
    const signed = verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!signed) fail('bad signature');

    const nowS = Math.floor(now / 1000);
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    if (claims.iss !== brokerIssuer(this.url)) fail('wrong issuer');
    if (claims.aud !== expect.audience) fail('it was issued for another site');
    if (typeof claims.nonce !== 'string' || claims.nonce !== expect.nonce) fail('it belongs to another sign-in');
    if (!Number.isFinite(exp) || exp + SKEW_S < nowS) fail('it has expired');
    if (!Number.isFinite(iat) || iat - SKEW_S > nowS || nowS - iat > MAX_AGE_S) fail('it is too old');
    if (claims.email_verified !== true) fail('the provider did not verify the email');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email.includes('@')) fail('no email');
    const jti = typeof claims.jti === 'string' ? claims.jti : '';
    if (!jti) fail('no assertion id');

    for (const [id, until] of this.seen) if (until < nowS) this.seen.delete(id);
    if (this.seen.has(jti)) fail('it was already used');
    this.seen.set(jti, Math.max(exp, iat + MAX_AGE_S) + SKEW_S);

    return { email, provider: String(claims.provider ?? '') };
  }
}
