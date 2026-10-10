import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { getStore } from '../../database/store';
import { AuthModule, type AuthUser } from '../auth/auth.service';
import { ConnectionStore } from '../connections/connection-store.service';
import { writeAdminPolicy } from '../authorization/admin-policy.service';
import { RbacModule } from '../authorization/rbac.service';
import { MEMBERS_CREATE_KEY, WorkspaceDirectory, type WorkspaceActor } from './workspace-directory.service';

const auth = new AuthModule();
const rbac = new RbacModule();
const dir = new WorkspaceDirectory();

let admin: AuthUser;
let ana: AuthUser; // editor account
let ben: AuthUser; // viewer account

const actor = (u: AuthUser): WorkspaceActor => ({ userId: u.id, appRole: u.role, permissions: new Set(u.permissions) });

async function setMembersCreate(on: boolean) {
  const store = await getStore();
  await store.upsert('app_settings', ['key'], { key: MEMBERS_CREATE_KEY, value: on ? 'on' : 'off', updated_at: '' }, ['value']);
}

beforeAll(async () => {
  await writeAdminPolicy(await getStore(), 'several');
  admin = await auth.createUser('dir-admin@example.com', 'correct-horse-9', 'editor');
  await rbac.setUserRole(admin.id, 'admin');
  admin = { ...admin, role: 'admin' };
  ana = await auth.createUser('dir-ana@example.com', 'correct-horse-9', 'editor');
  ben = await auth.createUser('dir-ben@example.com', 'correct-horse-9', 'viewer');
});

