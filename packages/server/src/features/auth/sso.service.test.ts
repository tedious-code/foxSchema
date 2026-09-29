/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SSO signs in whoever owns an email, so it must only accept emails the
 * provider verified: Google's `email_verified`, GitHub's verified primary
 * address, and for Microsoft a personal account, the configured tenant, or a
 * domain Microsoft marks verified. Anything else is how one provider account
 * becomes someone else's Fox account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MICROSOFT_CONSUMER_TENANT,
  authorizeUrl,
  fetchVerifiedEmail,
  idTokenClaims,
  microsoftEmailTrusted,
  newPkce,
} from './sso.service';
import type { SsoProviderConfig } from './sign-in-settings.service';
import { createHash } from 'node:crypto';

const provider = (id: SsoProviderConfig['id'], tenant?: string): SsoProviderConfig => ({
  id,
  label: id,
  clientId: 'client',
  clientSecret: 'secret',
  tenant,
  source: 'env',
});

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** Answer the token request, then each later request in order. */
function stubFetch(token: object, ...later: Array<{ ok?: boolean; json: unknown }>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const replies = [{ ok: true, json: token }, ...later];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body });
      const next = replies.shift()!;
      return { ok: next.ok ?? true, status: next.ok === false ? 500 : 200, json: async () => next.json };
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('PKCE', () => {
  it('sends the S256 challenge of the verifier, and the verifier with the token request', async () => {
    const { verifier, challenge } = newPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(authorizeUrl(provider('google'), 'https://fox.test/cb', 'st', challenge));
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const calls = stubFetch({ access_token: 't' }, { json: { email: 'a@b.com', email_verified: true } });
    await fetchVerifiedEmail(provider('google'), 'code', 'https://fox.test/cb', verifier);
    expect(new URLSearchParams(calls[0]!.body).get('code_verifier')).toBe(verifier);
  });
});

describe('Google', () => {
  it('accepts a verified email and refuses an unverified one', async () => {
    stubFetch({ access_token: 't' }, { json: { email: 'Ann@Example.com', email_verified: true } });
    await expect(fetchVerifiedEmail(provider('google'), 'c', 'r', 'v')).resolves.toBe('ann@example.com');

    stubFetch({ access_token: 't' }, { json: { email: 'ann@example.com', email_verified: false } });
    await expect(fetchVerifiedEmail(provider('google'), 'c', 'r', 'v')).rejects.toThrow(/did not confirm/);
  });
});

describe('GitHub', () => {
  it('uses the verified primary address, never an unverified or public one', async () => {
    stubFetch({ access_token: 't' }, {
      json: [
        { email: 'spoof@victim.com', primary: false, verified: false },
        { email: 'Dev@Example.com', primary: true, verified: true },
      ],
    });
    await expect(fetchVerifiedEmail(provider('github'), 'c', 'r', 'v')).resolves.toBe('dev@example.com');

    stubFetch({ access_token: 't' }, { json: [{ email: 'victim@example.com', primary: true, verified: false }] });
    await expect(fetchVerifiedEmail(provider('github'), 'c', 'r', 'v')).rejects.toThrow(/no verified primary/);
  });
});

describe('Microsoft', () => {
  const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';
  const MY_TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('trusts a personal account, a verified domain, or the configured tenant — nothing else', () => {
    expect(microsoftEmailTrusted({ tid: MICROSOFT_CONSUMER_TENANT }, 'common')).toBe(true);
    expect(microsoftEmailTrusted({ tid: OTHER_TENANT, xms_edov: true }, 'common')).toBe(true);
    // Anyone who runs a tenant can type any email into it.
    expect(microsoftEmailTrusted({ tid: OTHER_TENANT }, 'common')).toBe(false);
    expect(microsoftEmailTrusted({ tid: OTHER_TENANT }, 'organizations')).toBe(false);
    expect(microsoftEmailTrusted({ tid: MY_TENANT }, MY_TENANT)).toBe(true);
    expect(microsoftEmailTrusted({ tid: OTHER_TENANT }, MY_TENANT)).toBe(false);
    expect(microsoftEmailTrusted({}, MY_TENANT)).toBe(false);
  });

  it('reads the email from the ID token and refuses an untrusted tenant', async () => {
    stubFetch({ access_token: 't', id_token: jwt({ tid: MICROSOFT_CONSUMER_TENANT, email: 'Me@Outlook.com' }) });
    await expect(fetchVerifiedEmail(provider('microsoft', 'common'), 'c', 'r', 'v')).resolves.toBe('me@outlook.com');

    stubFetch({ access_token: 't', id_token: jwt({ tid: OTHER_TENANT, email: 'ceo@victim.com' }) });
    await expect(fetchVerifiedEmail(provider('microsoft', 'common'), 'c', 'r', 'v')).rejects.toThrow(
      /sets this install's Microsoft tenant/
    );
  });

  it('reads no claims from a malformed token', () => {
    expect(idTokenClaims('not-a-jwt')).toEqual({});
    expect(idTokenClaims(undefined)).toEqual({});
  });
});
