import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// An isolated in-memory metadata DB, before anything calls getStore().
process.env.APP_DB_PATH = ':memory:';

import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { RbacModule } from './rbac.service';
import { AuthModule } from '../identity/auth.service';
import {
  ADMIN_POLICY_KEY,
  AdminPolicyError,
  backfillAdminPolicy,
  readAdminPolicy,
  writeAdminPolicy,
} from './admin-policy.service';

const rbac = new RbacModule();
const auth = new AuthModule();

async function addUser(email: string, role: string, active = true): Promise<string> {
  const store = await getStore();
  const id = randomUUID();
  await store.run(
    'INSERT INTO users (id, email, password_hash, created_at, app_role, active) VALUES (?, ?, ?, ?, ?, ?)',
    [id, email, 'x', new Date().toISOString(), role, active ? 1 : 0]
  );
  return id;
}

async function roleOf(id: string): Promise<string | undefined> {
  const store = await getStore();
  return (await store.get<{ app_role: string }>('SELECT app_role FROM users WHERE id = ?', [id]))?.app_role;
}

async function setPolicy(value: 'one' | 'several' | null): Promise<void> {
  const store = await getStore();
  await store.run('DELETE FROM app_settings WHERE "key" = ?', [ADMIN_POLICY_KEY]);
  if (value) await writeAdminPolicy(store, value);
}

beforeEach(async () => {
  const store = await getStore();
  await store.run('DELETE FROM sessions');
  await store.run('DELETE FROM auth_codes');
  await store.run('DELETE FROM users');
  await store.run('DELETE FROM app_settings WHERE "key" = ?', [ADMIN_POLICY_KEY]);
  delete process.env.FOX_ADMIN_POLICY;
});

afterEach(() => {
  delete process.env.FOX_ADMIN_POLICY;
});

describe('the default admin policy', () => {
  it('is one for an install with no admin yet (a new install)', async () => {
    const store = await getStore();
    await backfillAdminPolicy(store);
    expect(await readAdminPolicy(store)).toEqual({ value: 'one', source: 'app' });
  });

  it('is one for an install with a single admin', async () => {
    const store = await getStore();
    await addUser('only@example.com', 'admin');
    await addUser('viewer@example.com', 'viewer');
    await backfillAdminPolicy(store);
    expect((await readAdminPolicy(store)).value).toBe('one');
  });

  it('is several for an install that already has more than one active admin', async () => {
    const store = await getStore();
    await addUser('a@example.com', 'admin');
    await addUser('b@example.com', 'admin');
    await backfillAdminPolicy(store);
    expect((await readAdminPolicy(store)).value).toBe('several');
  });

  it('does not count an inactive admin', async () => {
    const store = await getStore();
    await addUser('a@example.com', 'admin');
    await addUser('gone@example.com', 'admin', false);
    await backfillAdminPolicy(store);
    expect((await readAdminPolicy(store)).value).toBe('one');
  });

  it('is recorded once: a later backfill leaves the chosen value alone', async () => {
    const store = await getStore();
    await setPolicy('several');
    await backfillAdminPolicy(store);
    expect((await readAdminPolicy(store)).value).toBe('several');
  });

  it('reads as several before anything is recorded, as installs behaved before the setting', async () => {
    expect(await readAdminPolicy(await getStore())).toEqual({ value: 'several', source: null });
  });

  it('FOX_ADMIN_POLICY wins over the stored value, and makes it read-only', async () => {
    const store = await getStore();
    await setPolicy('several');
    process.env.FOX_ADMIN_POLICY = 'one';
    expect(await readAdminPolicy(store)).toEqual({ value: 'one', source: 'env' });
    await expect(writeAdminPolicy(store, 'several')).rejects.toThrow(/FOX_ADMIN_POLICY/);
  });
});

