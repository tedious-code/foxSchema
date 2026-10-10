/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Role-based access control: resolve / persist role permission grants.
 */
import { getStore } from '../../database/store';
import type { MetadataStore } from '../../database/stores/types';
import { assertAdminSlotFree } from './admin-policy.service';
import { syncPersonalRole } from '../workspaces/workspace.service';
import {
  APP_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  type AppRole,
  type Permission,
  isAppRole,
  uniquePermissions,
} from '@foxschema/shared';

/** Unknown / missing role values fall back to the least-privileged role. */
export function toAppRole(value: unknown): AppRole {
  return isAppRole(value) ? value : 'viewer';
}

/**
 * Placeholder row so an intentionally empty grant list is distinguishable from
 * "never seeded" (which still falls back to DEFAULT_ROLE_PERMISSIONS). Filtered
 * out by uniquePermissions / isPermission — never returned to callers.
 */
const EMPTY_ROLE_PERMISSIONS_SENTINEL = '';

export class RbacModule {
  /** Permissions granted to a role (DB overlay, else built-in defaults). */
  async permissionsForRole(role: AppRole): Promise<Permission[]> {
    if (role === 'admin') return [...DEFAULT_ROLE_PERMISSIONS.admin];
    const store = await getStore();
    const rows = await store.all<{ permission: string }>(
      'SELECT permission FROM role_permissions WHERE role = ?',
      [role]
    );
    // No rows → not customized yet (or pre-seed) → built-in defaults.
    // Any row (including the empty-set sentinel) → honor the stored grant list.
    if (rows.length === 0) return [...DEFAULT_ROLE_PERMISSIONS[role]];
    return uniquePermissions(rows.map((r) => r.permission));
  }