describe('creating workspaces', () => {
  it('is for admins by default', async () => {
    const ws = await dir.create(actor(admin), '  Data   team ');
    expect(ws).toMatchObject({ name: 'Data team', role: 'owner', personal: false, visibility: 'private' });
    await expect(dir.create(actor(ana), 'Mine')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('is for everyone once the admin turns it on', async () => {
    await setMembersCreate(true);
    try {
      expect((await dir.create(actor(ana), 'Ana team')).role).toBe('owner');
    } finally {
      await setMembersCreate(false);
    }
  });

  it('needs a name', async () => {
    await expect(dir.create(actor(admin), '   ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(dir.create(actor(admin), 'x'.repeat(81))).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('a shared workspace', () => {
  let teamId: string;

  beforeAll(async () => {
    teamId = (await dir.create(actor(admin), 'Shared')).id;
    await dir.addMember(actor(admin), teamId, ana.id, 'owner');
    await dir.addMember(actor(admin), teamId, ben.id, 'viewer');
  });

  it('lists for its members, personal workspace first', async () => {
    const mine = await dir.listMine(ben.id);
    expect(mine[0]).toMatchObject({ personal: true });
    expect(mine.find((w) => w.id === teamId)).toMatchObject({ role: 'viewer', memberCount: 3 });
  });

  it('shares its connections — and only its own — with every member', async () => {
    const store = new ConnectionStore();
    const anaIn = { userId: ana.id, workspaceId: teamId };
    const benIn = { userId: ben.id, workspaceId: teamId };
    const shared = await store.create(anaIn, { name: 'warehouse', dialect: 'sqlite', option: { database: '/tmp/w.db' } });
    expect((await store.list(benIn)).map((c) => c.id)).toContain(shared.id);
    expect((await store.resolve(benIn, shared.id))?.name).toBe('warehouse');
    // Ben's personal workspace does not see it.
    const benOwn = (await dir.listMine(ben.id)).find((w) => w.personal)!.id;
    expect(await store.resolve({ userId: ben.id, workspaceId: benOwn }, shared.id)).toBeNull();
  });

  it('gives a viewer member viewer permissions there, whatever it is elsewhere', async () => {
    const { permissions, workspace } = await auth.inWorkspace(ana, teamId);
    expect(workspace.role).toBe('owner');
    expect(permissions).toContain('editor.grant');
    const benThere = await auth.inWorkspace(ben, teamId);
    expect(benThere.permissions).not.toContain('editor.ddl');
    // Install keys stay with the account: a viewer account owning a workspace gets no code cells.
    const cara = await auth.createUser('dir-cara@example.com', 'correct-horse-9', 'viewer');
    await dir.addMember(actor(admin), teamId, cara.id, 'owner');
    const caraThere = await auth.inWorkspace(cara, teamId);
    expect(caraThere.permissions).toContain('editor.ddl');
    expect(caraThere.permissions).not.toContain('editor.advanced');
    await dir.removeMember(actor(admin), teamId, cara.id);
  });

  it('is chosen with select, and only by a member', async () => {
    await dir.select(ben.id, teamId);
    expect((await auth.inWorkspace(ben, undefined)).workspace.id).toBe(teamId);
    const outsider = await auth.createUser('dir-out@example.com', 'correct-horse-9', 'viewer');
    await expect(dir.select(outsider.id, teamId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(dir.members(actor(outsider), teamId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets owners — not viewers — change roles and rename it', async () => {
    await expect(dir.setMemberRole(actor(ben), teamId, ana.id, 'viewer')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(dir.rename(actor(ben), teamId, 'Hijacked')).rejects.toMatchObject({ code: 'forbidden' });
    await dir.setMemberRole(actor(ana), teamId, ben.id, 'editor');
    expect((await dir.members(actor(ana), teamId)).find((m) => m.userId === ben.id)?.role).toBe('editor');
    await dir.rename(actor(ana), teamId, 'Shared data');
    expect((await dir.listMine(ana.id)).find((w) => w.id === teamId)?.name).toBe('Shared data');
  });

  it('always keeps an owner', async () => {
    await dir.setMemberRole(actor(admin), teamId, admin.id, 'editor');
    await expect(dir.setMemberRole(actor(ana), teamId, ana.id, 'viewer')).rejects.toMatchObject({ code: 'conflict' });
    await expect(dir.removeMember(actor(ana), teamId, ana.id)).rejects.toMatchObject({ code: 'conflict' });
    await dir.setMemberRole(actor(admin), teamId, admin.id, 'owner');
  });

  it('lets a member leave, which also stops it acting there', async () => {
    await dir.select(ben.id, teamId);
    await dir.removeMember(actor(ben), teamId, ben.id);
    expect((await dir.listMine(ben.id)).some((w) => w.id === teamId)).toBe(false);
    expect((await auth.inWorkspace(ben, undefined)).workspace.personal).toBe(true);
  });

  it('only admins add people directly', async () => {
    await expect(dir.addMember(actor(ana), teamId, ben.id, 'viewer')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('can be archived, after which nobody sees it', async () => {
    const temp = await dir.create(actor(admin), 'Temp');
    await dir.archive(actor(admin), temp.id);
    expect((await dir.listMine(admin.id)).some((w) => w.id === temp.id)).toBe(false);
    await expect(dir.select(admin.id, temp.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('personal workspaces', () => {
  it('keep their account: it cannot leave, be removed, have its role changed, or be archived', async () => {
    const own = (await dir.listMine(ana.id)).find((w) => w.personal)!.id;
    await expect(dir.removeMember(actor(ana), own, ana.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(dir.removeMember(actor(admin), own, ana.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(dir.setMemberRole(actor(admin), own, ana.id, 'viewer')).rejects.toMatchObject({ code: 'conflict' });
    await expect(dir.archive(actor(admin), own)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('let a guest leave even though the account there is only a viewer', async () => {
    const own = (await dir.listMine(ben.id)).find((w) => w.personal)!.id;
    await dir.addMember(actor(admin), own, ana.id, 'owner');
    await dir.removeMember(actor(ana), own, ana.id);
    expect((await dir.members(actor(ben), own)).map((m) => m.userId)).toEqual([ben.id]);
  });
});
