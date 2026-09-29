/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_META } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';

const apiAdminCreateUser = vi.fn();
const apiAdminListUsers = vi.fn();
const apiAdminRolePermissions = vi.fn();
const apiAdminSetRolePermissions = vi.fn();
const apiAdminSetUserActive = vi.fn();
const apiAdminSetUserPassword = vi.fn();
const apiAdminSetUserRole = vi.fn();

vi.mock('@/shared/api/authApi', () => ({
  apiAdminCreateUser: (...args: unknown[]) => apiAdminCreateUser(...args),
  apiAdminListUsers: (...args: unknown[]) => apiAdminListUsers(...args),
  apiAdminRolePermissions: (...args: unknown[]) => apiAdminRolePermissions(...args),
  apiAdminSetRolePermissions: (...args: unknown[]) => apiAdminSetRolePermissions(...args),
  apiAdminSetUserActive: (...args: unknown[]) => apiAdminSetUserActive(...args),
  apiAdminSetUserPassword: (...args: unknown[]) => apiAdminSetUserPassword(...args),
  apiAdminSetUserRole: (...args: unknown[]) => apiAdminSetUserRole(...args),
}));

import { AdminAccessPanel } from './AdminAccessPanel';

const localUser = {
  id: 'local-id',
  email: 'local@foxschema.app',
  role: 'admin' as const,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  permissions: [...DEFAULT_ROLE_PERMISSIONS.admin],
};

beforeEach(() => {
  apiAdminCreateUser.mockReset();
  apiAdminListUsers.mockReset();
  apiAdminRolePermissions.mockReset();
  apiAdminSetRolePermissions.mockReset();
  apiAdminSetUserActive.mockReset();
  apiAdminSetUserPassword.mockReset();
  apiAdminSetUserRole.mockReset();

  apiAdminListUsers.mockResolvedValue({ users: [localUser] });
  apiAdminRolePermissions.mockResolvedValue({
    matrix: {
      viewer: [...DEFAULT_ROLE_PERMISSIONS.viewer],
      editor: [...DEFAULT_ROLE_PERMISSIONS.editor],
      owner: [...DEFAULT_ROLE_PERMISSIONS.owner],
      admin: [...DEFAULT_ROLE_PERMISSIONS.admin],
    },
    catalog: PERMISSION_META,
  });
  apiAdminSetRolePermissions.mockImplementation(async (_role: string, permissions: string[]) => [
    ...permissions,
  ]);

  useAuthStore.setState({
    user: {
      id: localUser.id,
      email: localUser.email,
      onboardingCompleted: true,
      role: 'admin',
      permissions: [],
    },
    status: 'ready',
    error: null,
    busy: false,
    refreshMe: vi.fn(async () => {}),
  });
});

