import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule, type AuthUser } from '../../platform/identity/auth.service';
import type { WorkspaceScope } from '../../platform/http/scope';
import { CloudProviderCredentialsStore } from './cloud-provider-credentials.service';
import { getStore } from '../../database/store';

const auth = new AuthModule();

/** The account's own workspace, which its rows now belong to. */
const scopeFor = async (user: AuthUser): Promise<WorkspaceScope> => ({
  userId: user.id,
  workspaceId: (await auth.inWorkspace(user, undefined)).workspace.id,
});
const store = new CloudProviderCredentialsStore();

let alice: WorkspaceScope;

beforeAll(async () => {
  alice = await scopeFor(await auth.createUser('alice-cloud-creds@example.com', 'correct-horse-9', 'viewer'));
});

describe('CloudProviderCredentialsStore', () => {
  it('creates named AWS credentials without exposing secrets', async () => {
    const before = await store.list(alice);
    expect(before).toHaveLength(0);

    const saved = await store.create(alice, 'Prod AWS', 'aws', {
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-key',
      region: 'us-west-2',
    });
    expect(saved.name).toBe('Prod AWS');
    expect(saved.provider).toBe('aws');
    expect(JSON.stringify(saved)).not.toContain('super-secret-key');

    const decrypted = await store.getDecryptedById(alice, saved.id);
    expect(decrypted?.credentials).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-key',
      region: 'us-west-2',
    });

    const db = await getStore();
    const rows = await db.all<{ encrypted_config: string }>(
      'SELECT encrypted_config FROM cloud_provider_credentials'
    );
    for (const r of rows) expect(r.encrypted_config).not.toContain('super-secret-key');
  });

  it('allows multiple named credentials and removes by id', async () => {
    await store.create(alice, 'GCP Dev', 'gcp', {
      serviceAccountJson: JSON.stringify({
        type: 'external_account',
        audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        credential_source: { file: '/var/run/secrets/token' },
      }),
      projectId: 'p',
    });
    await store.create(alice, 'GCP Staging', 'gcp', {
      accessToken: 'ya29.token',
    });
    const listed = await store.list(alice);
    expect(listed.filter((c) => c.provider === 'gcp').length).toBeGreaterThanOrEqual(2);

    const gcp = listed.find((c) => c.name === 'GCP Dev');
    expect(gcp).toBeTruthy();
    expect(await store.remove(alice, gcp!.id)).toBe(true);
    expect(await store.getDecryptedById(alice, gcp!.id)).toBeNull();
  });

  it('stores a Workload Identity Federation config and refuses a downloaded service-account key', async () => {
    const saved = await store.create(alice, 'GCP WIF', 'gcp', {
      serviceAccountJson: JSON.stringify({
        type: 'external_account',
        audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: 'https://sts.googleapis.com/v1/token',
        credential_source: { file: '/var/run/secrets/token' },
      }),
      projectId: 'fox-prod',
    });
    expect(saved.auth).toBe('wif');
    const decrypted = await store.getDecryptedById(alice, saved.id);
    expect(decrypted?.credentials).toMatchObject({ projectId: 'fox-prod' });
    expect(JSON.stringify(saved)).not.toContain('private_key');

    await expect(
      store.create(alice, 'GCP Key', 'gcp', {
        serviceAccountJson: JSON.stringify({
          type: 'service_account',
          project_id: 'p',
          client_email: 'sa@p.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        }),
      })
    ).rejects.toThrow(/security risk/);
  });

  it('stores GCP OAuth refresh tokens encrypted and never returns them', async () => {
    const saved = await store.create(alice, 'GCP OAuth', 'gcp', {
      auth: 'oauth',
      refreshToken: '1//oauth-refresh',
      email: 'dev@example.com',
    });
    expect(saved).toMatchObject({ auth: 'oauth', email: 'dev@example.com' });
    expect(JSON.stringify(saved)).not.toContain('1//oauth-refresh');
    const listed = await store.list(alice);
    expect(JSON.stringify(listed)).not.toContain('1//oauth-refresh');
    const decrypted = await store.getDecryptedById(alice, saved.id);
    expect(decrypted?.credentials).toMatchObject({
      auth: 'oauth',
      refreshToken: '1//oauth-refresh',
    });
  });
});