  async setUserRole(userId: string, role: AppRole): Promise<void> {
    const store = await getStore();
    const exists = await store.get<{ id: string; app_role: string | null; active: number | null }>(
      'SELECT id, app_role, active FROM users WHERE id = ?',
      [userId]
    );
    if (!exists) throw new Error('User not found.');

    // Match setUserActive: only *active* admins count toward the last-admin guard.
    // An inactive admin cannot sign in, so demoting the sole active admin would
    // lock the deployment out of Access control.
    const currentRole = toAppRole(exists.app_role);
    const currentlyActive =
      exists.active === null || exists.active === undefined ? true : Number(exists.active) !== 0;
    if (currentRole === 'admin' && role !== 'admin' && currentlyActive) {
      const others = await store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE app_role = 'admin' AND id != ? AND (active IS NULL OR active != 0)`,
        [userId]
      );
      if (Number(others?.n ?? 0) === 0) {
        throw new Error('Cannot demote the last active admin.');
      }
    }
    if (role === 'admin' && currentRole !== 'admin' && currentlyActive) {
      await assertAdminSlotFree(store, userId);
    }

    await store.run('UPDATE users SET app_role = ? WHERE id = ?', [role, userId]);
    await syncPersonalRole(store, userId, role);
  }

  /**
   * Hand the admin role from `fromUserId` to `toUserId`, which becomes the
   * admin while `fromUserId` takes `demoteTo`. One UPDATE, so no moment has
   * both or neither as admin — the only way to change hands under the `one`
   * policy, and safe under `several` too.
   */
  async transferAdmin(fromUserId: string, toUserId: string, demoteTo: AppRole = 'owner'): Promise<void> {
    if (demoteTo === 'admin') throw new Error('The previous admin must take a role other than admin.');
    if (fromUserId === toUserId) throw new Error('Choose another account to hand the admin role to.');
    const store = await getStore();
    const rows = await store.all<{ id: string; app_role: string | null; active: number | null }>(
      'SELECT id, app_role, active FROM users WHERE id IN (?, ?)',
      [fromUserId, toUserId]
    );
    const from = rows.find((r) => r.id === fromUserId);
    const to = rows.find((r) => r.id === toUserId);
    const isActive = (r: { active: number | null }) => r.active === null || Number(r.active) !== 0;
    if (!from || toAppRole(from.app_role) !== 'admin' || !isActive(from)) {
      throw new Error('Only an active admin can hand the admin role over.');
    }
    if (!to) throw new Error('User not found.');
    if (!isActive(to)) throw new Error('Activate the account before making it the admin.');
    if (toAppRole(to.app_role) === 'admin') throw new Error('That account is already an admin.');
    await store.run(
      `UPDATE users SET app_role = CASE WHEN id = ? THEN 'admin' ELSE ? END WHERE id IN (?, ?)`,
      [toUserId, demoteTo, fromUserId, toUserId]
    );
    await syncPersonalRole(store, toUserId, 'admin');
    await syncPersonalRole(store, fromUserId, demoteTo);
  }

  /** Replace the permission set for a non-admin role. Admin is always full. */
  async setRolePermissions(role: AppRole, permissions: unknown[]): Promise<Permission[]> {
    if (role === 'admin') {
      throw new Error('Admin always has all permissions — nothing to configure.');
    }
    const next = uniquePermissions(permissions);
    const store = await getStore();
    await store.run('DELETE FROM role_permissions WHERE role = ?', [role]);
    if (next.length === 0) {
      // Persist a sentinel so permissionsForRole does not fail-open to defaults,
      // and seedDefaultRolePermissions does not re-fill on the next boot.
      await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [
        role,
        EMPTY_ROLE_PERMISSIONS_SENTINEL,
      ]);
    } else {
      for (const p of next) {
        await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
      }
    }
    return next;
  }

  async listRolePermissionMatrix(): Promise<Record<AppRole, Permission[]>> {
    const out = {} as Record<AppRole, Permission[]>;
    for (const role of APP_ROLES) {
      out[role] = await this.permissionsForRole(role);
    }
    return out;
  }

  async listUsers(): Promise<
    Array<{
      id: string;
      email: string;
      role: AppRole;
      active: boolean;
      /** False until the person chose a password (an invite not yet accepted). */
      passwordSet: boolean;
      createdAt: string;
      permissions: Permission[];
    }>
  > {
    const store = await getStore();
    const rows = await store.all<{
      id: string;
      email: string;
      app_role: string | null;
      active: number | null;
      password_set: number | null;
      created_at: string;
    }>('SELECT id, email, app_role, active, password_set, created_at FROM users ORDER BY created_at ASC');
    const permsByRole = {} as Record<AppRole, Permission[]>;
    for (const role of APP_ROLES) {
      permsByRole[role] = await this.permissionsForRole(role);
    }
    return rows.map((r) => {
      const role = toAppRole(r.app_role);
      return {
        id: r.id,
        email: r.email,
        role,
        // Pre-migration rows / NULL → treat as active.
        active: r.active === null || r.active === undefined ? true : Number(r.active) !== 0,
        passwordSet: Number(r.password_set) === 1,
        createdAt: r.created_at,
        permissions: [...permsByRole[role]],
      };
    });
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    const store = await getStore();
    const exists = await store.get<{ id: string; app_role: string | null; active: number | null }>(
      'SELECT id, app_role, active FROM users WHERE id = ?',
      [userId]
    );
    if (!exists) throw new Error('User not found.');
    const wasActive = exists.active === null || Number(exists.active) !== 0;
    if (active && !wasActive && toAppRole(exists.app_role) === 'admin') {
      // Reactivating an old admin would make a second one.
      await assertAdminSlotFree(store, userId);
    }
    if (!active && toAppRole(exists.app_role) === 'admin') {
      const others = await store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE app_role = 'admin' AND id != ? AND (active IS NULL OR active != 0)`,
        [userId]
      );
      if (Number(others?.n ?? 0) === 0) {
        throw new Error('Cannot deactivate the last active admin.');
      }
    }
    await store.run('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, userId]);
    if (!active) {
      // Drop sessions so a deactivated user is kicked out immediately.
      await store.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
  }
}

/** Seed role_permissions with defaults when the table is empty for a role. */
export async function seedDefaultRolePermissions(store: MetadataStore): Promise<void> {
  for (const role of APP_ROLES) {
    if (role === 'admin') continue;
    const count = await store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM role_permissions WHERE role = ?',
      [role]
    );
    if (Number(count?.n ?? 0) > 0) continue;
    for (const p of DEFAULT_ROLE_PERMISSIONS[role]) {
      await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
    }
  }
}