describe('AdminAccessPanel', () => {
  it('locks role and Active for the only admin, and for your own account', async () => {
    render(<AdminAccessPanel open onClose={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByTestId(`admin-user-role-${localUser.id}`)).toBeTruthy();
    });
    expect(screen.getByTestId('admin-access-layers').textContent).toMatch(/two layers/i);
    expect(screen.getByTestId('admin-tab-users').textContent).toMatch(/app users/i);
    expect(screen.getByTestId('admin-tab-roles').textContent).toMatch(/app roles/i);
    expect(screen.getByTestId('admin-tab-users-roles').textContent).toMatch(/users and roles/i);
    expect((screen.getByTestId(`admin-user-role-${localUser.id}`) as HTMLSelectElement).disabled).toBe(
      true
    );
    expect((screen.getByTestId(`admin-active-${localUser.id}`) as HTMLInputElement).disabled).toBe(
      true
    );
  });

  it('adds an account, since nobody can register themselves', async () => {
    apiAdminCreateUser.mockResolvedValue(undefined);
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-add-user')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/add user/i), { target: { value: 'Teammate@Example.com' } });
    fireEvent.change(screen.getByLabelText(/starting password/i), { target: { value: 'teammate-pass' } });
    fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: 'editor' } });
    fireEvent.submit(screen.getByTestId('admin-add-user'));

    await waitFor(() =>
      expect(apiAdminCreateUser).toHaveBeenCalledWith('Teammate@Example.com', 'teammate-pass', 'editor')
    );
    // The list is read again so the new account appears.
    await waitFor(() => expect(apiAdminListUsers).toHaveBeenCalledTimes(2));
  });

  it('keeps Save visible and persists checkbox edits for a non-admin role', async () => {
    render(<AdminAccessPanel open onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-roles'));

    const save = screen.getByTestId('admin-save-role-perms') as HTMLButtonElement;
    expect(save).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId('admin-roles-hint').textContent).toMatch(/access → permission/i);

    fireEvent.click(screen.getByTestId('admin-edit-role-owner'));
    // Groups start collapsed, so the checkboxes are not in the DOM until the
    // group is opened — the count in the header is what is visible up front.
    expect(screen.queryByTestId('admin-perm-admin.users')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-perm-group-Admin'));
    const manageUsers = screen.getByTestId('admin-perm-admin.users') as HTMLInputElement;
    expect(manageUsers.checked).toBe(false);
    fireEvent.click(manageUsers);
    expect(manageUsers.checked).toBe(true);
    expect(screen.getByTestId('admin-unsaved').textContent).toMatch(/unsaved/i);
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(apiAdminSetRolePermissions).toHaveBeenCalledTimes(1));
    const [role, perms] = apiAdminSetRolePermissions.mock.calls[0] as [string, string[]];
    expect(role).toBe('owner');
    expect(perms).toContain('admin.users');
    await waitFor(() => {
      expect(screen.getByTestId('admin-save-status').textContent).toMatch(/saved owner/i);
    });
  });

  it('lets you inspect admin but not edit or save that role', async () => {
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-roles'));
    fireEvent.click(screen.getByTestId('admin-edit-role-admin'));
    fireEvent.click(screen.getByTestId('admin-perm-group-Admin'));

    expect((screen.getByTestId('admin-perm-admin.users') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-perm-admin.users') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('admin-save-role-perms') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('admin-roles-hint').textContent).toMatch(/cannot be reduced/i);
  });

  it('summarises each group while collapsed, and opens on demand', async () => {
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-roles'));
    fireEvent.click(screen.getByTestId('admin-edit-role-owner'));

    // The count is why collapsing is acceptable: "what does this role have?" is
    // answerable without opening anything.
    const count = screen.getByTestId('admin-perm-count-Admin');
    expect(count.textContent).toMatch(/^\d+ \/ \d+$/);

    const header = screen.getByTestId('admin-perm-group-Admin');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('admin-perm-admin.users')).toBeTruthy();
  });

  it('keeps an unsaved edit when its group is collapsed again', async () => {
    // The draft lives in component state, not in the DOM, so collapsing must
    // not silently discard a change the user has already made.
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-roles'));
    fireEvent.click(screen.getByTestId('admin-edit-role-owner'));
    fireEvent.click(screen.getByTestId('admin-perm-group-Admin'));

    fireEvent.click(screen.getByTestId('admin-perm-admin.users'));
    expect(screen.getByTestId('admin-unsaved').textContent).toMatch(/unsaved/i);

    fireEvent.click(screen.getByTestId('admin-perm-group-Admin')); // collapse
    expect(screen.queryByTestId('admin-perm-admin.users')).toBeNull();
    expect(screen.getByTestId('admin-unsaved').textContent).toMatch(/unsaved/i);

    fireEvent.click(screen.getByTestId('admin-perm-group-Admin')); // reopen
    expect((screen.getByTestId('admin-perm-admin.users') as HTMLInputElement).checked).toBe(true);
  });

  it('expands and collapses every group at once', async () => {
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-roles'));
    fireEvent.click(screen.getByTestId('admin-edit-role-owner'));

    fireEvent.click(screen.getByTestId('admin-perm-expand-all'));
    expect(screen.getByTestId('admin-perm-admin.users')).toBeTruthy();
    expect(screen.getByText(/Grant privileges is the FoxSchema gate/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('admin-perm-collapse-all'));
    expect(screen.queryByTestId('admin-perm-admin.users')).toBeNull();
  });

  it('opens for a viewer without admin or utility grants and explains how to get access', async () => {
    useAuthStore.setState({
      user: {
        id: 'u-viewer',
        email: 'viewer@example.com',
        onboardingCompleted: true,
        role: 'viewer',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.viewer],
      },
    });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    expect(screen.getByTestId('admin-access-panel')).toBeTruthy();
    expect(screen.getByTestId('admin-access-denied').textContent).toMatch(/use utilities/i);
    expect(screen.queryByTestId('admin-tab-users')).toBeNull();
    expect(screen.queryByTestId('admin-tab-roles')).toBeNull();
    expect(screen.queryByTestId('admin-tab-users-roles')).toBeNull();
  });

  it('shows Users and Roles (access report) for an editor with utilities', async () => {
    useAuthStore.setState({
      user: {
        id: 'u-editor',
        email: 'editor@example.com',
        onboardingCompleted: true,
        role: 'editor',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.editor],
      },
    });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-users-roles')).toBeTruthy());
    expect(screen.queryByTestId('admin-tab-users')).toBeNull();
    expect(screen.queryByTestId('admin-tab-roles')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-tab-users-roles'));
    expect(screen.getByTestId('admin-users-roles-panel')).toBeTruthy();
    expect(screen.getByTestId('access-report')).toBeTruthy();
  });

  it('defaults to Roles when the user can configure roles but not users', async () => {
    useAuthStore.setState({
      user: {
        id: 'u-owner',
        email: 'owner@example.com',
        onboardingCompleted: true,
        role: 'owner',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.owner, 'admin.roles'],
      },
    });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-tab-roles')).toBeTruthy());
    expect(screen.queryByTestId('admin-tab-users')).toBeNull();
    expect(screen.getByTestId('admin-edit-role-editor')).toBeTruthy();
  });

  it('groups users by role and expands to show permission labels', async () => {
    const editorUser = {
      id: 'ed-1',
      email: 'ed@example.com',
      role: 'editor' as const,
      active: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.editor],
    };
    apiAdminListUsers.mockResolvedValue({ users: [localUser, editorUser] });

    render(<AdminAccessPanel open onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('admin-user-group-admin')).toBeTruthy());
    expect(screen.getByTestId('admin-user-group-editor').textContent).toMatch(/1 user/i);
    expect(screen.getByTestId('admin-user-group-empty-owner').textContent).toMatch(/no users/i);
    expect(screen.getByTestId('admin-user-group-empty-viewer').textContent).toMatch(/no users/i);

    expect(screen.getByTestId(`admin-user-perm-count-${localUser.id}`).textContent).toMatch(
      /permission/i
    );
    expect(screen.getByTestId(`admin-user-perms-${localUser.id}`).textContent).toMatch(/Manage users/);
    expect(screen.getByTestId(`admin-user-perm-${localUser.id}-admin.users`)).toBeTruthy();

    expect(screen.queryByTestId(`admin-user-perms-${editorUser.id}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`admin-user-expand-${editorUser.id}`));
    expect(screen.getByTestId(`admin-user-perms-${editorUser.id}`).textContent).toMatch(/Change data/);
    expect(screen.queryByTestId(`admin-user-perm-${editorUser.id}-admin.users`)).toBeNull();
  });
});
