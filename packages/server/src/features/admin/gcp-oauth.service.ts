/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Connect Google Cloud for Secret Manager: PKCE authorize, store only the
 * refresh token on a named credential, mint access tokens, list projects /
 * secrets / versions, revoke on disconnect.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { WorkspaceScope } from '../../platform/http/scope';
import type { AppRequest } from '../../platform/http/types';
import { newToken } from '../../platform/crypto/crypto';
import { newPkce } from '../../platform/identity/sso.service';
import { SignInSettings } from '../../platform/identity/sign-in-settings.service';
import { setCookie, clearCookie } from '../../platform/http/reply';
import { readCookie } from '../../platform/identity/auth.guard';
import {
  CloudProviderCredentialsStore,
  isValidCloudCredentialName,
} from './cloud-provider-credentials.service';
import type { CloudProviderCredentialSummary } from './cloud-provider-credentials.service';
import {
  classifyGcpCredentialJson,
  isGcpOAuthCredentials,
  mintGcpWifAccessToken,
  type GcpProviderCredentials,
} from '../../internal/cloud-secrets';
import {
  exchangeGcpAuthCode,
  gcpAuthorizeUrl,
  gcpOAuthCallbackUri,
  listGcpProjects,
  listGcpSecretVersions,
  listGcpSecrets,
  mintGcpServiceAccountAccessToken,
  refreshGcpAccessToken,
  revokeGcpToken,
  type GcpOAuthClient,
  type GcpProjectSummary,
  type GcpSecretSummary,
  type GcpSecretVersionSummary,
} from '../../internal/gcp-oauth';

export const GCP_OAUTH_STATE_COOKIE = 'gcp_oauth_state';
export const GCP_OAUTH_STATE_PATH = '/api/app-secrets/providers/gcp/oauth';
export const GCP_OAUTH_DEFAULT_NAME = 'Google Cloud';

const GOOGLE_NOT_CONFIGURED =
  'Connect Google Cloud needs this install’s own Google OAuth client (Access control → Sign-in → Google). The Fox sign-in service cannot access Secret Manager.';

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function decodeStatePayload(raw: string): { name: string; workspaceId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      name?: unknown;
      workspaceId?: unknown;
    };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : GCP_OAUTH_DEFAULT_NAME,
      workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : '',
    };
  } catch {
    return { name: GCP_OAUTH_DEFAULT_NAME, workspaceId: '' };
  }
}

export class GcpOAuthService {
  constructor(
    private readonly providers = new CloudProviderCredentialsStore(),
    private readonly settings = new SignInSettings()
  ) {}

  async googleClient(): Promise<GcpOAuthClient | null> {
    const provider = await this.settings.provider('google');
    if (!provider?.clientId || !provider.clientSecret) return null;
    return { clientId: provider.clientId, clientSecret: provider.clientSecret };
  }

  private async redirectUri(req: AppRequest): Promise<string> {
    const { url } = await this.settings.publicUrl();
    return gcpOAuthCallbackUri(url, `${req.protocol}://${req.host}`);
  }

