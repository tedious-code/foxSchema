import { describe, it, expect, beforeAll } from 'vitest';

// Use an isolated in-memory DB before anything calls getStore()
process.env.APP_DB_PATH = ':memory:';

import { RbacModule, toAppRole, backfillDatagridRolePermissions } from './rbac.service';
import { getStore } from '../../database/store';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '@foxschema/shared';

const rbac = new RbacModule();

describe('toAppRole', () => {
  it('passes through known roles', () => {
    expect(toAppRole('admin')).toBe('admin');
    expect(toAppRole('editor')).toBe('editor');
    expect(toAppRole('viewer')).toBe('viewer');
  });

  it('falls back to viewer for unknown or missing values', () => {
    expect(toAppRole('root')).toBe('viewer');
    expect(toAppRole(null)).toBe('viewer');
    expect(toAppRole(undefined)).toBe('viewer');
    expect(toAppRole(1)).toBe('viewer');
  });
});

describe('RbacModule', () => {
  beforeAll(async () => {
    // touch the DB so migrations + default seeding run before tests
    await getStore();
  });

  it('admin always resolves to the full permission catalog', async () => {
    expect(await rbac.permissionsForRole('admin')).toEqual([...PERMISSIONS]);
  });

  it('non-admin roles resolve to their seeded defaults', async () => {
    // Reads come back in index order, so compare contents rather than order.
    expect((await rbac.permissionsForRole('viewer')).sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.viewer].sort()
    );
    expect((await rbac.permissionsForRole('editor')).sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.editor].sort()
    );
  });

  it('setRolePermissions replaces grants and drops unknown values', async () => {
    try {
      const next = await rbac.setRolePermissions('viewer', [
        'schema.browse',
        'schema.browse',
        'not-a-permission',
        42,
        'editor.run',
      ]);
      expect(next).toEqual(['schema.browse', 'editor.run']);
      expect((await rbac.permissionsForRole('viewer')).sort()).toEqual([
        'editor.run',
        'schema.browse',
      ]);
    } finally {
      // Restore the seeded matrix even on failure, so one red test stays one red test.
      await rbac.setRolePermissions('viewer', DEFAULT_ROLE_PERMISSIONS.viewer);
    }
  });

  it('setRolePermissions([]) stays empty (does not fail-open to defaults)', async () => {
    try {
      const next = await rbac.setRolePermissions('editor', []);
      expect(next).toEqual([]);
      expect(await rbac.permissionsForRole('editor')).toEqual([]);
      // Sentinel row must keep seedDefaultRolePermissions from re-filling.
      const store = await getStore();
      const count = await store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM role_permissions WHERE role = ?',
        ['editor']
      );
      expect(Number(count?.n ?? 0)).toBeGreaterThan(0);
    } finally {
      await rbac.setRolePermissions('editor', DEFAULT_ROLE_PERMISSIONS.editor);
    }
  });

  it('refuses to configure the admin role', async () => {
    await expect(rbac.setRolePermissions('admin', ['editor.run'])).rejects.toThrow(
      /always has all permissions/
    );
  });

  it('setUserRole updates a user and rejects unknown ids', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u1', 'rbac-user@example.com', 'x', new Date().toISOString(), 'viewer']
    );

    await rbac.setUserRole('u1', 'editor');
    // Assigning the same role again is a no-op update, not "user not found".
    await rbac.setUserRole('u1', 'editor');
    expect((await rbac.listUsers()).find((u) => u.id === 'u1')?.role).toBe('editor');

    await expect(rbac.setUserRole('missing', 'editor')).rejects.toThrow(/User not found/);
  });

  it('listUsers normalizes unknown stored roles to viewer', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u2', 'legacy-role@example.com', 'x', new Date().toISOString(), 'superuser']
    );
    expect((await rbac.listUsers()).find((u) => u.id === 'u2')?.role).toBe('viewer');
  });

  it('listUsers includes active flag and setUserActive toggles it', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u-active', 'active-flag@example.com', 'x', new Date().toISOString(), 'viewer']
    );
    expect((await rbac.listUsers()).find((u) => u.id === 'u-active')?.active).toBe(true);
    await rbac.setUserActive('u-active', false);
    expect((await rbac.listUsers()).find((u) => u.id === 'u-active')?.active).toBe(false);
    await rbac.setUserActive('u-active', true);
    expect((await rbac.listUsers()).find((u) => u.id === 'u-active')?.active).toBe(true);
  });

  it('listUsers includes effective permissions from the user role', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u-perm-viewer', 'perm-viewer@example.com', 'x', new Date().toISOString(), 'viewer']
    );
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u-perm-editor', 'perm-editor@example.com', 'x', new Date().toISOString(), 'editor']
    );
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u-perm-admin', 'perm-admin@example.com', 'x', new Date().toISOString(), 'admin']
    );
    try {
      await rbac.setRolePermissions('editor', ['schema.browse', 'editor.run']);
      const users = await rbac.listUsers();
      const viewer = users.find((u) => u.id === 'u-perm-viewer');
      const editor = users.find((u) => u.id === 'u-perm-editor');
      const admin = users.find((u) => u.id === 'u-perm-admin');

      expect(viewer?.permissions.sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.viewer].sort());
      expect(editor?.permissions.sort()).toEqual(['editor.run', 'schema.browse']);
      expect(admin?.permissions).toEqual([...PERMISSIONS]);
    } finally {
      await rbac.setRolePermissions('editor', DEFAULT_ROLE_PERMISSIONS.editor);
    }
  });

  it('refuses to deactivate the last active admin', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role) VALUES (?, ?, ?, ?, ?)',
      ['u-sole-admin', 'sole-admin@example.com', 'x', new Date().toISOString(), 'admin']
    );
    // Deactivate every other admin first so this one is the last active admin.
    const users = await rbac.listUsers();
    for (const u of users) {
      if (u.role === 'admin' && u.id !== 'u-sole-admin' && u.active) {
        await rbac.setUserActive(u.id, false);
      }
    }
    await expect(rbac.setUserActive('u-sole-admin', false)).rejects.toThrow(/last active admin/);
  });

  it('refuses to demote the last active admin when other admins are inactive', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role, active) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-active-admin', 'active-admin@example.com', 'x', new Date().toISOString(), 'admin', 1]
    );
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role, active) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-inactive-admin', 'inactive-admin@example.com', 'x', new Date().toISOString(), 'admin', 0]
    );
    // Leave only u-active-admin as an active admin (deactivate any seeded admins).
    const users = await rbac.listUsers();
    for (const u of users) {
      if (u.role === 'admin' && u.id !== 'u-active-admin' && u.id !== 'u-inactive-admin' && u.active) {
        await rbac.setUserActive(u.id, false);
      }
    }
    await expect(rbac.setUserRole('u-active-admin', 'viewer')).rejects.toThrow(/last active admin/);
    // Inactive admin may still be demoted; the active one remains.
    await rbac.setUserRole('u-inactive-admin', 'viewer');
    expect((await rbac.listUsers()).find((u) => u.id === 'u-inactive-admin')?.role).toBe('viewer');
    expect((await rbac.listUsers()).find((u) => u.id === 'u-active-admin')?.role).toBe('admin');
  });

  it('allows demoting an admin when another active admin remains', async () => {
    const store = await getStore();
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role, active) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-admin-a', 'admin-a@example.com', 'x', new Date().toISOString(), 'admin', 1]
    );
    await store.run(
      'INSERT INTO users (id, email, password_hash, created_at, app_role, active) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-admin-b', 'admin-b@example.com', 'x', new Date().toISOString(), 'admin', 1]
    );
    await rbac.setUserRole('u-admin-a', 'editor');
    expect((await rbac.listUsers()).find((u) => u.id === 'u-admin-a')?.role).toBe('editor');
    expect((await rbac.listUsers()).find((u) => u.id === 'u-admin-b')?.role).toBe('admin');
  });

  it('role permission matrix covers every role', async () => {
    const matrix = await rbac.listRolePermissionMatrix();
    expect(Object.keys(matrix).sort()).toEqual(['admin', 'editor', 'owner', 'viewer']);
    expect(matrix.admin).toEqual([...PERMISSIONS]);
  });

  it('backfills Data grid permissions onto roles that already have Change data', async () => {
    const store = await getStore();
    try {
      // Simulate a pre-datagrid customized editor matrix that has DML but no grid keys.
      await rbac.setRolePermissions(
        'editor',
        DEFAULT_ROLE_PERMISSIONS.editor.filter((p) => !p.startsWith('editor.datagrid.'))
      );
      expect((await rbac.permissionsForRole('editor')).some((p) => p.startsWith('editor.datagrid.'))).toBe(
        false
      );
      await backfillDatagridRolePermissions(store);
      const next = new Set(await rbac.permissionsForRole('editor'));
      expect(next.has('editor.datagrid.insert')).toBe(true);
      expect(next.has('editor.datagrid.update')).toBe(true);
      expect(next.has('editor.datagrid.delete')).toBe(true);
    } finally {
      await rbac.setRolePermissions('editor', DEFAULT_ROLE_PERMISSIONS.editor);
    }
  });

  it('does not backfill Data grid onto roles without Change data', async () => {
    const store = await getStore();
    try {
      await rbac.setRolePermissions('viewer', ['editor.access', 'editor.run']);
      await backfillDatagridRolePermissions(store);
      const next = await rbac.permissionsForRole('viewer');
      expect(next.some((p) => p.startsWith('editor.datagrid.'))).toBe(false);
    } finally {
      await rbac.setRolePermissions('viewer', DEFAULT_ROLE_PERMISSIONS.viewer);
    }
  });

  it('backfills Drop indexes onto roles that already have utilities + Change schema', async () => {
    const store = await getStore();
    try {
      await rbac.setRolePermissions(
        'editor',
        DEFAULT_ROLE_PERMISSIONS.editor.filter((p) => p !== 'utility.index.drop')
      );
      expect((await rbac.permissionsForRole('editor')).includes('utility.index.drop')).toBe(false);
      await backfillDatagridRolePermissions(store);
      expect(new Set(await rbac.permissionsForRole('editor')).has('utility.index.drop')).toBe(true);
    } finally {
      await rbac.setRolePermissions('editor', DEFAULT_ROLE_PERMISSIONS.editor);
    }
  });

  it('backfills Grant privileges onto owner-like roles that already migrate', async () => {
    const store = await getStore();
    try {
      await rbac.setRolePermissions(
        'owner',
        DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'editor.grant')
      );
      expect((await rbac.permissionsForRole('owner')).includes('editor.grant')).toBe(false);
      await backfillDatagridRolePermissions(store);
      expect(new Set(await rbac.permissionsForRole('owner')).has('editor.grant')).toBe(true);
    } finally {
      await rbac.setRolePermissions('owner', DEFAULT_ROLE_PERMISSIONS.owner);
    }
  });

  it('does not backfill Grant privileges onto editor', async () => {
    const store = await getStore();
    try {
      await rbac.setRolePermissions('editor', [...DEFAULT_ROLE_PERMISSIONS.editor, 'schema.migrate']);
      await backfillDatagridRolePermissions(store);
      expect(new Set(await rbac.permissionsForRole('editor')).has('editor.grant')).toBe(false);
    } finally {
      await rbac.setRolePermissions('editor', DEFAULT_ROLE_PERMISSIONS.editor);
    }
  });
});