describe('with one admin allowed', () => {
  beforeEach(async () => {
    await addUser('admin@example.com', 'admin');
    await setPolicy('one');
  });

  it('refuses adding an account as admin', async () => {
    await expect(auth.inviteUser('second@example.com', 'admin')).rejects.toBeInstanceOf(AdminPolicyError);
    const store = await getStore();
    expect(await store.get('SELECT id FROM users WHERE email = ?', ['second@example.com'])).toBeUndefined();
  });

  it('still adds accounts with any other role', async () => {
    const { user } = await auth.inviteUser('editor@example.com', 'editor');
    expect(user.role).toBe('editor');
  });

  it('refuses promoting an account to admin', async () => {
    const id = await addUser('owner@example.com', 'owner');
    await expect(rbac.setUserRole(id, 'admin')).rejects.toThrow(/allows one admin, and admin@example.com/);
    expect(await roleOf(id)).toBe('owner');
  });

  it('refuses reactivating an old admin while another is active', async () => {
    const id = await addUser('old-admin@example.com', 'admin', false);
    await expect(rbac.setUserActive(id, true)).rejects.toBeInstanceOf(AdminPolicyError);
  });

  it('lets the admin keep its own role and re-save it', async () => {
    const store = await getStore();
    const admin = await store.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['admin@example.com']);
    await expect(rbac.setUserRole(admin!.id, 'admin')).resolves.toBeUndefined();
    await expect(rbac.setUserActive(admin!.id, true)).resolves.toBeUndefined();
  });

  it('re-saving Active on an active admin is a no-op, even with several forced to one', async () => {
    const store = await getStore();
    const second = await addUser('second@example.com', 'admin');
    process.env.FOX_ADMIN_POLICY = 'one';
    await expect(rbac.setUserActive(second, true)).resolves.toBeUndefined();
    await store.run('DELETE FROM users WHERE id = ?', [second]);
  });

  it('allows a new admin once the old one is not active', async () => {
    const store = await getStore();
    await store.run("UPDATE users SET active = 0 WHERE email = 'admin@example.com'");
    const { user } = await auth.inviteUser('next@example.com', 'admin');
    expect(user.role).toBe('admin');
  });
});

describe('with several admins allowed', () => {
  it('adds, promotes and reactivates admins as before', async () => {
    await addUser('admin@example.com', 'admin');
    await setPolicy('several');
    const { user } = await auth.inviteUser('second@example.com', 'admin');
    expect(user.role).toBe('admin');
    const owner = await addUser('owner@example.com', 'owner');
    await rbac.setUserRole(owner, 'admin');
    expect(await roleOf(owner)).toBe('admin');
    const old = await addUser('old@example.com', 'admin', false);
    await rbac.setUserActive(old, true);
  });
});

describe('switching to one admin', () => {
  it('is refused while several admins are active, naming them', async () => {
    await addUser('a@example.com', 'admin');
    await addUser('b@example.com', 'admin');
    await setPolicy('several');
    const store = await getStore();
    await expect(writeAdminPolicy(store, 'one')).rejects.toThrow(/2 active admins \(a@example.com, b@example.com\)/);
    expect((await readAdminPolicy(store)).value).toBe('several');
  });

  it('is allowed with one active admin', async () => {
    await addUser('a@example.com', 'admin');
    await addUser('gone@example.com', 'admin', false);
    await setPolicy('several');
    const store = await getStore();
    await writeAdminPolicy(store, 'one');
    expect((await readAdminPolicy(store)).value).toBe('one');
  });
});

describe('transferAdmin', () => {
  let adminId: string;
  let ownerId: string;

  beforeEach(async () => {
    adminId = await addUser('admin@example.com', 'admin');
    ownerId = await addUser('owner@example.com', 'owner');
    await setPolicy('one');
  });

  it('makes the target the admin and the caller an owner, under the one-admin policy', async () => {
    await rbac.transferAdmin(adminId, ownerId);
    expect(await roleOf(ownerId)).toBe('admin');
    expect(await roleOf(adminId)).toBe('owner');
  });

  it('takes the role the previous admin asked for', async () => {
    await rbac.transferAdmin(adminId, ownerId, 'viewer');
    expect(await roleOf(adminId)).toBe('viewer');
  });

  it('never leaves both accounts as admin, or neither', async () => {
    await rbac.transferAdmin(adminId, ownerId);
    const store = await getStore();
    const admins = await store.all<{ id: string }>("SELECT id FROM users WHERE app_role = 'admin'");
    expect(admins.map((a) => a.id)).toEqual([ownerId]);
  });

  it('refuses a caller that is not an active admin', async () => {
    await expect(rbac.transferAdmin(ownerId, adminId)).rejects.toThrow(/Only an active admin/);
    expect(await roleOf(adminId)).toBe('admin');
  });

  it('refuses an inactive target', async () => {
    const gone = await addUser('gone@example.com', 'viewer', false);
    await expect(rbac.transferAdmin(adminId, gone)).rejects.toThrow(/Activate the account/);
    expect(await roleOf(adminId)).toBe('admin');
  });

  it('refuses an unknown target, itself, and keeping the admin role', async () => {
    await expect(rbac.transferAdmin(adminId, randomUUID())).rejects.toThrow(/not found/);
    await expect(rbac.transferAdmin(adminId, adminId)).rejects.toThrow(/another account/);
    await expect(rbac.transferAdmin(adminId, ownerId, 'admin')).rejects.toThrow(/other than admin/);
    expect(await roleOf(adminId)).toBe('admin');
    expect(await roleOf(ownerId)).toBe('owner');
  });
});
