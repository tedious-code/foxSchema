/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Nobody gives more than they can do, and a personal workspace lends no more
 * than its account holds.
 *
 * A personal workspace's account manages its members whatever its role there,
 * so a viewer account could invite a colleague as owner. The colleague then
 * had DDL, DML, GRANT and schema migrate on the viewer's saved connections —
 * credentials an admin handed out for reading — which neither account was
 * ever given.
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { getStore } from '../../database/store';
import { AuthModule, type AuthUser } from '../../platform/identity/auth.service';
import { RbacModule } from '../../platform/authorization/rbac.service';
import { writeAdminPolicy } from '../../platform/authorization/admin-policy.service';
import { WorkspaceDirectory, type WorkspaceActor } from './workspace-directory.service';
import { WorkspaceInvites } from './workspace-invites.service';
import { WorkspaceScripts } from './workspace-scripts.service';

const auth = new AuthModule();
const rbac = new RbacModule();
const dir = new WorkspaceDirectory();
const invites = new WorkspaceInvites();

let admin: AuthUser;
let viewerAcct: AuthUser; // a viewer account, sharing its own workspace
let editorAcct: AuthUser; // an editor account, sharing its own workspace
let colleague: AuthUser; // invited into both
let teamOwner: AuthUser; // owner of a shared workspace

const actor = (u: AuthUser): WorkspaceActor => ({ userId: u.id, appRole: u.role, permissions: new Set(u.permissions) });
const personalOf = async (u: AuthUser) => (await dir.listMine(u.id)).find((w) => w.personal)!.id;
const roleOf = async (u: AuthUser, wsId: string) => (await dir.listMine(u.id)).find((w) => w.id === wsId)?.role;
const permsIn = async (u: AuthUser, wsId: string) => new Set((await auth.inWorkspace(u, wsId)).permissions);
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'forbidden' });

beforeAll(async () => {
  await writeAdminPolicy(await getStore(), 'several');
  admin = await auth.createUser('ceil-admin@example.com', 'correct-horse-9', 'editor');
  await rbac.setUserRole(admin.id, 'admin');
  admin = { ...admin, role: 'admin' };
  viewerAcct = await auth.createUser('ceil-viewer@example.com', 'correct-horse-9', 'viewer');
  editorAcct = await auth.createUser('ceil-editor@example.com', 'correct-horse-9', 'editor');
  colleague = await auth.createUser('ceil-colleague@example.com', 'correct-horse-9', 'viewer');
  teamOwner = await auth.createUser('ceil-owner@example.com', 'correct-horse-9', 'editor');
});

describe('a personal workspace lends no more than its account holds', () => {
  it("a viewer account can share its workspace, but only as viewer", async () => {
    const ws = await personalOf(viewerAcct);
    for (const role of ['owner', 'editor'] as const) {
      await refused(invites.invite(actor(viewerAcct), ws, colleague.email, role));
    }
    const { invite } = await invites.invite(actor(viewerAcct), ws, colleague.email, 'viewer');
    await invites.accept(colleague.id, invite.id);
    expect(await roleOf(colleague, ws)).toBe('viewer');

    // Nor can it raise the colleague afterwards.
    await refused(dir.setMemberRole(actor(viewerAcct), ws, colleague.id, 'owner'));
    expect(await roleOf(colleague, ws)).toBe('viewer');
  });

  it('an editor account shares up to editor, never owner', async () => {
    const ws = await personalOf(editorAcct);
    await refused(invites.invite(actor(editorAcct), ws, colleague.email, 'owner'));
    const { invite } = await invites.invite(actor(editorAcct), ws, colleague.email, 'editor');
    await invites.accept(colleague.id, invite.id);
    expect(await roleOf(colleague, ws)).toBe('editor');
    const perms = await permsIn(colleague, ws);
    expect(perms.has('editor.ddl')).toBe(true);
    expect(perms.has('editor.grant')).toBe(false);
  });

  it('a role stored above the ceiling acts at the ceiling — written before this rule, or by an older build', async () => {
    const ws = await personalOf(viewerAcct);
    const store = await getStore();
    await store.run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [
      'owner',
      ws,
      colleague.id,
    ]);

    const perms = await permsIn(colleague, ws);
    for (const p of ['editor.ddl', 'editor.dml', 'editor.grant', 'schema.migrate', 'secrets.view'] as const) {
      expect(perms.has(p), p).toBe(false);
    }
    expect(perms.has('editor.run')).toBe(true);
    expect(await roleOf(colleague, ws)).toBe('viewer');
    expect((await dir.members(actor(viewerAcct), ws)).find((m) => m.userId === colleague.id)?.role).toBe('viewer');
    // The list sorts by the role as it takes effect: all viewers here, so by email.
    const late = await auth.createUser('ceil-zz@example.com', 'correct-horse-9', 'viewer');
    await store.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [ws, late.id, 'owner', viewerAcct.id, new Date().toISOString()]
    );
    expect((await dir.members(actor(viewerAcct), ws)).map((m) => m.email)).toEqual([
      colleague.email,
      viewerAcct.email,
      late.email,
    ]);
    await store.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [ws, late.id]);
    // Every read applies the cap: workspace scripts too, and the admin's list of owners.
    const scripts = new WorkspaceScripts();
    expect((await scripts.list(colleague.id, ws)).canWrite).toBe(false);
    await refused(scripts.save(colleague.id, ws, 'Shared report', 'SELECT 1'));
    const row = (await dir.listAll(actor(admin))).find((w) => w.id === ws);
    expect(row?.owners).not.toContain(colleague.email);
    // And it cannot run the membership with the role it does not really have.
    await refused(invites.invite(actor(colleague), ws, teamOwner.email, 'viewer'));
    await refused(dir.setMemberRole(actor(colleague), ws, colleague.id, 'owner'));
  });

  it('follows the account: an account raised to editor lends editor', async () => {
    const ws = await personalOf(viewerAcct);
    await rbac.setUserRole(viewerAcct.id, 'editor');
    try {
      expect(await roleOf(colleague, ws)).toBe('editor');
    } finally {
      await rbac.setUserRole(viewerAcct.id, 'viewer');
    }
    expect(await roleOf(colleague, ws)).toBe('viewer');
  });
});

describe('a shared workspace', () => {
  let teamId: string;

  beforeAll(async () => {
    teamId = (await dir.create(actor(admin), 'Ceiling team')).id;
    await dir.addMember(actor(admin), teamId, teamOwner.id, 'owner');
  });

  it('its owners still give any role, owner included', async () => {
    const { invite } = await invites.invite(actor(teamOwner), teamId, colleague.email, 'owner');
    await invites.accept(colleague.id, invite.id);
    expect(await roleOf(colleague, teamId)).toBe('owner');
    expect((await permsIn(colleague, teamId)).has('editor.grant')).toBe(true);
    await dir.setMemberRole(actor(teamOwner), teamId, colleague.id, 'viewer');
    expect(await roleOf(colleague, teamId)).toBe('viewer');
  });

  it('an admin gives any role anywhere, a personal workspace included', async () => {
    const ws = await personalOf(viewerAcct);
    await dir.setMemberRole(actor(admin), ws, colleague.id, 'editor');
    // Stored as given; it still acts at the workspace's ceiling.
    expect(await roleOf(colleague, ws)).toBe('viewer');
  });
});
