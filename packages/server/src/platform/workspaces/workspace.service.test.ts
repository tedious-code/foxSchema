import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { randomUUID } from 'node:crypto';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '@foxschema/shared';
import { getStore } from '../../database/store';
import { createMetadataStore } from '../../database/stores/registry';
import { runMigrations } from '../../database/schema';
import { AuthModule, type AuthUser } from '../identity/auth.service';
import { RbacModule } from '../authorization/rbac.service';
import { writeAdminPolicy } from '../authorization/admin-policy.service';
import { ConnectionStore } from '../connections/connection-store.service';
import { AppSecretsStore } from '../../features/admin/app-secrets.service';
import { CloudProviderCredentialsStore } from '../../features/admin/cloud-provider-credentials.service';
import { MigrationHistoryStore } from '../../features/migration/migration-history.service';
import { DataMigrateHistoryStore } from '../../features/data-migrate/data-migrate-history.service';
import { LokeeWeaveStore } from '../../features/history/lokee-weave.service';
import { ServiceError } from '../contracts/actor';
import type { WorkspaceScope } from '../http/scope';
import {
  WORKSPACE_OWNED_TABLES,
  backfillWorkspaces,
  personalWorkspaceName,
  resolveWorkspace,
} from './workspace.service';

const auth = new AuthModule();
const rbac = new RbacModule();

// These tests make several admins; the one-admin rule has its own tests.
beforeAll(async () => {
  await writeAdminPolicy(await getStore(), 'several');
});

async function personalOf(userId: string): Promise<{ id: string; name: string; role: string }> {
  const store = await getStore();
  const row = await store.get<{ id: string; name: string; role: string }>(
    `SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
     WHERE w.personal_owner_id = ?`,
    [userId, userId]
  );
  if (!row) throw new Error(`no personal workspace for ${userId}`);
  return row;
}

/** A second workspace `user` belongs to, so isolation can be tested before sharing exists. */
async function otherWorkspace(userId: string): Promise<string> {
  const store = await getStore();
  const id = randomUUID();
  const now = new Date().toISOString();
  await store.run('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [id, 'Team', userId, now]);
  await store.run('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', [
    id,
    userId,
    'owner',
    now,
  ]);
  return id;
}

describe('personal workspaces', () => {
  it('are made with the account, named after it, with the account role (admin as owner)', async () => {
    const viewer = await auth.createUser('ana.viewer@example.com', 'correct-horse-9', 'viewer');
    const admin = await auth.createUser('ben.admin@example.com', 'correct-horse-9', 'editor');
    await rbac.setUserRole(admin.id, 'admin');
    expect(await personalOf(viewer.id)).toMatchObject({ name: "ana.viewer's workspace", role: 'viewer' });
    expect((await personalOf(admin.id)).role).toBe('owner');
  });

  it('follow account role changes', async () => {
    const user = await auth.createUser('cat@example.com', 'correct-horse-9', 'viewer');
    await rbac.setUserRole(user.id, 'editor');
    expect((await personalOf(user.id)).role).toBe('editor');
  });

  it('names a workspace for an email without a local part sensibly', () => {
    expect(personalWorkspaceName('@example.com')).toBe("My's workspace");
  });
});

describe('the request workspace', () => {
  let user: AuthUser;
  beforeAll(async () => {
    user = await auth.createUser('dee@example.com', 'correct-horse-9', 'editor');
  });

  it('defaults to the personal workspace', async () => {
    const ws = await resolveWorkspace(await getStore(), user, undefined);
    expect(ws).toMatchObject({ id: (await personalOf(user.id)).id, personal: true, role: 'editor' });
  });

  it('is the one asked for when the account is a member', async () => {
    const team = await otherWorkspace(user.id);
    expect((await resolveWorkspace(await getStore(), user, team)).id).toBe(team);
  });

  it('answers not found — never forbidden — for a workspace the account is not in', async () => {
    const stranger = await auth.createUser('eve@example.com', 'correct-horse-9', 'viewer');
    const theirs = (await personalOf(stranger.id)).id;
    await expect(resolveWorkspace(await getStore(), user, theirs)).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveWorkspace(await getStore(), user, randomUUID())).rejects.toBeInstanceOf(ServiceError);
  });

  it('remembers the last workspace used when none is asked for', async () => {
    const team = await otherWorkspace(user.id);
    const store = await getStore();
    await store.upsert(
      'user_preferences',
      ['user_id'],
      { user_id: user.id, last_workspace_id: team, updated_at: new Date().toISOString() },
      ['last_workspace_id']
    );
    expect((await resolveWorkspace(store, user, undefined)).id).toBe(team);
    await store.run('UPDATE workspaces SET archived_at = ? WHERE id = ?', [new Date().toISOString(), team]);
    expect((await resolveWorkspace(store, user, undefined)).personal).toBe(true);
  });

  it('grants a non-admin exactly its account role in its own workspace, and an admin everything', async () => {
    for (const role of ['viewer', 'editor', 'owner'] as const) {
      const u = await auth.createUser(`perm-${role}@example.com`, 'correct-horse-9', role);
      const { permissions } = await auth.inWorkspace(u, undefined);
      expect(new Set(permissions)).toEqual(new Set(DEFAULT_ROLE_PERMISSIONS[role]));
    }
    const a = await auth.createUser('perm-admin@example.com', 'correct-horse-9', 'editor');
    await rbac.setUserRole(a.id, 'admin');
    const { permissions } = await auth.inWorkspace({ ...a, role: 'admin', permissions: [...PERMISSIONS] }, undefined);
    expect(new Set(permissions)).toEqual(new Set(PERMISSIONS));
  });
});

