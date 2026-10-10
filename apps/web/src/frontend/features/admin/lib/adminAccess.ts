/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access control panel helpers: dirty drafts, last-admin / single-user locks,
 * user-role groups, and permission display grouping.
 */
import { APP_ROLES, PERMISSION_META, type AppRole, type Permission } from '@foxschema/shared';

export function permissionSetEqual(
  a: Iterable<Permission> | undefined,
  b: Iterable<Permission> | undefined
): boolean {
  const as = a instanceof Set ? a : new Set(a ?? []);
  const bs = b instanceof Set ? b : new Set(b ?? []);
  if (as.size !== bs.size) return false;
  for (const p of as) {
    if (!bs.has(p)) return false;
  }
  return true;
}

export type AdminUserLike = {
  id: string;
  role: AppRole;
  active: boolean;
};

export function isActiveAdmin(user: AdminUserLike): boolean {
  return user.role === 'admin' && user.active !== false;
}

export function activeAdminCount(users: readonly AdminUserLike[]): number {
  return users.filter(isActiveAdmin).length;
}

export type ControlLock = { disabled: boolean; reason?: string };

export type AdminPolicyValue = 'one' | 'several';

/**
 * Whether the one-admin policy keeps `user` from becoming an admin: another
 * account already is. `null` (a new account) counts every active admin.
 */
export function adminSlotTaken(
  user: AdminUserLike | null,
  opts: { policy: AdminPolicyValue | null; users: readonly AdminUserLike[] }
): boolean {
  if (opts.policy !== 'one') return false;
  return opts.users.some((u) => isActiveAdmin(u) && u.id !== user?.id);
}

/**
 * Who the signed-in admin may hand the admin role to: an active account
 * that is not an admin. Offered only under the one-admin policy, where it is
 * the only way the role changes hands.
 */
export function canTransferAdminTo(
  user: AdminUserLike,
  opts: { policy: AdminPolicyValue | null; meId?: string; meRole?: AppRole }
): boolean {
  return (
    opts.policy === 'one' &&
    opts.meRole === 'admin' &&
    user.id !== opts.meId &&
    user.role !== 'admin' &&
    user.active !== false
  );
}

export function userRoleSelectLock(
  user: AdminUserLike,
  opts: { busy?: boolean; users: readonly AdminUserLike[] }
): ControlLock {
  if (opts.busy) return { disabled: true };
  if (isActiveAdmin(user) && activeAdminCount(opts.users) <= 1) {
    return { disabled: true, reason: 'Cannot change the last active admin’s role' };
  }
  return { disabled: false };
}

export function userActiveCheckboxLock(
  user: AdminUserLike,
  opts: {
    busy?: boolean;
    meId?: string;
    users: readonly AdminUserLike[];
    policy?: AdminPolicyValue | null;
  }
): ControlLock {
  if (opts.busy) return { disabled: true };
  if (user.role === 'admin' && user.active === false && adminSlotTaken(user, { policy: opts.policy ?? null, users: opts.users })) {
    return { disabled: true, reason: 'This install allows one admin. Reactivating this admin would make a second one.' };
  }
  if (user.id === opts.meId) {
    return { disabled: true, reason: 'You cannot deactivate your own account' };
  }
  if (isActiveAdmin(user) && activeAdminCount(opts.users) <= 1) {
    return { disabled: true, reason: 'Cannot deactivate the last active admin' };
  }
  return { disabled: false };
}

/** Most privileged first — Access control lists users under these role groups. */
export const ROLE_GROUP_ORDER: AppRole[] = [...APP_ROLES].reverse();

export function roleGroupLabel(role: AppRole): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'owner':
      return 'Owner';
    case 'editor':
      return 'Editor';
    case 'viewer':
      return 'Viewer';
  }
}

export type UserRoleGroup<T extends { role: AppRole }> = {
  role: AppRole;
  label: string;
  users: T[];
};

export function groupUsersByRole<T extends { role: AppRole }>(
  users: readonly T[],
  opts?: { includeEmpty?: boolean }
): UserRoleGroup<T>[] {
  const includeEmpty = opts?.includeEmpty !== false;
  return ROLE_GROUP_ORDER.map((role) => ({
    role,
    label: roleGroupLabel(role),
    users: users.filter((u) => u.role === role),
  })).filter((g) => includeEmpty || g.users.length > 0);
}

export type PermissionGroupView = {
  group: string;
  items: { id: Permission; label: string }[];
};

/** Cluster a user's grants under PERMISSION_META.group for the Users tab. */
export function groupPermissionsForDisplay(
  permissions: readonly Permission[],
  catalog: readonly { id: Permission; group: string; label: string }[] = PERMISSION_META
): PermissionGroupView[] {
  const granted = new Set(permissions);
  const byGroup = new Map<string, { id: Permission; label: string }[]>();
  const seen = new Set<Permission>();
  for (const meta of catalog) {
    if (!granted.has(meta.id)) continue;
    const list = byGroup.get(meta.group) ?? [];
    list.push({ id: meta.id, label: meta.label });
    byGroup.set(meta.group, list);
    seen.add(meta.id);
  }
  for (const p of permissions) {
    if (seen.has(p)) continue;
    const list = byGroup.get('Other') ?? [];
    list.push({ id: p, label: p });
    byGroup.set('Other', list);
  }
  return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
}
