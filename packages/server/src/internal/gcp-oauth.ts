/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Google Cloud OAuth + Secret Manager REST (no SDK). User OAuth mints a
 * refresh token. Workload Identity Federation (or a legacy service-account
 * key still stored) mints a short-lived access token the same way the
 * workflow engine does. Callers never log tokens.
 */
import { createSign } from 'node:crypto';

export type GcpJwtKey = {
  client_email: string;
  private_key: string;
};

export const GCP_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GCP_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GCP_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GCP_CLOUD_READONLY_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
export const GCP_OAUTH_SCOPES = `${GCP_CLOUD_READONLY_SCOPE} openid email`;

export const GCP_OAUTH_CALLBACK_PATH = '/api/app-secrets/providers/gcp/oauth/callback';

export type GcpOAuthClient = {
  clientId: string;
  clientSecret: string;
};

export type GcpOAuthTokens = {
  refreshToken: string;
  accessToken: string;
  email?: string;
};

export type GcpProjectSummary = { id: string; name: string };
export type GcpSecretSummary = { id: string; name: string };
export type GcpSecretVersionSummary = { id: string; name: string; state: string };

type FetchFn = typeof fetch;

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return jsonRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function googleError(action: string, status: number, body: Record<string, unknown>): Error {
  const description =
    (typeof body.error_description === 'string' && body.error_description) ||
    (typeof body.error === 'string' && body.error) ||
    (typeof jsonRecord(body.error).message === 'string' && String(jsonRecord(body.error).message)) ||
    '';
  const suffix = description ? `: ${description}` : '';
  return new Error(`${action} failed (${status})${suffix}`);
}

export function gcpOAuthCallbackUri(publicUrl: string, protocolHost?: string): string {
  const base = (publicUrl || protocolHost || '').replace(/\/$/, '');
  if (!base) throw new Error('A public URL is required to connect Google Cloud');
  return `${base}${GCP_OAUTH_CALLBACK_PATH}`;
}

export function gcpAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GCP_OAUTH_SCOPES,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GCP_AUTHORIZE_URL}?${params.toString()}`;
}

async function postForm(
  url: string,
  body: URLSearchParams,
  fetchImpl: FetchFn
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  return { status: res.status, json: await readJson(res) };
}

export async function exchangeGcpAuthCode(
  input: {
    client: GcpOAuthClient;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  fetchImpl: FetchFn = fetch
): Promise<GcpOAuthTokens> {
  const { status, json } = await postForm(
    GCP_TOKEN_URL,
    new URLSearchParams({
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    }),
    fetchImpl
  );
  if (status >= 400) throw googleError('Google token exchange', status, json);
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : '';
  if (!accessToken) throw new Error('Google did not return an access token');
  if (!refreshToken) {
    throw new Error(
      'Google did not return a refresh token. Reconnect Google Cloud and grant offline access.'
    );
  }
  let email: string | undefined;
  try {
    const uiRes = await fetchImpl(GCP_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const ui = await readJson(uiRes);
    if (typeof ui.email === 'string' && ui.email.includes('@')) {
      email = ui.email.trim().toLowerCase();
    }
  } catch {
    // Email is display-only; Secret Manager does not need it.
  }
  return { refreshToken, accessToken, email };
}

export async function refreshGcpAccessToken(
  refreshToken: string,
  client: GcpOAuthClient,
  fetchImpl: FetchFn = fetch
): Promise<string> {
  const { status, json } = await postForm(
    GCP_TOKEN_URL,
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    fetchImpl
  );
  if (status >= 400) throw googleError('Google token refresh', status, json);
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error('Google did not return a refreshed access token');
  return accessToken;
}

/** Best-effort revoke; Google returns 200 even when the token is already gone. */
export async function revokeGcpToken(token: string, fetchImpl: FetchFn = fetch): Promise<void> {
  const { status, json } = await postForm(
    GCP_REVOKE_URL,
    new URLSearchParams({ token }),
    fetchImpl
  );
  if (status >= 400 && status !== 400) throw googleError('Google token revoke', status, json);
}

export async function mintGcpServiceAccountAccessToken(
  key: GcpJwtKey,
  fetchImpl: FetchFn = fetch,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      sub: key.client_email,
      aud: GCP_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
      scope: GCP_CLOUD_READONLY_SCOPE,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64url(signer.sign(key.private_key))}`;
  const { status, json } = await postForm(
    GCP_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    fetchImpl
  );
  if (status >= 400) throw googleError('GCP service-account token', status, json);
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error('GCP service account did not return an access token');
  return accessToken;
}

