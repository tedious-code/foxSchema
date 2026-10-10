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

describe('admins and private workspaces (D6)', () => {
  let privateId: string;
  let owner: AuthUser;

  beforeAll(async () => {
    await setMembersCreate(true);
    owner = await auth.createUser('d6-owner@example.com', 'correct-horse-9', 'editor');
    privateId = (await dir.create(actor(owner), 'Private books')).id;
    await setMembersCreate(false);
    const conn = new ConnectionStore();
    await conn.create({ userId: owner.id, workspaceId: privateId }, { name: 'payroll', dialect: 'sqlite', option: { database: '/tmp/p.db' } });
  });

  it('an admin sees every workspace, with its owners and size, but not what it holds', async () => {
    const all = await dir.listAll(actor(admin));
    const row = all.find((w) => w.id === privateId);
    expect(row).toMatchObject({ name: 'Private books', owners: ['d6-owner@example.com'], memberCount: 1, adminIsMember: false, personalOwner: null });
    expect(JSON.stringify(row)).not.toContain('payroll');
    // Personal workspaces are listed too, by whose they are.
    expect(all.some((w) => w.personalOwner === 'd6-owner@example.com')).toBe(true);
  });

  it('is only for admins', async () => {
    await expect(dir.listAll(actor(owner))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('an admin cannot act in a workspace it is not in — not even by id', async () => {
    await expect(auth.inWorkspace(admin, privateId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(dir.select(admin.id, privateId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('joining is how an admin opens one, and its members see who joined and who added them', async () => {
    await dir.addMember(actor(admin), privateId, admin.id, 'owner');
    const members = await dir.members(actor(owner), privateId);
    expect(members.find((m) => m.userId === admin.id)).toMatchObject({ role: 'owner', addedBy: 'dir-admin@example.com' });
    expect((await auth.inWorkspace(admin, privateId)).workspace.id).toBe(privateId);
    const conns = await new ConnectionStore().list({ userId: admin.id, workspaceId: privateId });
    expect(conns.map((c) => c.name)).toEqual(['payroll']);
    expect((await dir.listAll(actor(admin))).find((w) => w.id === privateId)?.adminIsMember).toBe(true);
  });

  it('an admin can transfer ownership and archive a workspace it is not in', async () => {
    const other = (await dir.create(actor(admin), 'Hand-off')).id;
    await dir.addMember(actor(admin), other, owner.id, 'viewer');
    await dir.setMemberRole(actor(admin), other, owner.id, 'owner');
    await dir.removeMember(actor(admin), other, admin.id);
    expect((await dir.listAll(actor(admin))).find((w) => w.id === other)).toMatchObject({ owners: ['d6-owner@example.com'], adminIsMember: false });
    await dir.archive(actor(admin), other);
    expect((await dir.listAll(actor(admin))).some((w) => w.id === other)).toBe(false);
    expect((await dir.listAll(actor(admin), true)).find((w) => w.id === other)?.archived).toBe(true);
  });
});

describe('public and private workspaces (D2)', () => {
  let pubId: string;
  let walker: AuthUser;

  beforeAll(async () => {
    pubId = (await dir.create(actor(admin), 'Open data')).id;
    walker = await auth.createUser('d2-walker@example.com', 'correct-horse-9', 'editor');
  });

  it('a private workspace is not listed to outsiders and cannot be joined', async () => {
    expect((await dir.discover(walker.id)).some((w) => w.id === pubId)).toBe(false);
    await expect(dir.join(walker.id, pubId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a public one is listed to everyone signed in, and joining gives its join role', async () => {
    await dir.updateSettings(actor(admin), pubId, { visibility: 'public', joinRole: 'editor' });
    const listed = (await dir.discover(walker.id)).find((w) => w.id === pubId);
    expect(listed).toMatchObject({ name: 'Open data', joinRole: 'editor', memberCount: 1 });
    expect(await dir.join(walker.id, pubId)).toBe('editor');
    expect((await dir.listMine(walker.id)).find((w) => w.id === pubId)?.role).toBe('editor');
    // Joined: no longer offered, and joining again changes nothing.
    expect((await dir.discover(walker.id)).some((w) => w.id === pubId)).toBe(false);
    expect(await dir.join(walker.id, pubId)).toBe('editor');
  });

  it('going private again keeps members and hides it from everyone else', async () => {
    await dir.updateSettings(actor(admin), pubId, { visibility: 'private' });
    expect((await dir.listMine(walker.id)).some((w) => w.id === pubId)).toBe(true);
    const outsider = await auth.createUser('d2-outsider@example.com', 'correct-horse-9', 'viewer');
    expect((await dir.discover(outsider.id)).some((w) => w.id === pubId)).toBe(false);
    await expect(dir.join(outsider.id, pubId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a personal workspace stays private', async () => {
    const own = (await dir.listMine(admin.id)).find((w) => w.personal)!.id;
    await expect(dir.updateSettings(actor(admin), own, { visibility: 'public' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('only those with workspace settings change it, and values are checked', async () => {
    await expect(dir.updateSettings(actor(walker), pubId, { visibility: 'public' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(dir.updateSettings(actor(admin), pubId, { visibility: 'open' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(dir.updateSettings(actor(admin), pubId, { joinRole: 'admin' })).rejects.toMatchObject({ code: 'invalid_input' });
    // Never owner: a stranger joining could otherwise remove the owners and archive it.
    await expect(dir.updateSettings(actor(admin), pubId, { joinRole: 'owner' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(dir.updateSettings(actor(admin), pubId, {})).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('an archived public workspace is neither listed nor joinable', async () => {
    const gone = (await dir.create(actor(admin), 'Gone public')).id;
    await dir.updateSettings(actor(admin), gone, { visibility: 'public' });
    await dir.archive(actor(admin), gone);
    expect((await dir.discover(walker.id)).some((w) => w.id === gone)).toBe(false);
    await expect(dir.join(walker.id, gone)).rejects.toMatchObject({ code: 'not_found' });
  });
});
