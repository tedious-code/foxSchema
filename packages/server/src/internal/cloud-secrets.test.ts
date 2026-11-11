import { describe, expect, it } from 'vitest';
import {
  assertAzureVaultUrl,
  allowHostCloudCredentials,
  assertGcpJsonAllowedForStore,
  classifyGcpCredentialJson,
  GCP_AVOID_SA_KEYS,
  isGcpOAuthCredentials,
  normalizeGcpSecretResource,
  parseCloudRef,
  parseGcpServiceAccountJson,
  serializeCloudRef,
} from './cloud-secrets';

describe('cloud-secrets ref helpers', () => {
  it('round-trips cloud ref JSON', () => {
    const ref = { secretId: 'arn:aws:secretsmanager:…:secret:x', region: 'eu-west-1' };
    expect(parseCloudRef(serializeCloudRef(ref))).toEqual(ref);
  });

  it('rejects empty or invalid JSON', () => {
    expect(parseCloudRef(null)).toBeNull();
    expect(parseCloudRef('{}')).toBeNull();
    expect(parseCloudRef('not-json')).toBeNull();
  });
});

describe('assertAzureVaultUrl', () => {
  it('accepts public and sovereign Key Vault hostnames', () => {
    expect(() => assertAzureVaultUrl('https://myvault.vault.azure.net/')).not.toThrow();
    expect(() => assertAzureVaultUrl('https://myvault.vault.azure.cn')).not.toThrow();
    expect(() =>
      assertAzureVaultUrl('https://myvault.vault.usgovcloudapi.net/secrets')
    ).not.toThrow();
  });

  it('rejects SSRF-prone URLs', () => {
    expect(() => assertAzureVaultUrl('http://myvault.vault.azure.net/')).toThrow(/HTTPS/);
    expect(() => assertAzureVaultUrl('https://evil.example/')).toThrow(/hostname/);
    expect(() => assertAzureVaultUrl('https://127.0.0.1/')).toThrow();
    expect(() => assertAzureVaultUrl('https://169.254.169.254/')).toThrow();
    expect(() => assertAzureVaultUrl('https://attacker.vault.azure.net.evil.com/')).toThrow(
      /hostname/
    );
    expect(() => assertAzureVaultUrl('https://user:pass@myvault.vault.azure.net/')).toThrow(
      /credentials/
    );
  });
});

const saKeyJson = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-proj',
  client_email: 'sa@demo-proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', // gitleaks:allow (fake key: the body is 'abc')
});

const wifJson = JSON.stringify({
  type: 'external_account',
  audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: { file: '/var/run/secrets/token' },
});

describe('GCP service-account JSON and secret names', () => {
  it('parses an IAM service-account key and rejects other JSON', () => {
    expect(parseGcpServiceAccountJson(saKeyJson)).toMatchObject({
      project_id: 'demo-proj',
      client_email: 'sa@demo-proj.iam.gserviceaccount.com',
    });
    expect(() => parseGcpServiceAccountJson('{"type":"authorized_user"}')).toThrow(
      /service_account/
    );
    expect(() => parseGcpServiceAccountJson('{')).toThrow(/valid JSON/);
  });

  it('refuses a Workload Identity Federation config whose token file this install has not listed', () => {
    // Pasted configs are user input: unlisted, the server reads no file for them.
    delete process.env.FOX_GCP_WIF_TOKEN_FILES;
    expect(() => classifyGcpCredentialJson(wifJson)).toThrow(/does not allow reading a subject token/);
    expect(() => assertGcpJsonAllowedForStore(wifJson)).toThrow(/FOX_GCP_WIF_TOKEN_FILES/);
    const exfil = JSON.stringify({
      ...JSON.parse(wifJson),
      token_url: 'https://attacker.example/sts',
      credential_source: { file: '/proc/self/environ' },
    });
    expect(() => assertGcpJsonAllowedForStore(exfil)).toThrow(/token_url must be https:\/\/sts\.googleapis\.com/);
  });

  it('classifies Workload Identity Federation config and refuses storing a downloaded key', () => {
    process.env.FOX_GCP_WIF_TOKEN_FILES = '/var/run/secrets/token';
    expect(classifyGcpCredentialJson(wifJson)).toMatchObject({ kind: 'wif' });
    expect(assertGcpJsonAllowedForStore(wifJson)).toEqual({ kind: 'wif' });
    expect(classifyGcpCredentialJson(saKeyJson).kind).toBe('service_account');
    expect(() => assertGcpJsonAllowedForStore(saKeyJson)).toThrow(GCP_AVOID_SA_KEYS);
    expect(() => classifyGcpCredentialJson('{"type":"authorized_user"}')).toThrow(
      /security risk|external_account/
    );
  });

  it('expands a short secret name and keeps a full resource path', () => {
    expect(normalizeGcpSecretResource('api-token', 'demo-proj')).toBe(
      'projects/demo-proj/secrets/api-token/versions/latest'
    );
    expect(
      normalizeGcpSecretResource('projects/demo-proj/secrets/api-token', undefined, '3')
    ).toBe('projects/demo-proj/secrets/api-token/versions/3');
    expect(() => normalizeGcpSecretResource('api-token')).toThrow(/project id/);
  });

  it('treats a refresh token as OAuth credentials, not a JSON key', () => {
    expect(isGcpOAuthCredentials({ auth: 'oauth', refreshToken: '1//x' })).toBe(true);
    expect(isGcpOAuthCredentials({ serviceAccountJson: '{}' })).toBe(false);
    expect(isGcpOAuthCredentials({ accessToken: 'ya29.x' })).toBe(false);
  });
});

describe('allowHostCloudCredentials', () => {
  it('defaults to allowed (single-user)', () => {
    const prevLocal = process.env.LOCAL_SINGLE_USER;
    const prevAllow = process.env.ALLOW_HOST_CLOUD_CREDENTIALS;
    delete process.env.LOCAL_SINGLE_USER;
    delete process.env.ALLOW_HOST_CLOUD_CREDENTIALS;
    expect(allowHostCloudCredentials()).toBe(true);
    process.env.LOCAL_SINGLE_USER = 'false';
    expect(allowHostCloudCredentials()).toBe(false);
    process.env.ALLOW_HOST_CLOUD_CREDENTIALS = 'true';
    expect(allowHostCloudCredentials()).toBe(true);
    if (prevLocal === undefined) delete process.env.LOCAL_SINGLE_USER;
    else process.env.LOCAL_SINGLE_USER = prevLocal;
    if (prevAllow === undefined) delete process.env.ALLOW_HOST_CLOUD_CREDENTIALS;
    else process.env.ALLOW_HOST_CLOUD_CREDENTIALS = prevAllow;
  });
});
