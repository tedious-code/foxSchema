/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  activeAdminCount,
  groupPermissionsForDisplay,
  groupUsersByRole,
  permissionSetEqual,
  roleGroupLabel,
  ROLE_GROUP_ORDER,
  userActiveCheckboxLock,
  userRoleSelectLock,
} from './adminAccess';
import type { AdminUserLike } from './adminAccess';
import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@foxschema/shared';

const admin: AdminUserLike = { id: 'a', role: 'admin', active: true };
const editor: AdminUserLike = { id: 'e', role: 'editor', active: true };
const inactiveAdmin: AdminUserLike = { id: 'ia', role: 'admin', active: false };

describe('permissionSetEqual', () => {
  it('treats the same ids as equal regardless of order', () => {
    expect(permissionSetEqual(['editor.run', 'editor.dml'], ['editor.dml', 'editor.run'])).toBe(
      true
    );
  });

  it('detects a missing or extra permission', () => {
    expect(permissionSetEqual(['editor.run'], ['editor.run', 'editor.dml'])).toBe(false);
    expect(permissionSetEqual(['editor.run'], [])).toBe(false);
  });
});

describe('last-admin and own-account locks', () => {
  it('counts only active admins', () => {
    expect(activeAdminCount([admin, editor, inactiveAdmin])).toBe(1);
    expect(activeAdminCount([admin, { ...admin, id: 'a2' }])).toBe(2);
  });

  it('never lets you deactivate your own account', () => {
    const active = userActiveCheckboxLock(admin, {
      meId: admin.id,
      users: [admin, { ...admin, id: 'a2' }],
    });
    expect(active.disabled).toBe(true);
    expect(active.reason).toMatch(/your own account/i);
  });

  it('locks the last active admin’s role', () => {
    const lock = userRoleSelectLock(admin, { users: [admin, editor] });
    expect(lock.disabled).toBe(true);
    expect(lock.reason).toMatch(/last active admin/i);
  });

  it('lets a second admin change an editor, and the other admin', () => {
    const otherAdmin: AdminUserLike = { id: 'a2', role: 'admin', active: true };
    expect(userRoleSelectLock(editor, { users: [admin, otherAdmin, editor] }).disabled).toBe(
      false
    );
    expect(userRoleSelectLock(otherAdmin, { users: [admin, otherAdmin] }).disabled).toBe(false);
  });

  it('does not let you deactivate yourself or the last admin', () => {
    expect(
      userActiveCheckboxLock(admin, { meId: admin.id, users: [admin, editor] }).disabled
    ).toBe(true);
    expect(userActiveCheckboxLock(admin, { meId: editor.id, users: [admin, editor] }).disabled).toBe(
      true
    );
    const otherAdmin: AdminUserLike = { id: 'a2', role: 'admin', active: true };
    expect(
      userActiveCheckboxLock(otherAdmin, { meId: admin.id, users: [admin, otherAdmin] }).disabled
    ).toBe(false);
  });
});

describe('groupUsersByRole', () => {
  it('lists Admin → Viewer and keeps empty groups by default', () => {
    expect(ROLE_GROUP_ORDER).toEqual(['admin', 'owner', 'editor', 'viewer']);
    const groups = groupUsersByRole([editor, admin]);
    expect(groups.map((g) => g.role)).toEqual(['admin', 'owner', 'editor', 'viewer']);
    expect(groups.map((g) => g.label)).toEqual(['Admin', 'Owner', 'Editor', 'Viewer']);
    expect(groups.find((g) => g.role === 'admin')?.users).toEqual([admin]);
    expect(groups.find((g) => g.role === 'editor')?.users).toEqual([editor]);
    expect(groups.find((g) => g.role === 'owner')?.users).toEqual([]);
  });

  it('can omit empty groups', () => {
    const groups = groupUsersByRole([editor], { includeEmpty: false });
    expect(groups.map((g) => g.role)).toEqual(['editor']);
  });
});

describe('groupPermissionsForDisplay', () => {
  it('clusters grants under catalog groups and keeps unknown keys', () => {
    const groups = groupPermissionsForDisplay([
      'schema.browse',
      'admin.users',
      'editor.run',
      'future.perm' as Permission,
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Schema Sync', 'SQL Editor', 'Admin', 'Other']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Browse schema']);
    expect(groups[2].items.map((i) => i.label)).toEqual(['Manage users']);
    expect(groups[3].items.map((i) => i.id)).toEqual(['future.perm']);
  });

  it('uses viewer defaults as a representative role set', () => {
    const groups = groupPermissionsForDisplay(DEFAULT_ROLE_PERMISSIONS.viewer);
    expect(groups.some((g) => g.group === 'Schema Sync')).toBe(true);
    expect(groups.some((g) => g.group === 'Admin')).toBe(false);
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(
      expect.arrayContaining(DEFAULT_ROLE_PERMISSIONS.viewer)
    );
  });
});

describe('roleGroupLabel', () => {
  it('title-cases built-in roles', () => {
    expect(roleGroupLabel('admin')).toBe('Admin');
    expect(roleGroupLabel('viewer')).toBe('Viewer');
  });
});
