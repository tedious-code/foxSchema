import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule } from '../auth/auth.service';
import { CloudProviderCredentialsStore } from './cloud-provider-credentials.service';
import { getStore } from '../../database/store';

const auth = new AuthModule();
const store = new CloudProviderCredentialsStore();

let alice: string;

beforeAll(async () => {
  alice = (await auth.createUser('alice-cloud-creds@example.com', 'password123', 'viewer')).id;
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
      serviceAccountJson: JSON.stringify({ type: 'service_account', project_id: 'p' }),
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
});
