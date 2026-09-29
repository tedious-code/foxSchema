/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SSO with Google, Microsoft and GitHub (OAuth 2 authorization code + PKCE).
 *
 * Providers are configured by environment variables or on the admin screen
 * (`sign-in-settings.service.ts`); a provider's button appears once it has a
 * client id and secret. SSO signs in an existing account by email, so the one
 * thing this file must get right is that the email is one the provider has
 * verified belongs to the person:
 *
 *   Google     `email_verified` must be true.
 *   GitHub     the primary, verified address from /user/emails — never the
 *              profile's public email, which is not checked.
 *   Microsoft  the `email` claim is whatever a tenant's admin typed, so with
 *              the multi-tenant `common` endpoint anyone who runs a tenant
 *              could claim any address ("nOAuth"). Accepted only from a
 *              personal Microsoft account, from the one tenant this install is
 *              configured for, or when Microsoft marks the domain verified
 *              (`xms_edov`).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppRequest } from '../../platform/http/types';
import { headerOf } from '../../platform/http/reply';
import type { SsoProviderConfig } from './sign-in-settings.service';

export type { SsoProviderConfig, SsoProviderId } from './sign-in-settings.service';

/** The tenant personal Microsoft accounts (outlook.com, hotmail.com…) sign in from. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers']);

interface Endpoints {
  authorize: string;
  token: string;
  userinfo: string;
  scope: string;
}

function endpoints(p: SsoProviderConfig): Endpoints {
  switch (p.id) {
    case 'google':
      return {
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
        scope: 'openid email profile',
      };
    case 'microsoft': {
      const t = encodeURIComponent(p.tenant || 'common');
      return {
        authorize: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
        userinfo: 'https://graph.microsoft.com/oidc/userinfo',
        scope: 'openid email profile',
      };
    }
    case 'github':
      return {
        authorize: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
        scope: 'read:user user:email',
      };
  }
}

/** The address the provider sends the browser back to. */
export function redirectUri(req: AppRequest, providerId: string, publicUrl: string): string {
  const base = publicUrl || `${req.protocol}://${headerOf(req, 'host') ?? ''}`;
  return `${base.replace(/\/$/, '')}/api/auth/sso/${providerId}/callback`;
}

/** A PKCE verifier, and the challenge sent with the authorize request. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(p: SsoProviderConfig, redirect: string, state: string, challenge: string): string {
  const e = endpoints(p);
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: e.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (p.id === 'google') {
    params.set('access_type', 'online');
    params.set('prompt', 'select_account');
  }
  if (p.id === 'microsoft') params.set('prompt', 'select_account');
  return `${e.authorize}?${params.toString()}`;
}

interface JsonRecord {
  [k: string]: unknown;
}

/**
 * The claims of an ID token received straight from the provider's token
 * endpoint over TLS. OIDC lets a client that got the token that way skip the
 * signature check (Core 1.0 §3.1.3.7), which is the only way this reads one.
 */
export function idTokenClaims(idToken: unknown): JsonRecord {
  if (typeof idToken !== 'string') return {};
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JsonRecord;
  } catch {
    return {};
  }
}

/**
 * Whether a Microsoft sign-in's email can be trusted, from its ID token
 * claims and this install's tenant setting.
 */
export function microsoftEmailTrusted(claims: JsonRecord, configuredTenant: string | undefined): boolean {
  const tid = String(claims.tid ?? '').toLowerCase();
  if (!tid) return false;
  if (tid === MICROSOFT_CONSUMER_TENANT) return true;
  if (claims.xms_edov === true || claims.xms_edov === 1 || claims.xms_edov === '1') return true;
  const tenant = (configuredTenant || 'common').toLowerCase();
  if (MULTI_TENANT.has(tenant)) return false;
  // A single-tenant app: Microsoft only issues tokens for that tenant, whose
  // admin is the one who set this install up.
  return /^[0-9a-f-]{36}$/.test(tenant) ? tid === tenant : true;
}

const UNVERIFIED = 'The provider did not confirm that this email address is yours.';

/** Exchange the auth code for tokens, then return the verified email. */
export async function fetchVerifiedEmail(
  p: SsoProviderConfig,
  code: string,
  redirect: string,
  codeVerifier: string
): Promise<string> {
  const e = endpoints(p);
  const tokenRes = await fetch(e.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
  const tok = (await tokenRes.json()) as JsonRecord;
  const accessToken = tok.access_token as string | undefined;
  if (!accessToken) throw new Error('No access token returned by the provider.');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'FoxSchema' };

  let email = '';
  if (p.id === 'github') {
    const emRes = await fetch('https://api.github.com/user/emails', { headers });
    if (!emRes.ok) throw new Error(`Could not read your GitHub email addresses (${emRes.status})`);
    const emails = (await emRes.json()) as { email: string; primary: boolean; verified: boolean }[];
    email = emails.find((x) => x.primary && x.verified)?.email ?? '';
    if (!email) throw new Error('Your GitHub account has no verified primary email address.');
  } else if (p.id === 'google') {
    const uiRes = await fetch(e.userinfo, { headers });
    if (!uiRes.ok) throw new Error(`Could not read profile (${uiRes.status})`);
    const ui = (await uiRes.json()) as JsonRecord;
    if (ui.email_verified !== true && ui.email_verified !== 'true') throw new Error(UNVERIFIED);
    email = String(ui.email ?? '');
  } else {
    const claims = idTokenClaims(tok.id_token);
    if (!microsoftEmailTrusted(claims, p.tenant)) {
      throw new Error(
        `${UNVERIFIED} Microsoft work accounts sign in only when an administrator sets this install's Microsoft tenant.`
      );
    }
    email = String(claims.email ?? '');
  }

  if (!email || !email.includes('@')) throw new Error('The provider did not return an email address.');
  return email.trim().toLowerCase();
}