  setStateCookie(res: FastifyReply, value: string): void {
    setCookie(res, GCP_OAUTH_STATE_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000,
      path: GCP_OAUTH_STATE_PATH,
    });
  }

  clearStateCookie(res: FastifyReply): void {
    clearCookie(res, GCP_OAUTH_STATE_COOKIE, { path: GCP_OAUTH_STATE_PATH });
  }

  /**
   * Refuses a connect that would land on a credential the caller may not
   * replace. Connecting under a name already in use overwrites what is stored
   * there, so it is an edit: only an existing Google Cloud connection may be
   * replaced (a reconnect), and only by someone who may edit secrets. Without
   * this, adding rights were enough to swap the workspace's Google identity —
   * and every connect defaults to the same name.
   */
  private async assertNameFree(
    scope: WorkspaceScope,
    name: string,
    mayReplace: boolean
  ): Promise<CloudProviderCredentialSummary | undefined> {
    const existing = (await this.providers.list(scope)).find((c) => c.name === name);
    if (!existing) return undefined;
    if (existing.provider !== 'gcp' || existing.auth !== 'oauth') {
      throw new Error(
        `A cloud credential named "${name}" already exists and is not a Google Cloud connection. Choose another name.`
      );
    }
    if (!mayReplace) {
      throw new Error(
        `"${name}" is already connected to Google Cloud. Reconnecting it needs permission to edit secrets — or choose another name.`
      );
    }
    return existing;
  }

  /** Authorize URL plus the value to store in the state cookie. */
  async beginConnect(
    req: AppRequest,
    scope: WorkspaceScope,
    nameRaw?: string,
    opts: { mayReplace?: boolean } = {}
  ): Promise<{ url: string; cookie: string }> {
    const client = await this.googleClient();
    if (!client) throw new Error(GOOGLE_NOT_CONFIGURED);
    const name = (nameRaw ?? '').trim() || GCP_OAUTH_DEFAULT_NAME;
    if (!isValidCloudCredentialName(name)) {
      throw new Error('Invalid credential name — use letters, digits, spaces, ._- (1–64 chars)');
    }
    // Before the trip to Google, not only after it: a refusal on the way back
    // would cost the user a consent screen for nothing.
    await this.assertNameFree(scope, name, opts.mayReplace === true);
    const state = newToken();
    const pkce = newPkce();
    const payload = Buffer.from(
      JSON.stringify({ name, workspaceId: scope.workspaceId }),
      'utf8'
    ).toString('base64url');
    return {
      url: gcpAuthorizeUrl({
        clientId: client.clientId,
        redirectUri: await this.redirectUri(req),
        state,
        challenge: pkce.challenge,
      }),
      cookie: `${state}.${pkce.verifier}.${payload}`,
    };
  }

  async completeConnect(
    req: AppRequest,
    scope: WorkspaceScope,
    input: { code: string; state: string; cookie: string | undefined; mayReplace?: boolean }
  ): Promise<CloudProviderCredentialSummary> {
    const client = await this.googleClient();
    if (!client) throw new Error(GOOGLE_NOT_CONFIGURED);
    const [expected = '', verifier = '', payloadRaw = ''] = (input.cookie ?? '').split('.');
    if (
      !input.code ||
      !input.state ||
      !expected ||
      !verifier ||
      !sameText(input.state, expected)
    ) {
      throw new Error('Invalid or expired Google Cloud connect state. Start Connect Google Cloud again.');
    }
    const payload = decodeStatePayload(payloadRaw);
    // The redirect back from Google is a plain navigation, so this request
    // acts in whichever workspace the account has selected *now*. If that
    // changed since the connect began (another tab, during the consent
    // screen), storing here would put this person's Google grant in a
    // workspace they did not choose — one whose other members could then use
    // it. Checked before the code is exchanged, so nothing is spent.
    if (!payload.workspaceId || payload.workspaceId !== scope.workspaceId) {
      throw new Error(
        'The selected workspace changed while connecting Google Cloud. Start Connect Google Cloud again in the workspace you want.'
      );
    }
    const mayReplace = input.mayReplace === true;
    await this.assertNameFree(scope, (payload.name || GCP_OAUTH_DEFAULT_NAME).trim(), mayReplace);
    const tokens = await exchangeGcpAuthCode({
      client,
      code: input.code,
      redirectUri: await this.redirectUri(req),
      codeVerifier: verifier,
    });
    return this.storeOAuthCredential(scope, payload.name, tokens, { mayReplace });
  }

  /**
   * Stores the refresh token under `nameRaw`. A name already in use is
   * replaced only when it is a Google Cloud connection and `mayReplace` is
   * set (see `assertNameFree`); otherwise this throws and stores nothing.
   */
  async storeOAuthCredential(
    scope: WorkspaceScope,
    nameRaw: string,
    tokens: { refreshToken: string; email?: string },
    opts: { mayReplace?: boolean } = {}
  ): Promise<CloudProviderCredentialSummary> {
    const name = (nameRaw || GCP_OAUTH_DEFAULT_NAME).trim();
    const credentials: GcpProviderCredentials = {
      auth: 'oauth',
      refreshToken: tokens.refreshToken,
      ...(tokens.email ? { email: tokens.email } : {}),
    };
    const existing = await this.assertNameFree(scope, name, opts.mayReplace === true);
    if (!existing) return this.providers.create(scope, name, 'gcp', credentials);
    const updated = await this.providers.update(scope, existing.id, { credentials });
    if (!updated) throw new Error('Cloud credential not found');
    return updated;
  }

  /**
   * The Google Cloud access a Google sign-in brought (an admin turned that
   * on), saved as "Google Cloud" in the person's personal workspace. Only
   * when that name is free: a connection the person made themselves, or any
   * other credential of that name, is left as it is.
   */
  async connectAtSignIn(
    scope: WorkspaceScope,
    tokens: { refreshToken: string; email?: string }
  ): Promise<'connected' | 'kept'> {
    const taken = (await this.providers.list(scope)).some((c) => c.name === GCP_OAUTH_DEFAULT_NAME);
    if (taken) return 'kept';
    await this.storeOAuthCredential(scope, GCP_OAUTH_DEFAULT_NAME, tokens);
    return 'connected';
  }

  async ensureGcpAccessToken(creds: GcpProviderCredentials): Promise<GcpProviderCredentials> {
    if (isGcpOAuthCredentials(creds) && creds.refreshToken?.trim()) {
      const client = await this.googleClient();
      if (!client) throw new Error(GOOGLE_NOT_CONFIGURED);
      const accessToken = await refreshGcpAccessToken(creds.refreshToken.trim(), client);
      return { ...creds, accessToken };
    }
    if (creds.accessToken?.trim()) return creds;
    if (creds.serviceAccountJson?.trim()) {
      const classified = classifyGcpCredentialJson(creds.serviceAccountJson);
      if (classified.kind === 'wif') {
        const accessToken = await mintGcpWifAccessToken(classified.config);
        return { ...creds, accessToken, projectId: creds.projectId?.trim() };
      }
      const accessToken = await mintGcpServiceAccountAccessToken(classified.key);
      return {
        ...creds,
        accessToken,
        projectId: creds.projectId?.trim() || classified.key.project_id,
      };
    }
    throw new Error(
      'GCP credential has no OAuth refresh token, access token, or Workload Identity Federation config'
    );
  }

  private async accessTokenFor(
    scope: WorkspaceScope,
    id: string
  ): Promise<{ creds: GcpProviderCredentials; token: string }> {
    const row = await this.providers.getDecryptedById(scope, id);
    if (!row) throw new Error('Cloud credential not found');
    if (row.provider !== 'gcp') {
      throw new Error(`Cloud credential is for ${row.provider}, not Google Cloud`);
    }
    const gcp = row.credentials as GcpProviderCredentials;
    const withToken = await this.ensureGcpAccessToken(gcp);
    const token = withToken.accessToken?.trim() ?? '';
    if (!token) throw new Error('Could not mint a Google Cloud access token');
    return { creds: withToken, token };
  }

  async listProjects(scope: WorkspaceScope, credentialId: string): Promise<GcpProjectSummary[]> {
    const { creds, token } = await this.accessTokenFor(scope, credentialId);
    const listed = await listGcpProjects(token);
    if (listed.length > 0) return listed;
    const fallback = creds.projectId?.trim();
    return fallback ? [{ id: fallback, name: fallback }] : [];
  }

  async listSecrets(
    scope: WorkspaceScope,
    credentialId: string,
    projectId: string
  ): Promise<GcpSecretSummary[]> {
    const { creds, token } = await this.accessTokenFor(scope, credentialId);
    const project = projectId.trim() || creds.projectId?.trim() || '';
    if (!project) throw new Error('GCP project id is required');
    return listGcpSecrets(token, project);
  }

  async listVersions(
    scope: WorkspaceScope,
    credentialId: string,
    secretId: string,
    projectId: string
  ): Promise<GcpSecretVersionSummary[]> {
    const { creds, token } = await this.accessTokenFor(scope, credentialId);
    const project = projectId.trim() || creds.projectId?.trim() || '';
    if (!project) throw new Error('GCP project id is required');
    return listGcpSecretVersions(token, project, secretId);
  }

  async disconnect(scope: WorkspaceScope, id: string): Promise<boolean> {
    const row = await this.providers.getDecryptedById(scope, id);
    if (!row) return false;
    if (row.provider === 'gcp') {
      const gcp = row.credentials as GcpProviderCredentials;
      const token = gcp.refreshToken?.trim();
      if (token) {
        try {
          await revokeGcpToken(token);
        } catch {
          // Still delete the named credential so the user can reconnect.
        }
      }
    }
    return this.providers.remove(scope, id);
  }
}

export function readGcpOAuthStateCookie(req: AppRequest): string | undefined {
  return readCookie(req, GCP_OAUTH_STATE_COOKIE);
}
