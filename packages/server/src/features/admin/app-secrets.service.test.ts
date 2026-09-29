import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule } from '../auth/auth.service';
import { AppSecretsStore } from './app-secrets.service';
import { getStore } from '../../database/store';
import * as cloudSecrets from '../../internal/cloud-secrets';

const auth = new AuthModule();
const store = new AppSecretsStore();

let alice: string;
let bob: string;

beforeAll(async () => {
  alice = (await auth.createUser('alice-secrets@example.com', 'password123', 'viewer')).id;
  bob = (await auth.createUser('bob-secrets@example.com', 'password123', 'viewer')).id;
});

describe('AppSecretsStore', () => {
  it('creates and lists a local secret without exposing the value', async () => {
    await store.create(alice, { name: 'apiToken', source: 'local', value: 'shh-secret' });
    const list = await store.list(alice);
    const hit = list.find((s) => s.name === 'apiToken');
    expect(hit).toMatchObject({ source: 'local', hasValue: true });
    expect(JSON.stringify(list)).not.toContain('shh-secret');
  });

  it('resolve decrypts local secrets for the owner only', async () => {
    await store.create(alice, { name: 'dbPass', source: 'local', value: 's3cret' });
    const mine = await store.resolve(alice, ['dbPass']);
    expect(mine.secrets.dbPass).toBe('s3cret');
    expect(mine.errors).toEqual({});

    const theirs = await store.resolve(bob, ['dbPass']);
    expect(theirs.secrets.dbPass).toBeUndefined();
  });

  it('stores encrypted_value not plaintext', async () => {
    await store.create(bob, { name: 'tok', source: 'local', value: 'plain-token' });
    const db = await getStore();
    const rows = await db.all<{ encrypted_value: string | null }>(
      'SELECT encrypted_value FROM app_secrets WHERE name = ?',
      ['tok']
    );
    expect(rows[0]?.encrypted_value).toBeTruthy();
    expect(rows[0]!.encrypted_value!).not.toContain('plain-token');
  });

  it('creates cloud refs and resolves via adapter', async () => {
    const spy = vi.spyOn(cloudSecrets, 'resolveCloudSecret').mockResolvedValue('from-aws');
    const created = await store.create(alice, {
      name: 'awsTok',
      source: 'aws',
      cloudRef: { secretId: 'prod/api', region: 'us-east-1' },
    });
    expect(created.cloudRef).toEqual({ secretId: 'prod/api', region: 'us-east-1' });
    expect(JSON.stringify(created)).not.toContain('from-aws');

    const out = await store.resolve(alice, ['awsTok']);
    expect(out.secrets.awsTok).toBe('from-aws');
    expect(spy).toHaveBeenCalledWith(
      'aws',
      expect.objectContaining({ secretId: 'prod/api', region: 'us-east-1' }),
      undefined
    );
    spy.mockRestore();
  });

  it('isolates secrets per user and supports delete', async () => {
    const created = await store.create(alice, { name: 'onlyAlice', source: 'local', value: 'x' });
    expect(await store.remove(bob, created.id)).toBe(false);
    expect(await store.remove(alice, created.id)).toBe(true);
    const list = await store.list(alice);
    expect(list.find((s) => s.id === created.id)).toBeUndefined();
  });

  it('records cloud resolve errors without dropping sibling locals', async () => {
    await store.create(alice, { name: 'okLocal', source: 'local', value: 'yes' });
    await store.create(alice, {
      name: 'badCloud',
      source: 'gcp',
      cloudRef: { secretId: 'projects/p/secrets/s' },
    });
    const spy = vi
      .spyOn(cloudSecrets, 'resolveCloudSecret')
      .mockRejectedValue(new Error('ADC missing'));
    const out = await store.resolve(alice, ['okLocal', 'badCloud']);
    expect(out.secrets.okLocal).toBe('yes');
    expect(out.errors.badCloud).toMatch(/ADC missing/);
    spy.mockRestore();
  });
});
