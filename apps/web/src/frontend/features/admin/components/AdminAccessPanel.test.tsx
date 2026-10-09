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
const apiAdminIssueCode = vi.fn();
const apiAdminGetPolicy = vi.fn();
const apiAdminSetPolicy = vi.fn();
const apiAdminTransferAdmin = vi.fn();
const apiAdminSetMembersCanCreateWorkspaces = vi.fn();

vi.mock('@/shared/api/authApi', () => ({
  apiAdminCreateUser: (...args: unknown[]) => apiAdminCreateUser(...args),
  apiAdminListUsers: (...args: unknown[]) => apiAdminListUsers(...args),
  apiAdminRolePermissions: (...args: unknown[]) => apiAdminRolePermissions(...args),
  apiAdminSetRolePermissions: (...args: unknown[]) => apiAdminSetRolePermissions(...args),
  apiAdminSetUserActive: (...args: unknown[]) => apiAdminSetUserActive(...args),
  apiAdminSetUserPassword: (...args: unknown[]) => apiAdminSetUserPassword(...args),
  apiAdminSetUserRole: (...args: unknown[]) => apiAdminSetUserRole(...args),
  apiAdminIssueCode: (...args: unknown[]) => apiAdminIssueCode(...args),
  apiAdminGetPolicy: (...args: unknown[]) => apiAdminGetPolicy(...args),
  apiAdminSetPolicy: (...args: unknown[]) => apiAdminSetPolicy(...args),
  apiAdminTransferAdmin: (...args: unknown[]) => apiAdminTransferAdmin(...args),
  apiAdminSetMembersCanCreateWorkspaces: (...args: unknown[]) => apiAdminSetMembersCanCreateWorkspaces(...args),
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
  apiAdminIssueCode.mockReset();
  apiAdminGetPolicy.mockReset();
  apiAdminSetPolicy.mockReset();
  apiAdminTransferAdmin.mockReset();

  apiAdminListUsers.mockResolvedValue({ users: [localUser] });
  apiAdminGetPolicy.mockResolvedValue({ adminPolicy: 'several', source: 'app', activeAdmins: [localUser.email], membersCanCreateWorkspaces: false });
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
    apiAdminCreateUser.mockResolvedValue({});
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-add-user')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/add user/i), { target: { value: 'Teammate@Example.com' } });
    fireEvent.change(screen.getByLabelText(/starting password/i), { target: { value: 'green-river-17' } });
    fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: 'editor' } });
    fireEvent.submit(screen.getByTestId('admin-add-user'));

    await waitFor(() =>
      expect(apiAdminCreateUser).toHaveBeenCalledWith('Teammate@Example.com', 'green-river-17', 'editor')
    );
    // The list is read again so the new account appears.
    await waitFor(() => expect(apiAdminListUsers).toHaveBeenCalledTimes(2));
  });

  it('invites without a password and shows the code to pass on when email is not set up', async () => {
    apiAdminCreateUser.mockResolvedValue({
      invite: { code: 'ABCD-EFGH-JKMN', link: '', expiresAt: '2026-10-06T00:00:00.000Z', delivery: 'log' },
    });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-add-user')).toBeTruthy());
    expect(screen.getByRole('button', { name: /invite user/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/add user/i), { target: { value: 'new@example.com' } });
    fireEvent.submit(screen.getByTestId('admin-add-user'));

    await waitFor(() => expect(apiAdminCreateUser).toHaveBeenCalledWith('new@example.com', '', 'viewer'));
    const notice = await screen.findByTestId('admin-issued-code');
    expect(notice.textContent).toMatch(/pass this invite to new@example.com yourself/i);
    expect(screen.getByTestId('admin-issued-code-value').textContent).toBe('ABCD-EFGH-JKMN');
  });

  it('marks an unaccepted invite, and issues a fresh code for it', async () => {
    apiAdminListUsers.mockResolvedValue({
      users: [localUser, { ...localUser, id: 'inv', email: 'inv@example.com', role: 'viewer', passwordSet: false }],
    });
    apiAdminIssueCode.mockResolvedValue({
      purpose: 'invite',
      code: 'WXYZ-2345-6789',
      link: 'https://fox.example.com/#invite=WXYZ-2345-6789',
      expiresAt: '2026-10-06T00:00:00.000Z',
      delivery: 'email',
    });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('admin-user-invited-inv')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-issue-code-inv'));
    const notice = await screen.findByTestId('admin-issued-code');
    expect(apiAdminIssueCode).toHaveBeenCalledWith('inv');
    expect(notice.textContent).toMatch(/invite emailed to inv@example.com/i);
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

describe('AdminAccessPanel — one admin or several', () => {
  const editor = { ...localUser, id: 'ed', email: 'ed@example.com', role: 'editor' as const, permissions: [] };
  const oldAdmin = { ...localUser, id: 'old', email: 'old@example.com', active: false };

  const roleOption = (selectId: string, role: string) =>
    [...(screen.getByTestId(selectId) as HTMLSelectElement).options].find((o) => o.value === role)!;

  it('shows the policy and switches it', async () => {
    apiAdminSetPolicy.mockResolvedValue(undefined);
    render(<AdminAccessPanel open onClose={() => undefined} />);
    const several = await screen.findByTestId('admin-policy-several');
    expect(several.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('admin-policy-hint').textContent).toMatch(/any admin can make/i);

    fireEvent.click(screen.getByTestId('admin-policy-one'));
    await waitFor(() => expect(apiAdminSetPolicy).toHaveBeenCalledWith('one'));
    await waitFor(() => expect(apiAdminGetPolicy).toHaveBeenCalledTimes(2));
  });

  it('shows why switching failed, in the words of the server', async () => {
    apiAdminSetPolicy.mockRejectedValue(new Error('This install has 2 active admins (a@x.com, b@x.com).'));
    render(<AdminAccessPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId('admin-policy-one'));
    expect(await screen.findByText(/2 active admins \(a@x.com, b@x.com\)/)).toBeTruthy();
  });

  it('with one admin, offers Make admin instead of the admin role, and hands the role over', async () => {
    apiAdminGetPolicy.mockResolvedValue({ adminPolicy: 'one', source: 'app', activeAdmins: [localUser.email] });
    apiAdminListUsers.mockResolvedValue({ users: [localUser, editor, oldAdmin] });
    apiAdminTransferAdmin.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminAccessPanel open onClose={() => undefined} />);

    await screen.findByTestId('admin-transfer-admin-ed');
    expect(screen.getByTestId('admin-policy-hint').textContent).toMatch(/only one account can be admin/i);
    expect(roleOption('admin-new-role', 'admin').disabled).toBe(true);
    expect(roleOption('admin-user-role-ed', 'admin').disabled).toBe(true);
    // Not offered for yourself, nor for an inactive account.
    expect(screen.queryByTestId(`admin-transfer-admin-${localUser.id}`)).toBeNull();
    expect(screen.queryByTestId('admin-transfer-admin-old')).toBeNull();
    // Reactivating the old admin would make a second one.
    const reactivate = screen.getByTestId('admin-active-old') as HTMLInputElement;
    expect(reactivate.disabled).toBe(true);
    expect(reactivate.title).toMatch(/allows one admin/i);

    fireEvent.click(screen.getByTestId('admin-transfer-admin-ed'));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/make ed@example.com the admin/i));
    await waitFor(() => expect(apiAdminTransferAdmin).toHaveBeenCalledWith('ed'));
    // The former admin lost Manage users: no reload (it would 403), just the swap.
    expect(await screen.findByTestId('admin-users-status')).toBeTruthy();
    expect(screen.getByTestId('admin-users-status').textContent).toMatch(/ed@example.com is now the admin/);
    expect(apiAdminListUsers).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('does nothing when the hand-over is not confirmed', async () => {
    apiAdminGetPolicy.mockResolvedValue({ adminPolicy: 'one', source: 'app', activeAdmins: [localUser.email] });
    apiAdminListUsers.mockResolvedValue({ users: [localUser, editor] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AdminAccessPanel open onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId('admin-transfer-admin-ed'));
    expect(apiAdminTransferAdmin).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('with several admins, keeps the admin role selectable and offers no hand-over', async () => {
    apiAdminListUsers.mockResolvedValue({ users: [localUser, editor] });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    await screen.findByTestId('admin-user-role-ed');
    expect(roleOption('admin-new-role', 'admin').disabled).toBe(false);
    expect(roleOption('admin-user-role-ed', 'admin').disabled).toBe(false);
    expect(screen.queryByTestId('admin-transfer-admin-ed')).toBeNull();
  });

  it('is read-only when the server sets it', async () => {
    apiAdminGetPolicy.mockResolvedValue({ adminPolicy: 'one', source: 'env', activeAdmins: [localUser.email] });
    render(<AdminAccessPanel open onClose={() => undefined} />);
    expect(((await screen.findByTestId('admin-policy-several')) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('admin-policy-hint').textContent).toMatch(/FOX_ADMIN_POLICY/);
  });
});

describe('AdminAccessPanel — who creates workspaces', () => {
  it('lets the admin open workspace creation to everyone', async () => {
    apiAdminSetMembersCanCreateWorkspaces.mockResolvedValue(undefined);
    render(<AdminAccessPanel open onClose={() => undefined} />);
    const box = (await screen.findByTestId('admin-policy-members-create')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(apiAdminSetMembersCanCreateWorkspaces).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/everyone can now create workspaces/i)).toBeTruthy();
  });
});
