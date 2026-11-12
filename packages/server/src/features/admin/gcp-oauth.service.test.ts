import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule, type AuthUser } from '../../platform/identity/auth.service';
import type { WorkspaceScope } from '../../platform/http/scope';
import type { AppRequest } from '../../platform/http/types';
import { CloudProviderCredentialsStore } from './cloud-provider-credentials.service';
import { GcpOAuthService } from './gcp-oauth.service';
import { AppSecretsStore } from './app-secrets.service';
import { getStore } from '../../database/store';
import type { GcpProviderCredentials } from '../../internal/cloud-secrets';
import { resolveCloudSecret } from '../../internal/cloud-secrets';

const auth = new AuthModule();
const providers = new CloudProviderCredentialsStore();
const gcpOAuth = new GcpOAuthService(providers);
const secrets = new AppSecretsStore();

const scopeFor = async (user: AuthUser): Promise<WorkspaceScope> => ({
  userId: user.id,
  workspaceId: (await auth.inWorkspace(user, undefined)).workspace.id,
});

let alice: WorkspaceScope;
let bob: WorkspaceScope;

beforeAll(async () => {
  alice = await scopeFor(await auth.createUser('alice-gcp-oauth@example.com', 'correct-horse-9', 'viewer'));
  bob = await scopeFor(await auth.createUser('bob-gcp-oauth@example.com', 'correct-horse-9', 'viewer'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SSO_GOOGLE_CLIENT_ID;
  delete process.env.SSO_GOOGLE_CLIENT_SECRET;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GcpOAuthService', () => {
  it('exchanges the callback code and stores only an encrypted refresh token', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';
    const req = { protocol: 'http', host: '127.0.0.1:3210', query: {} } as AppRequest;
    const started = await gcpOAuth.beginConnect(req, alice, 'Callback GCP');
    const state = started.cookie.split('.')[0]!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/token')) {
          return jsonResponse({ access_token: 'ya29.cb', refresh_token: '1//from-callback' });
        }
        if (url.includes('/userinfo')) {
          return jsonResponse({ email: 'cb@example.com', email_verified: true });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    await expect(
      gcpOAuth.completeConnect(req, alice, { code: 'code-1', state: 'wrong', cookie: started.cookie })
    ).rejects.toThrow(/expired Google Cloud connect state/);

    const saved = await gcpOAuth.completeConnect(req, alice, {
      code: 'code-1',
      state,
      cookie: started.cookie,
    });
    expect(saved).toMatchObject({ name: 'Callback GCP', auth: 'oauth', email: 'cb@example.com' });
    expect(JSON.stringify(saved)).not.toContain('1//from-callback');
    expect(JSON.stringify(saved)).not.toContain('ya29.cb');
    const decrypted = await providers.getDecryptedById(alice, saved.id);
    expect(decrypted?.credentials).toMatchObject({
      auth: 'oauth',
      refreshToken: '1//from-callback',
    });
    expect((decrypted?.credentials as GcpProviderCredentials).accessToken).toBeUndefined();
  });

  it('stores the refresh token encrypted and omits it from list/summary', async () => {
    const saved = await gcpOAuth.storeOAuthCredential(alice, 'Google Cloud', {
      refreshToken: '1//refresh-secret',
      email: 'dev@example.com',
    });
    expect(saved).toMatchObject({
      name: 'Google Cloud',
      provider: 'gcp',
      auth: 'oauth',
      email: 'dev@example.com',
    });
    expect(JSON.stringify(saved)).not.toContain('1//refresh-secret');
    expect(JSON.stringify(saved)).not.toContain('refreshToken');

    const listed = await providers.list(alice);
    const hit = listed.find((c) => c.id === saved.id);
    expect(hit).toMatchObject({ auth: 'oauth', email: 'dev@example.com' });
    expect(JSON.stringify(listed)).not.toContain('1//refresh-secret');
    expect(JSON.stringify(listed)).not.toContain('refresh_token');

    const db = await getStore();
    const row = await db.get<{ encrypted_config: string }>(
      'SELECT encrypted_config FROM cloud_provider_credentials WHERE id = ?',
      [saved.id]
    );
    expect(row?.encrypted_config).toBeTruthy();
    expect(row!.encrypted_config).not.toContain('1//refresh-secret');

    const decrypted = await providers.getDecryptedById(alice, saved.id);
    expect(decrypted?.credentials).toMatchObject({
      auth: 'oauth',
      refreshToken: '1//refresh-secret',
      email: 'dev@example.com',
    });
  });

  it('does not let workspace B list or fetch with workspace A’s credential', async () => {
    const saved = await gcpOAuth.storeOAuthCredential(alice, 'Alice GCP', {
      refreshToken: '1//alice-only',
      email: 'alice@example.com',
    });
    expect(await providers.getDecryptedById(bob, saved.id)).toBeNull();
    expect(await providers.list(bob).then((rows) => rows.find((c) => c.id === saved.id))).toBeUndefined();
    await expect(gcpOAuth.listProjects(bob, saved.id)).rejects.toThrow(/not found/i);
    await expect(gcpOAuth.disconnect(bob, saved.id)).resolves.toBe(false);
    expect(await providers.getDecryptedById(alice, saved.id)).not.toBeNull();
  });

  it('revokes at Google then deletes on disconnect', async () => {
    const saved = await gcpOAuth.storeOAuthCredential(alice, 'Revoke Me', {
      refreshToken: '1//to-revoke',
    });
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain('oauth2.googleapis.com/revoke');
      expect(String(init?.body ?? '')).toContain('token=1%2F%2Fto-revoke');
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchFn);
    expect(await gcpOAuth.disconnect(alice, saved.id)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await providers.getDecryptedById(alice, saved.id)).toBeNull();
  });

  it('mints an access token from the refresh token and fetches Secret Manager over HTTP', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';
    const cred: GcpProviderCredentials = {
      auth: 'oauth',
      refreshToken: '1//refresh-secret',
      projectId: 'demo-proj',
    };
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'ya29.from-refresh' });
      }
      if (url.includes('secretmanager.googleapis.com') && url.includes(':access')) {
        expect(url).toContain('projects/demo-proj/secrets/api-token/versions/latest');
        const headers = init?.headers as Record<string, string> | undefined;
        expect(JSON.stringify(headers)).toContain('ya29.from-refresh');
        expect(JSON.stringify(headers)).not.toContain('1//refresh-secret');
        return jsonResponse({
          payload: { data: Buffer.from('from-sm', 'utf8').toString('base64') },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchFn);

    const minted = await gcpOAuth.ensureGcpAccessToken(cred);
    expect(minted.accessToken).toBe('ya29.from-refresh');
    expect(JSON.stringify(minted)).not.toContain('oauth-secret');

    await expect(
      resolveCloudSecret('gcp', { secretId: 'api-token' }, minted)
    ).resolves.toBe('from-sm');
  });
});

