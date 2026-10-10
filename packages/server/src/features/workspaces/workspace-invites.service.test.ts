import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { getStore } from '../../database/store';
import { AuthModule, type AuthUser } from '../auth/auth.service';
import { RbacModule } from '../authorization/rbac.service';
import { writeAdminPolicy } from '../authorization/admin-policy.service';
import { WorkspaceDirectory, type WorkspaceActor } from './workspace-directory.service';
import { OWNERS_INVITE_NEW_KEY, WorkspaceInvites } from './workspace-invites.service';

const auth = new AuthModule();
const dir = new WorkspaceDirectory();
const invites = new WorkspaceInvites();

let admin: AuthUser;
let owner: AuthUser;
let viewer: AuthUser;
let guest: AuthUser;
let teamId: string;

const actor = (u: AuthUser): WorkspaceActor => ({ userId: u.id, appRole: u.role, permissions: new Set(u.permissions) });
const isMember = async (wsId: string, userId: string) =>
  (await dir.listMine(userId)).some((w) => w.id === wsId);

async function setInviteNew(on: boolean) {
  const store = await getStore();
  await store.upsert('app_settings', ['key'], { key: OWNERS_INVITE_NEW_KEY, value: on ? 'on' : 'off', updated_at: '' }, ['value']);
}

beforeAll(async () => {
  await writeAdminPolicy(await getStore(), 'several');
  admin = await auth.createUser('inv-admin@example.com', 'correct-horse-9', 'editor');
  await new RbacModule().setUserRole(admin.id, 'admin');
  admin = { ...admin, role: 'admin' };
  owner = await auth.createUser('inv-owner@example.com', 'correct-horse-9', 'editor');
  viewer = await auth.createUser('inv-viewer@example.com', 'correct-horse-9', 'viewer');
  guest = await auth.createUser('inv-guest@example.com', 'correct-horse-9', 'viewer');
  teamId = (await dir.create(actor(admin), 'Invites team')).id;
  await dir.addMember(actor(admin), teamId, owner.id, 'owner');
  await dir.addMember(actor(admin), teamId, viewer.id, 'viewer');
});

describe('inviting an existing account', () => {
  it('asks rather than adds: the person joins only on accept, with the invited role', async () => {
    const { invite, newAccount } = await invites.invite(actor(owner), teamId, ' Inv-Guest@Example.com ', 'editor');
    expect(newAccount).toBeUndefined();
    expect(invite).toMatchObject({ email: 'inv-guest@example.com', role: 'editor', workspaceName: 'Invites team', invitedBy: 'inv-owner@example.com' });
    expect(await isMember(teamId, guest.id)).toBe(false);

    const mine = await invites.mine(guest.id);
    expect(mine.map((i) => i.id)).toContain(invite.id);
    expect(await invites.accept(guest.id, invite.id)).toBe(teamId);
    expect((await dir.listMine(guest.id)).find((w) => w.id === teamId)?.role).toBe('editor');
    expect(await invites.mine(guest.id)).toEqual([]);
    await dir.removeMember(actor(guest), teamId, guest.id);
  });

  it('can be declined, and then is gone', async () => {
    const { invite } = await invites.invite(actor(owner), teamId, guest.email, 'viewer');
    await invites.decline(guest.id, invite.id);
    expect(await invites.mine(guest.id)).toEqual([]);
    await expect(invites.accept(guest.id, invite.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await isMember(teamId, guest.id)).toBe(false);
  });

  it('is only for the invited account', async () => {
    const { invite } = await invites.invite(actor(owner), teamId, guest.email, 'viewer');
    await expect(invites.accept(viewer.id, invite.id)).rejects.toMatchObject({ code: 'not_found' });
    await invites.revoke(actor(owner), teamId, invite.id);
    await expect(invites.accept(guest.id, invite.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('expires', async () => {
    const { invite } = await invites.invite(actor(owner), teamId, guest.email, 'viewer');
    const store = await getStore();
    await store.run('UPDATE workspace_invites SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), invite.id]);
    expect(await invites.mine(guest.id)).toEqual([]);
    await expect(invites.accept(guest.id, invite.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replaces an earlier pending invite instead of stacking', async () => {
    await invites.invite(actor(owner), teamId, guest.email, 'viewer');
    await invites.invite(actor(owner), teamId, guest.email, 'owner');
    const mine = (await invites.mine(guest.id)).filter((i) => i.workspaceId === teamId);
    expect(mine.map((i) => i.role)).toEqual(['owner']);
    await invites.revoke(actor(owner), teamId, mine[0]!.id);
  });

  it('is refused for someone already in the workspace', async () => {
    await expect(invites.invite(actor(owner), teamId, viewer.email, 'editor')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('needs workspace.members there: a viewer member cannot invite, an outsider gets not found', async () => {
    await expect(invites.invite(actor(viewer), teamId, guest.email, 'viewer')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(invites.invite(actor(guest), teamId, 'x@example.com', 'viewer')).rejects.toMatchObject({ code: 'not_found' });
    await expect(invites.listForWorkspace(actor(viewer), teamId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets every account invite into its own workspace, whatever its role there', async () => {
    // A viewer account is a viewer in its own workspace, and still runs who is in it.
    const ownId = (await dir.listMine(viewer.id)).find((w) => w.personal)!.id;
    const { invite } = await invites.invite(actor(viewer), ownId, guest.email, 'viewer');
    expect(invite.workspaceId).toBe(ownId);
    await invites.accept(guest.id, invite.id);
    await dir.setMemberRole(actor(viewer), ownId, guest.id, 'editor');
    await dir.removeMember(actor(viewer), ownId, guest.id);
    // …but not into someone else's.
    const ownerOwn = (await dir.listMine(owner.id)).find((w) => w.personal)!.id;
    await expect(invites.invite(actor(viewer), ownerOwn, guest.email, 'viewer')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('inviting someone with no account', () => {
  it('is for admins by default, and makes the account with a one-time code', async () => {
    await expect(invites.invite(actor(owner), teamId, 'brand-new@example.com', 'viewer')).rejects.toMatchObject({ code: 'forbidden' });
    const store = await getStore();
    expect(await store.get('SELECT id FROM users WHERE email = ?', ['brand-new@example.com'])).toBeUndefined();

    const { invite, newAccount } = await invites.invite(actor(admin), teamId, 'brand-new@example.com', 'editor');
    expect(newAccount?.code).toBeTruthy();
    const made = await store.get<{ id: string; app_role: string }>('SELECT id, app_role FROM users WHERE email = ?', ['brand-new@example.com']);
    expect(made?.app_role).toBe('viewer');
    // The workspace invite waits for that account.
    expect((await invites.mine(made!.id)).map((i) => i.id)).toEqual([invite.id]);
  });

  it('is for owners too once the admin turns it on', async () => {
    await setInviteNew(true);
    try {
      const { newAccount } = await invites.invite(actor(owner), teamId, 'owner-invited@example.com', 'viewer');
      expect(newAccount?.code).toBeTruthy();
    } finally {
      await setInviteNew(false);
    }
  });

  it('checks the email', async () => {
    await expect(invites.invite(actor(admin), teamId, 'not-an-email', 'viewer')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(invites.invite(actor(admin), teamId, 'a@example.com', 'admin')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