/**
 * Additive backfill: when a role was customized before newer default permissions
 * existed (e.g. Data grid insert/update/delete, Drop indexes, Grant privileges),
 * copy those defaults in if the role already has the related capability.
 * Never re-fills intentionally emptied roles (sentinel-only).
 */
const BACKFILL_RULES: Array<{
  perms: Permission[];
  when: (granted: Set<string>) => boolean;
}> = [
  {
    perms: ['editor.datagrid.insert', 'editor.datagrid.update', 'editor.datagrid.delete'],
    when: (p) => p.has('editor.dml') || p.has('editor.write'),
  },
  {
    perms: ['utility.index.drop'],
    when: (p) =>
      p.has('utility.access') && (p.has('editor.ddl') || p.has('editor.write')),
  },
  {
    // Owner-like roles that already deploy migrations should also get GRANT
    // if they were customized before `editor.grant` existed. Editor defaults
    // do not include this key, so editors are not escalated.
    perms: ['editor.grant'],
    when: (p) => p.has('schema.migrate'),
  },
];

/**
 * One-time grants for permissions added after roles may have been saved.
 *
 * Unlike BACKFILL_RULES (re-checked on every boot), each runs once per
 * install, recorded in app_settings, so an admin who later removes the
 * permission from a role does not see it come back on the next restart.
 */
const ONE_TIME_GRANTS: Array<{
  key: string;
  perms: Permission[];
  when: (granted: Set<string>) => boolean;
}> = [
  {
    // Migrations in Git (#450): roles that could already look at schemas may
    // look at the repositories migrations are committed to.
    key: 'rbac.grant.git.view',
    perms: ['git.view'],
    when: (p) => p.has('schema.browse') || p.has('schema.compare'),
  },
  {
    // Workspaces: roles that deploy migrations (owner by default) run their
    // workspace — invite members and change its settings.
    key: 'rbac.grant.workspace.manage',
    perms: ['workspace.members', 'workspace.settings'],
    when: (p) => p.has('schema.migrate'),
  },
];

async function applyOneTimeGrants(store: MetadataStore): Promise<void> {
  for (const grant of ONE_TIME_GRANTS) {
    const done = await store.get<{ value: string | null }>('SELECT "value" FROM app_settings WHERE "key" = ?', [grant.key]);
    if (done?.value === 'done') continue;
    for (const role of APP_ROLES) {
      if (role === 'admin') continue;
      const rows = await store.all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [role]);
      if (rows.length === 0) continue; // unseeded → defaults (which include it) apply on read
      const perms = new Set(rows.map((r) => r.permission));
      if (perms.size === 1 && perms.has(EMPTY_ROLE_PERMISSIONS_SENTINEL)) continue;
      if (!grant.when(perms)) continue;
      for (const p of grant.perms) {
        if (perms.has(p) || !DEFAULT_ROLE_PERMISSIONS[role].includes(p)) continue;
        await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
      }
    }
    await store.upsert('app_settings', ['key'], { key: grant.key, value: 'done', updated_at: new Date().toISOString() }, ['value', 'updated_at']);
  }
}

export async function backfillDatagridRolePermissions(store: MetadataStore): Promise<void> {
  await applyOneTimeGrants(store);
  for (const role of APP_ROLES) {
    if (role === 'admin') continue;
    const rows = await store.all<{ permission: string }>(
      'SELECT permission FROM role_permissions WHERE role = ?',
      [role]
    );
    if (rows.length === 0) continue; // unseeded → defaults apply on read
    const perms = new Set(rows.map((r) => r.permission));
    // Intentional empty grant list.
    if (perms.size === 1 && perms.has(EMPTY_ROLE_PERMISSIONS_SENTINEL)) continue;
    const defaults = DEFAULT_ROLE_PERMISSIONS[role];
    for (const rule of BACKFILL_RULES) {
      if (!rule.when(perms)) continue;
      for (const p of rule.perms) {
        if (perms.has(p)) continue;
        // Only backfill keys that belong in this role's built-in defaults.
        if (!defaults.includes(p)) continue;
        await store.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
        perms.add(p);
      }
    }
  }
}
