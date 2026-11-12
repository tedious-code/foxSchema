/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/credentials/providers.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildStoredSecret,
  expandSecretString,
  parseStoredSecret,
  resolveStoredSecret,
} from './providers.js';
import { InMemoryCredentialStore } from './store.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

describe('secret providers', () => {
  it('builds local and env payloads', () => {
    expect(buildStoredSecret('local', { password: 'x' })).toEqual({
      source: 'local',
      values: { password: 'x' },
    });
    expect(
      buildStoredSecret('env', { password: 'DB_PASSWORD', user: 'DB_USER' }),
    ).toEqual({
      source: 'env',
      mapping: { password: 'DB_PASSWORD', user: 'DB_USER' },
    });
  });

  it('treats legacy blobs as local values', () => {
    expect(parseStoredSecret({ bearerToken: 'abc' })).toEqual({
      source: 'local',
      values: { bearerToken: 'abc' },
    });
  });

  it('expands JSON and text remote secrets', () => {
    expect(expandSecretString('{"apiKey":"k"}', { format: 'json' })).toEqual({
      apiKey: 'k',
    });
    expect(
      expandSecretString('plain', { format: 'text', valueKey: 'secret' }),
    ).toEqual({ secret: 'plain' });
  });

  it('resolves env mappings', async () => {
    const resolved = await resolveStoredSecret(
      {
        source: 'env',
        mapping: { bearerToken: 'TOKEN_A', apiKey: 'KEY_B' },
      },
      { TOKEN_A: 'tok', KEY_B: 'key' },
    );
    expect(resolved).toEqual({ bearerToken: 'tok', apiKey: 'key' });
  });

  it('fails when env vars are missing', async () => {
    await expect(
      resolveStoredSecret(
        { source: 'env', mapping: { password: 'MISSING' } },
        {},
      ),
    ).rejects.toThrow(/MISSING/);
  });

  it('resolves GCP secrets via access API', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        payload: { data: Buffer.from('{"bearerToken":"from-gcp"}').toString('base64') },
      }),
    ) as unknown as typeof fetch;

    const resolved = await resolveStoredSecret(
      {
        source: 'gcp',
        projectId: 'p1',
        secretId: 's1',
        version: 'latest',
        format: 'json',
      },
      { GOOGLE_ACCESS_TOKEN: 'tok' },
      fetchImpl,
    );
    expect(resolved).toEqual({ bearerToken: 'from-gcp' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://secretmanager.googleapis.com/v1/projects/p1/secrets/s1/versions/latest:access',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('stores a GCP service-account JSON and mints a token to fetch the secret', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const sa = {
      type: 'service_account',
      project_id: 'p1',
      client_email: 'sa@p1.iam.gserviceaccount.com',
      private_key: pem,
    };
    const stored = buildStoredSecret('gcp', {
      secretId: 'api-token',
      serviceAccountJson: JSON.stringify(sa),
      format: 'json',
    });
    expect(stored.projectId).toBe('p1');
    expect(stored.serviceAccountJson).toContain('BEGIN PRIVATE KEY');

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'minted' });
      }
      expect(String(url)).toBe(
        'https://secretmanager.googleapis.com/v1/projects/p1/secrets/api-token/versions/latest:access',
      );
      return Response.json({
        payload: { data: Buffer.from('{"bearerToken":"from-sa"}').toString('base64') },
      });
    }) as unknown as typeof fetch;

    const resolved = await resolveStoredSecret(stored, {}, fetchImpl);
    expect(resolved).toEqual({ bearerToken: 'from-sa' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stores a Workload Identity Federation config and does not mint from a downloaded key', async () => {
    const wif = {
      type: 'external_account',
      audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      credential_source: { file: '/var/run/secrets/token' },
    };
    const stored = buildStoredSecret('gcp', {
      projectId: 'p1',
      secretId: 'api-token',
      serviceAccountJson: JSON.stringify(wif),
      format: 'json',
    });
    expect(stored.projectId).toBe('p1');
    expect(stored.serviceAccountJson).toContain('external_account');
    expect(stored.serviceAccountJson).not.toContain('private_key');

    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(resolveStoredSecret(stored, {}, fetchImpl)).rejects.toThrow(
      /Workload Identity Federation|Do not download a service account key/,
    );
  });

  it('resolves AWS Secrets Manager secrets', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        SecretId?: string;
      };
      expect(body.SecretId).toBe('prod/api');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
      return Response.json({
        SecretString: JSON.stringify({ apiKey: 'from-aws' }),
      });
    }) as unknown as typeof fetch;

    const resolved = await resolveStoredSecret(
      {
        source: 'aws',
        secretId: 'prod/api',
        region: 'us-west-2',
        format: 'json',
      },
      {
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        AWS_SECRET_ACCESS_KEY: 'secretkey',
        AWS_REGION: 'us-west-2',
      },
      fetchImpl,
    );
    expect(resolved).toEqual({ apiKey: 'from-aws' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://secretsmanager.us-west-2.amazonaws.com/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resolves Azure Key Vault secrets', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('login.microsoftonline.com')) {
        return Response.json({ access_token: 'vault-tok' });
      }
      return Response.json({ value: '{"secret":"shared"}' });
    }) as unknown as typeof fetch;

    const resolved = await resolveStoredSecret(
      {
        source: 'azure',
        vaultUrl: 'https://demo.vault.azure.net',
        secretName: 'webhook',
        format: 'json',
      },
      {
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_ID: 'c',
        AZURE_CLIENT_SECRET: 's',
      },
      fetchImpl,
    );
    expect(resolved).toEqual({ secret: 'shared' });
  });

  it('upserts a stable credential id on create', async () => {
    const store = new InMemoryCredentialStore(randomBytes(32));
    const first = await store.create({
      id: 'google-oauth',
      name: 'Google OAuth',
      kind: 'http',
      data: { refreshToken: 'r1', clientId: 'c', clientSecret: 's' },
    });
    expect(first.id).toBe('google-oauth');
    const second = await store.create({
      id: 'google-oauth',
      name: 'Google OAuth (updated)',
      kind: 'http',
      data: { refreshToken: 'r2', clientId: 'c2', clientSecret: 's2' },
    });
    expect(second.id).toBe('google-oauth');
    expect(second.name).toBe('Google OAuth (updated)');
    expect(second.createdAt).toBe(first.createdAt);
    expect(await store.list()).toHaveLength(1);
    expect(await store.revealSecret('google-oauth')).toEqual({
      refreshToken: 'r2',
      clientId: 'c2',
      clientSecret: 's2',
    });
  });

  it('reveals local and env credentials from the store', async () => {
    const store = new InMemoryCredentialStore(randomBytes(32));
    const local = await store.create({
      name: 'local-http',
      kind: 'http',
      source: 'local',
      data: { bearerToken: 'abc' },
    });
    expect(local.source).toBe('local');
    expect(await store.revealSecret(local.id)).toEqual({ bearerToken: 'abc' });

    process.env.FOXFLOW_TEST_TOKEN = 'from-env';
    const envCred = await store.create({
      name: 'env-http',
      kind: 'http',
      source: 'env',
      data: { bearerToken: 'FOXFLOW_TEST_TOKEN' },
    });
    expect(envCred.source).toBe('env');
    expect(await store.revealSecret(envCred.id)).toEqual({
      bearerToken: 'from-env',
    });
    delete process.env.FOXFLOW_TEST_TOKEN;
  });

  it('stores updateSecret overlay on remote credentials', async () => {
    const store = new InMemoryCredentialStore(randomBytes(32));
    process.env.FOXFLOW_TEST_TOKEN = 'base';
    const cred = await store.create({
      name: 'env-overlay',
      kind: 'http',
      source: 'env',
      data: { bearerToken: 'FOXFLOW_TEST_TOKEN' },
    });
    await store.updateSecret(cred.id, { cookies: 'a=b' });
    expect(await store.revealSecret(cred.id)).toEqual({
      bearerToken: 'base',
      cookies: 'a=b',
    });
    delete process.env.FOXFLOW_TEST_TOKEN;
  });
});
