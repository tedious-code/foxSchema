import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessGcpSecretVersionRest,
  exchangeGcpAuthCode,
  gcpAuthorizeUrl,
  gcpOAuthCallbackUri,
  listGcpProjects,
  listGcpSecretVersions,
  listGcpSecrets,
  refreshGcpAccessToken,
  revokeGcpToken,
  GCP_CLOUD_READONLY_SCOPE,
  GCP_OAUTH_CALLBACK_PATH,
} from './gcp-oauth';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const client = { clientId: 'client.apps.googleusercontent.com', clientSecret: 's3cret' };

describe('gcp OAuth HTTP helpers', () => {
  it('builds the authorize URL with PKCE, offline access, and read-only cloud scope', () => {
    const url = gcpAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: 'http://localhost:3210/api/app-secrets/providers/gcp/oauth/callback',
      state: 'st',
      challenge: 'ch',
    });
    expect(url).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('access_type=offline');
    expect(url).toContain(encodeURIComponent(GCP_CLOUD_READONLY_SCOPE));
    expect(url).toContain('code_challenge=ch');
    expect(gcpOAuthCallbackUri('https://fox.example.com')).toBe(
      `https://fox.example.com${GCP_OAUTH_CALLBACK_PATH}`
    );
  });

  it('exchanges the auth code and keeps the refresh token off the userinfo request', async () => {
    const fetchFn = fetchMock((url) => {
      if (url.includes('/token')) {
        return jsonResponse({
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
        });
      }
      if (url.includes('/userinfo')) {
        return jsonResponse({ email: 'dev@example.com', email_verified: true });
      }
      throw new Error(`unexpected ${url}`);
    });

    const tokens = await exchangeGcpAuthCode({
      client,
      code: 'code-1',
      redirectUri: 'http://localhost/callback',
      codeVerifier: 'verifier',
    });
    expect(tokens).toEqual({
      refreshToken: '1//refresh',
      accessToken: 'ya29.access',
      email: 'dev@example.com',
    });
    const tokenBody = String(fetchFn.mock.calls[0]?.[1]?.body ?? '');
    expect(tokenBody).toContain('code=code-1');
    expect(JSON.stringify(fetchFn.mock.calls[1]?.[1])).not.toContain('1//refresh');
  });

  it('refreshes an access token and accesses Secret Manager over HTTP', async () => {
    fetchMock((url) => {
      if (url.includes('/token')) {
        return jsonResponse({ access_token: 'ya29.refreshed' });
      }
      if (url.includes(':access')) {
        return jsonResponse({
          payload: { data: Buffer.from('cloud-secret', 'utf8').toString('base64') },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const access = await refreshGcpAccessToken('1//refresh', client);
    expect(access).toBe('ya29.refreshed');
    await expect(
      accessGcpSecretVersionRest('ya29.refreshed', 'projects/p/secrets/s/versions/latest')
    ).resolves.toBe('cloud-secret');
  });

  it('lists projects, secrets, and versions by name only', async () => {
    fetchMock((url) => {
      if (url.includes('cloudresourcemanager')) {
        return jsonResponse({
          projects: [{ projectId: 'demo-proj', name: 'Demo', lifecycleState: 'ACTIVE' }],
        });
      }
      if (url.includes('/versions')) {
        return jsonResponse({
          versions: [{ name: 'projects/demo-proj/secrets/api-token/versions/3', state: 'ENABLED' }],
        });
      }
      if (url.includes('/secrets')) {
        return jsonResponse({ secrets: [{ name: 'projects/demo-proj/secrets/api-token' }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    expect(await listGcpProjects('tok')).toEqual([{ id: 'demo-proj', name: 'Demo' }]);
    expect(await listGcpSecrets('tok', 'demo-proj')).toEqual([{ id: 'api-token', name: 'api-token' }]);
    const versions = await listGcpSecretVersions('tok', 'demo-proj', 'api-token');
    expect(versions[0]).toEqual({ id: 'latest', name: 'latest', state: 'ENABLED' });
    expect(versions.map((v) => v.id)).toContain('3');
  });

  it('revokes a token without throwing on Google’s already-revoked 400', async () => {
    fetchMock(() => jsonResponse({ error: 'invalid_token' }, 400));
    await expect(revokeGcpToken('1//refresh')).resolves.toBeUndefined();
  });
});