describe('GcpOAuthService: a connect never replaces what its caller may not edit', () => {
  const stored = async (scope: WorkspaceScope, id: string) =>
    (await providers.getDecryptedById(scope, id))?.credentials as GcpProviderCredentials;

  it('refuses a name already connected unless the caller may edit secrets, then reconnects in place', async () => {
    const first = await gcpOAuth.storeOAuthCredential(alice, 'Shared GCP', {
      refreshToken: '1//first-owner',
      email: 'first@example.com',
    });
    // The default: adding rights only. Every connect defaults to one name, so
    // without this a second person's click swapped the workspace's identity.
    await expect(
      gcpOAuth.storeOAuthCredential(alice, 'Shared GCP', { refreshToken: '1//intruder' })
    ).rejects.toThrow(/already connected to Google Cloud.*permission to edit secrets/);
    expect((await stored(alice, first.id)).refreshToken).toBe('1//first-owner');

    const again = await gcpOAuth.storeOAuthCredential(
      alice,
      'Shared GCP',
      { refreshToken: '1//reconnected', email: 'first@example.com' },
      { mayReplace: true }
    );
    // Same row, so secrets that point at it keep working.
    expect(again.id).toBe(first.id);
    expect((await stored(alice, first.id)).refreshToken).toBe('1//reconnected');
  });

  it('never replaces a credential that is not a Google Cloud connection, edit rights or not', async () => {
    const token = await providers.create(alice, 'Token GCP', 'gcp', { accessToken: 'ya29.static' });
    const aws = await providers.create(alice, 'Team AWS', 'aws', {
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });
    for (const name of ['Token GCP', 'Team AWS']) {
      await expect(
        gcpOAuth.storeOAuthCredential(alice, name, { refreshToken: '1//intruder' }, { mayReplace: true })
      ).rejects.toThrow(/already exists and is not a Google Cloud connection/);
    }
    expect((await stored(alice, token.id)).accessToken).toBe('ya29.static');
    expect((await stored(alice, token.id)).refreshToken).toBeUndefined();
    expect((await providers.getDecryptedById(alice, aws.id))?.provider).toBe('aws');
  });

  it('refuses at the start and at the callback, before anything is asked of Google', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';
    const req = { protocol: 'http', host: '127.0.0.1:3210', query: {} } as AppRequest;
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'ya29.x', refresh_token: '1//intruder' }));
    vi.stubGlobal('fetch', fetchFn);

    // Begun while the name was free; taken by someone else before the callback.
    const started = await gcpOAuth.beginConnect(req, alice, 'Raced GCP');
    const owner = await gcpOAuth.storeOAuthCredential(alice, 'Raced GCP', { refreshToken: '1//owner' });
    await expect(
      gcpOAuth.completeConnect(req, alice, {
        code: 'code-1',
        state: started.cookie.split('.')[0]!,
        cookie: started.cookie,
      })
    ).rejects.toThrow(/already connected to Google Cloud/);
    await expect(gcpOAuth.beginConnect(req, alice, 'Raced GCP')).rejects.toThrow(/already connected/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await stored(alice, owner.id)).refreshToken).toBe('1//owner');

    await expect(gcpOAuth.beginConnect(req, alice, 'Raced GCP', { mayReplace: true })).resolves.toMatchObject({
      url: expect.stringContaining('accounts.google.com'),
    });
  });
});