async function gcpGet(
  url: string,
  accessToken: string,
  fetchImpl: FetchFn
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const json = await readJson(res);
  if (!res.ok) throw googleError('Google Cloud API', res.status, json);
  return json;
}

async function gcpGetPages(
  firstUrl: string,
  accessToken: string,
  fetchImpl: FetchFn,
  maxPages = 10
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = [];
  let url: string | undefined = firstUrl;
  for (let i = 0; i < maxPages && url; i++) {
    const json = await gcpGet(url, accessToken, fetchImpl);
    pages.push(json);
    const token = typeof json.nextPageToken === 'string' ? json.nextPageToken : '';
    if (!token) break;
    const next = new URL(firstUrl);
    next.searchParams.set('pageToken', token);
    url = next.toString();
  }
  return pages;
}

export async function listGcpProjects(
  accessToken: string,
  fetchImpl: FetchFn = fetch
): Promise<GcpProjectSummary[]> {
  const pages = await gcpGetPages(
    'https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE&pageSize=200',
    accessToken,
    fetchImpl
  );
  const out: GcpProjectSummary[] = [];
  for (const page of pages) {
    const projects = Array.isArray(page.projects) ? page.projects : [];
    for (const raw of projects) {
      const p = jsonRecord(raw);
      const id = typeof p.projectId === 'string' ? p.projectId.trim() : '';
      if (!id) continue;
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id;
      out.push({ id, name });
    }
  }
  return out;
}

function secretIdFromResource(resourceName: string): string {
  const parts = resourceName.split('/');
  const idx = parts.indexOf('secrets');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1]! : resourceName;
}

function versionIdFromResource(resourceName: string): string {
  const parts = resourceName.split('/');
  const idx = parts.indexOf('versions');
  return idx >= 0 && parts[idx + 1] ? parts.slice(idx + 1).join('/') : resourceName;
}

export async function listGcpSecrets(
  accessToken: string,
  projectId: string,
  fetchImpl: FetchFn = fetch
): Promise<GcpSecretSummary[]> {
  const project = projectId.trim();
  if (!project) throw new Error('GCP project id is required');
  const pages = await gcpGetPages(
    `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets?pageSize=200`,
    accessToken,
    fetchImpl
  );
  const out: GcpSecretSummary[] = [];
  for (const page of pages) {
    const secrets = Array.isArray(page.secrets) ? page.secrets : [];
    for (const raw of secrets) {
      const s = jsonRecord(raw);
      const resource = typeof s.name === 'string' ? s.name : '';
      if (!resource) continue;
      const id = secretIdFromResource(resource);
      out.push({ id, name: id });
    }
  }
  return out;
}

export async function listGcpSecretVersions(
  accessToken: string,
  projectId: string,
  secretId: string,
  fetchImpl: FetchFn = fetch
): Promise<GcpSecretVersionSummary[]> {
  const project = projectId.trim();
  const secret = secretId.trim();
  if (!project || !secret) throw new Error('GCP project and secret id are required');
  const pages = await gcpGetPages(
    `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions?pageSize=200`,
    accessToken,
    fetchImpl
  );
  const out: GcpSecretVersionSummary[] = [{ id: 'latest', name: 'latest', state: 'ENABLED' }];
  for (const page of pages) {
    const versions = Array.isArray(page.versions) ? page.versions : [];
    for (const raw of versions) {
      const v = jsonRecord(raw);
      const resource = typeof v.name === 'string' ? v.name : '';
      if (!resource) continue;
      const id = versionIdFromResource(resource);
      if (id === 'latest') continue;
      const state = typeof v.state === 'string' ? v.state : '';
      out.push({ id, name: id, state });
    }
  }
  return out;
}

export async function accessGcpSecretVersionRest(
  accessToken: string,
  resourceName: string,
  fetchImpl: FetchFn = fetch
): Promise<string> {
  const json = await gcpGet(
    `https://secretmanager.googleapis.com/v1/${resourceName}:access`,
    accessToken,
    fetchImpl
  );
  const payload = jsonRecord(json.payload);
  const data = payload.data;
  if (typeof data !== 'string' || !data) {
    throw new Error(`GCP secret "${resourceName}" has empty payload`);
  }
  return Buffer.from(data, 'base64').toString('utf8');
}