describe('backfill on upgrade', () => {
  it('moves each account’s rows into its own workspace, keeps its role, and is safe to rerun', async () => {
    const meta = createMetadataStore({ engine: 'sqlite', path: ':memory:' });
    await meta.init();
    await runMigrations(meta);
    const now = new Date().toISOString();
    const users = [
      { id: 'u-viewer', email: 'v@example.com', role: 'viewer' },
      { id: 'u-admin', email: 'a@example.com', role: 'admin' },
    ];
    for (const u of users) {
      await meta.run('INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)', [
        u.id,
        u.email,
        'x',
        now,
        u.role,
      ]);
      // Rows written before workspaces: 'local' (connections) or NULL (the rest).
      await meta.run(
        'INSERT INTO connections (id, user_id, name, dialect, encrypted_config, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [`c-${u.id}`, u.id, 'db', 'sqlite', 'x', now]
      );
      await meta.run(
        'INSERT INTO migration_runs (id, user_id, status, dialect, started_at) VALUES (?, ?, ?, ?, ?)',
        [`r-${u.id}`, u.id, 'SUCCESS', 'sqlite', now]
      );
    }
    await backfillWorkspaces(meta);

    for (const u of users) {
      const ws = await meta.get<{ id: string; role: string }>(
        `SELECT w.id, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.personal_owner_id = ?`,
        [u.id]
      );
      expect(ws?.role).toBe(u.role === 'admin' ? 'owner' : u.role);
      for (const [table, id] of [['connections', `c-${u.id}`], ['migration_runs', `r-${u.id}`]] as const) {
        const row = await meta.get<{ workspace_id: string }>(`SELECT workspace_id FROM ${table} WHERE id = ?`, [id]);
        expect(row?.workspace_id, `${table} ${id}`).toBe(ws?.id);
      }
    }

    // A row an older build writes later, with no workspace, is rescued on the
    // next start instead of becoming invisible; nothing else is created twice.
    await meta.run(
      'INSERT INTO connections (id, user_id, name, dialect, encrypted_config, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['c-late', 'u-viewer', 'db', 'sqlite', 'x', now]
    );
    await backfillWorkspaces(meta);
    const viewerWs = await meta.get<{ id: string }>("SELECT id FROM workspaces WHERE personal_owner_id = 'u-viewer'");
    expect((await meta.get<{ workspace_id: string }>("SELECT workspace_id FROM connections WHERE id = 'c-late'"))?.workspace_id).toBe(
      viewerWs?.id
    );
    expect((await meta.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces'))?.n).toBe(2);
    expect((await meta.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspace_members'))?.n).toBe(2);
    await meta.close();
  });

  it('covers every table a workspace owns', async () => {
    const meta = createMetadataStore({ engine: 'sqlite', path: ':memory:' });
    await meta.init();
    await runMigrations(meta);
    for (const table of WORKSPACE_OWNED_TABLES) {
      const cols = await meta.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      expect(cols.map((c) => c.name), table).toEqual(expect.arrayContaining(['user_id', 'workspace_id']));
    }
    await meta.close();
  });
});

describe('a workspace sees only its own rows', () => {
  let a: WorkspaceScope;
  let b: WorkspaceScope;

  beforeAll(async () => {
    const user = await auth.createUser('iso@example.com', 'correct-horse-9', 'owner');
    a = { userId: user.id, workspaceId: (await personalOf(user.id)).id };
    // The same person in another workspace: what separates the rows is the workspace, not the author.
    b = { userId: user.id, workspaceId: await otherWorkspace(user.id) };
  });

  it('saved connections', async () => {
    const store = new ConnectionStore();
    const c = await store.create(a, { name: 'prod', dialect: 'sqlite', option: { database: '/tmp/x.db' } });
    expect((await store.list(b)).map((x) => x.id)).not.toContain(c.id);
    expect(await store.resolve(b, c.id)).toBeNull();
    expect(await store.update(b, c.id, { name: 'stolen', dialect: 'sqlite', option: { database: '/tmp/x.db' } })).toBeNull();
    expect(await store.remove(b, c.id)).toBe(false);
    expect((await store.resolve(a, c.id))?.name).toBe('prod');
  });

  it('secrets', async () => {
    const store = new AppSecretsStore();
    const s = await store.create(a, { name: 'API_KEY', source: 'local', value: 'v' } as never);
    expect((await store.list(b)).map((x) => x.id)).not.toContain(s.id);
    expect((await store.resolve(b, ['API_KEY'])).secrets).toEqual({});
    expect(await store.remove(b, s.id)).toBe(false);
    expect((await store.resolve(a, ['API_KEY'])).secrets).toEqual({ API_KEY: 'v' });
  });

  it('cloud provider credentials', async () => {
    const store = new CloudProviderCredentialsStore();
    const c = await store.create(a, 'Prod AWS', 'aws', { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' });
    expect((await store.list(b)).map((x) => x.id)).not.toContain(c.id);
    expect(await store.remove(b, c.id)).toBe(false);
  });

  it('migration and data-migrate runs', async () => {
    const runs = new MigrationHistoryStore();
    const id = await runs.start(a, { dialect: 'sqlite', objectCount: 1, script: 'SELECT 1' } as never);
    expect((await runs.list(b)).map((r) => r.id)).not.toContain(id);
    expect(await runs.get(b, id)).toBeNull();
    expect(await runs.remove(b, id)).toBe(false);
    expect((await runs.list(a)).map((r) => r.id)).toContain(id);

    const data = new DataMigrateHistoryStore();
    const started = await data.start(a, {
      dialect: 'sqlite',
      rowCount: 1,
      opsEnabled: [],
      includeIdentity: false,
      keyColumns: [],
      script: 'SELECT 1',
    } as never);
    expect((await data.list(b)).map((r) => r.id)).not.toContain(started.id);
    expect((await data.list(a)).map((r) => r.id)).toContain(started.id);
  });

  it('schema history', async () => {
    const lokee = new LokeeWeaveStore();
    await lokee.capture(a, {
      dialect: 'sqlite',
      host: null,
      port: null,
      database: '/tmp/iso.db',
      schema: 'main',
      tables: [],
      source: 'manual',
    } as never);
    const mine = await lokee.listDatabases(a);
    expect(mine.length).toBeGreaterThan(0);
    expect(await lokee.listDatabases(b)).toEqual([]);
    expect(await lokee.listVersions(b, mine[0]!.id)).toEqual([]);
  });

  it('names are unique per workspace, not per author', async () => {
    const secrets = new AppSecretsStore();
    await secrets.create(a, { name: 'SHARED_NAME', source: 'local', value: '1' } as never);
    await expect(secrets.create(b, { name: 'SHARED_NAME', source: 'local', value: '2' } as never)).resolves.toBeTruthy();
    await expect(secrets.create(a, { name: 'SHARED_NAME', source: 'local', value: '3' } as never)).rejects.toThrow();

    const lokee = new LokeeWeaveStore();
    const db = { dialect: 'sqlite', host: null, port: null, database: '/tmp/twice.db', schema: 'main', tables: [], source: 'manual' };
    await lokee.capture(a, db as never);
    await expect(lokee.capture(b, db as never)).resolves.toBeTruthy();
  });

  it('an account never gets two personal workspaces', async () => {
    const store = await getStore();
    await expect(
      store.run('INSERT INTO workspaces (id, name, personal_owner_id, created_at) VALUES (?, ?, ?, ?)', [
        randomUUID(),
        'dup',
        a.userId,
        new Date().toISOString(),
      ])
    ).rejects.toThrow();
  });
});

