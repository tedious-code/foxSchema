/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AuthModule, type AuthUser } from '../../platform/identity/auth.service';
import { RbacModule } from '../../platform/authorization/rbac.service';
import { WorkspaceDirectory, type WorkspaceActor } from './workspace-directory.service';
import { WorkspaceScripts } from './workspace-scripts.service';

const auth = new AuthModule();
const rbac = new RbacModule();
const dir = new WorkspaceDirectory();
const scripts = new WorkspaceScripts();

let admin: AuthUser;
let editor: AuthUser;
let viewer: AuthUser;
let workspaceId: string;

const actor = (u: AuthUser): WorkspaceActor => ({
  userId: u.id,
  appRole: u.role,
  permissions: new Set(u.permissions),
});

beforeAll(async () => {
  admin = await auth.createUser('scripts-admin@example.com', 'correct-horse-9', 'editor');
  await rbac.setUserRole(admin.id, 'admin');
  admin = { ...admin, role: 'admin' };
  editor = await auth.createUser('scripts-editor@example.com', 'correct-horse-9', 'editor');
  viewer = await auth.createUser('scripts-viewer@example.com', 'correct-horse-9', 'viewer');
  const ws = await dir.create(actor(admin), 'Shared scripts');
  workspaceId = ws.id;
  await dir.addMember(actor(admin), workspaceId, editor.id, 'editor');
  await dir.addMember(actor(admin), workspaceId, viewer.id, 'viewer');
});

describe('workspace scripts', () => {
  it('lets an editor save a script the viewer can open, and refuses a viewer save', async () => {
    const saved = await scripts.save(editor.id, workspaceId, '  Coupons  ', 'SELECT * FROM coupons');
    expect(saved.title).toBe('Coupons');
    const listed = await scripts.list(viewer.id, workspaceId);
    expect(listed.canWrite).toBe(false);
    expect(listed.scripts.map((s) => s.title)).toEqual(['Coupons']);
    expect(listed.scripts[0]?.sql).toBe('SELECT * FROM coupons');
    await expect(scripts.save(viewer.id, workspaceId, 'Nope', 'SELECT 1')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('updates the script when the same name is saved again', async () => {
    const again = await scripts.save(editor.id, workspaceId, 'coupons', 'SELECT id FROM coupons');
    const listed = await scripts.list(editor.id, workspaceId);
    expect(listed.canWrite).toBe(true);
    expect(listed.scripts.filter((s) => s.title.toLowerCase() === 'coupons')).toHaveLength(1);
    expect(again.sql).toBe('SELECT id FROM coupons');
  });

  it('hides another workspace’s scripts', async () => {
    const mine = await dir.listMine(editor.id);
    const personal = mine.find((w) => w.personal);
    expect(personal).toBeTruthy();
    const other = await scripts.list(editor.id, personal!.id);
    expect(other.scripts.some((s) => s.title === 'Coupons')).toBe(false);
  });

  it('lets an editor delete, and a viewer cannot', async () => {
    const saved = await scripts.save(editor.id, workspaceId, 'Temporary', 'SELECT 1');
    await expect(scripts.remove(viewer.id, workspaceId, saved.id)).rejects.toMatchObject({ code: 'forbidden' });
    await scripts.remove(editor.id, workspaceId, saved.id);
    const listed = await scripts.list(editor.id, workspaceId);
    expect(listed.scripts.some((s) => s.id === saved.id)).toBe(false);
  });
});