describe('GcpOAuthService: the grant is stored only in the workspace the connect began in', () => {
  it('refuses the callback when another workspace is selected by then, and spends nothing', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';
    const req = { protocol: 'http', host: '127.0.0.1:3210', query: {} } as AppRequest;
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'ya29.x', refresh_token: '1//personal-grant' }));
    vi.stubGlobal('fetch', fetchFn);

    const started = await gcpOAuth.beginConnect(req, alice, 'Moved GCP');
    const [state, verifier] = started.cookie.split('.');
    // The same person, acting in another workspace when Google sends them back.
    const elsewhere: WorkspaceScope = { userId: alice.userId, workspaceId: bob.workspaceId };
    await expect(
      gcpOAuth.completeConnect(req, elsewhere, { code: 'code-1', state: state!, cookie: started.cookie })
    ).rejects.toThrow(/selected workspace changed while connecting/);
    // A state cookie with no readable workspace is no proof of where it began.
    await expect(
      gcpOAuth.completeConnect(req, alice, { code: 'code-1', state: state!, cookie: `${state}.${verifier}.` })
    ).rejects.toThrow(/selected workspace changed while connecting/);

    expect(fetchFn).not.toHaveBeenCalled();
    for (const scope of [alice, bob, elsewhere]) {
      expect((await providers.list(scope)).some((c) => c.name === 'Moved GCP')).toBe(false);
    }

    // Unchanged workspace: it completes.
    const saved = await gcpOAuth.completeConnect(req, alice, { code: 'code-1', state: state!, cookie: started.cookie });
    expect(saved).toMatchObject({ name: 'Moved GCP', auth: 'oauth' });
  });
});

describe('AppSecretsStore cloud refs with GCP OAuth', () => {
  it('resolves a cloud ref through the refreshed token and does not write encrypted_value', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'oauth-secret';
    const cred = await gcpOAuth.storeOAuthCredential(alice, 'Resolve GCP', {
      refreshToken: '1//resolve-refresh',
    });
    const created = await secrets.create(alice, {
      name: 'fromGcpOAuth',
      source: 'gcp',
      cloudRef: {
        secretId: 'projects/demo-proj/secrets/api-token',
        credentialId: cred.id,
      },
    });
    expect(created.cloudRef?.secretId).toBe('projects/demo-proj/secrets/api-token');
    expect(JSON.stringify(created)).not.toContain('1//resolve-refresh');

    const db = await getStore();
    const row = await db.get<{ encrypted_value: string | null; cloud_ref: string | null }>(
      'SELECT encrypted_value, cloud_ref FROM app_secrets WHERE id = ?',
      [created.id]
    );
    expect(row?.encrypted_value).toBeNull();
    expect(row?.cloud_ref).toContain('projects/demo-proj/secrets/api-token');
    expect(row?.cloud_ref).not.toContain('1//resolve-refresh');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/token')) return jsonResponse({ access_token: 'ya29.resolve' });
        if (url.includes(':access')) {
          return jsonResponse({
            payload: { data: Buffer.from('session-only', 'utf8').toString('base64') },
          });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const out = await secrets.resolve(alice, ['fromGcpOAuth']);
    expect(out.secrets.fromGcpOAuth).toBe('session-only');
    expect(out.errors).toEqual({});
  });
});
