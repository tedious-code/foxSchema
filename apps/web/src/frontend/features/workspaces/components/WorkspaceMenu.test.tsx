/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/app/store/authStore';

const apiListWorkspaces = vi.fn();
const apiCreateWorkspace = vi.fn();
const apiSelectWorkspace = vi.fn();
const apiWorkspaceMembers = vi.fn();
const apiSetWorkspaceMember = vi.fn();
const apiRemoveWorkspaceMember = vi.fn();
const apiRenameWorkspace = vi.fn();
const apiArchiveWorkspace = vi.fn();

vi.mock('../api/workspacesApi', () => ({
  apiListWorkspaces: (...a: unknown[]) => apiListWorkspaces(...a),
  apiCreateWorkspace: (...a: unknown[]) => apiCreateWorkspace(...a),
  apiSelectWorkspace: (...a: unknown[]) => apiSelectWorkspace(...a),
  apiWorkspaceMembers: (...a: unknown[]) => apiWorkspaceMembers(...a),
  apiSetWorkspaceMember: (...a: unknown[]) => apiSetWorkspaceMember(...a),
  apiRemoveWorkspaceMember: (...a: unknown[]) => apiRemoveWorkspaceMember(...a),
  apiRenameWorkspace: (...a: unknown[]) => apiRenameWorkspace(...a),
  apiArchiveWorkspace: (...a: unknown[]) => apiArchiveWorkspace(...a),
}));

import { WorkspaceMenu } from './WorkspaceMenu';
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog';

const own = { id: 'own', name: "ana's workspace", visibility: 'private', personal: true, role: 'editor', memberCount: 1 };
const team = { id: 'team', name: 'Data team', visibility: 'private', personal: false, role: 'owner', memberCount: 2 };

beforeEach(() => {
  for (const f of [apiListWorkspaces, apiCreateWorkspace, apiSelectWorkspace, apiWorkspaceMembers, apiSetWorkspaceMember, apiRemoveWorkspaceMember, apiRenameWorkspace, apiArchiveWorkspace]) f.mockReset();
  apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [own, team], canCreate: false });
  useAuthStore.setState({
    user: { id: 'ana', email: 'ana@example.com', onboardingCompleted: true, role: 'editor', permissions: [] },
    status: 'ready',
  } as never);
});

describe('WorkspaceMenu', () => {
  it('lists the workspaces, marks the current one, and switches by selecting then reloading', async () => {
    apiSelectWorkspace.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={reload} />);
    const current = await screen.findByTestId('workspace-menu-item-own');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.queryByTestId('workspace-menu-create')).toBeNull();

    fireEvent.click(screen.getByTestId('workspace-menu-item-team'));
    await waitFor(() => expect(apiSelectWorkspace).toHaveBeenCalledWith('team'));
    expect(reload).toHaveBeenCalled();
  });

  it('offers New workspace only when the account may create one, and lands in it', async () => {
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [own], canCreate: true });
    apiCreateWorkspace.mockResolvedValue({ ...team, id: 'new' });
    apiSelectWorkspace.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={reload} />);
    fireEvent.click(await screen.findByTestId('workspace-menu-create'));
    fireEvent.change(screen.getByTestId('workspace-menu-create-name'), { target: { value: 'Data team' } });
    fireEvent.submit(screen.getByTestId('workspace-menu-create-form'));
    await waitFor(() => expect(apiCreateWorkspace).toHaveBeenCalledWith('Data team'));
    await waitFor(() => expect(apiSelectWorkspace).toHaveBeenCalledWith('new'));
    expect(reload).toHaveBeenCalled();
  });

  it('shows the server’s reason when creating fails', async () => {
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [own], canCreate: true });
    apiCreateWorkspace.mockRejectedValue(new Error('Only an admin can create workspaces on this install.'));
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('workspace-menu-create'));
    fireEvent.change(screen.getByTestId('workspace-menu-create-name'), { target: { value: 'X' } });
    fireEvent.submit(screen.getByTestId('workspace-menu-create-form'));
    expect((await screen.findByTestId('workspace-menu-error')).textContent).toMatch(/only an admin/i);
  });
});

describe('WorkspaceSettingsDialog', () => {
  const members = [
    { userId: 'ana', email: 'ana@example.com', role: 'owner', personalOwner: false, addedBy: null, createdAt: '' },
    { userId: 'ben', email: 'ben@example.com', role: 'viewer', personalOwner: false, addedBy: 'ana@example.com', createdAt: '' },
  ];

  it('lets an owner change a role and remove a member, but not remove itself', async () => {
    apiWorkspaceMembers.mockResolvedValue(members);
    apiSetWorkspaceMember.mockResolvedValue(undefined);
    apiRemoveWorkspaceMember.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    const role = await screen.findByTestId('workspace-member-role-ben');
    expect(screen.queryByTestId('workspace-member-remove-ana')).toBeNull();
    fireEvent.change(role, { target: { value: 'editor' } });
    await waitFor(() => expect(apiSetWorkspaceMember).toHaveBeenCalledWith('team', 'ben', 'editor'));
    fireEvent.click(screen.getByTestId('workspace-member-remove-ben'));
    await waitFor(() => expect(apiRemoveWorkspaceMember).toHaveBeenCalledWith('team', 'ben'));
    confirm.mockRestore();
  });

  it('is read-only for a viewer, who can still leave', async () => {
    apiListWorkspaces.mockResolvedValue({ currentId: 'team', workspaces: [{ ...team, role: 'viewer' }], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue(members);
    apiRemoveWorkspaceMember.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const reload = vi.fn();
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={reload} />);
    await screen.findByTestId('workspace-member-ben');
    expect(screen.queryByTestId('workspace-member-role-ben')).toBeNull();
    expect((screen.getByTestId('workspace-settings-name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('workspace-settings-archive')).toBeNull();
    fireEvent.click(screen.getByTestId('workspace-settings-leave'));
    await waitFor(() => expect(apiRemoveWorkspaceMember).toHaveBeenCalledWith('team', 'ana'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('offers neither leave nor archive for a personal workspace', async () => {
    apiWorkspaceMembers.mockResolvedValue([{ ...members[0], personalOwner: true }]);
    render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} reload={vi.fn()} />);
    await screen.findByTestId('workspace-settings-members');
    await waitFor(() => expect(screen.getByTestId('workspace-settings-name')).toBeTruthy());
    expect(screen.queryByTestId('workspace-settings-leave')).toBeNull();
    expect(screen.queryByTestId('workspace-settings-archive')).toBeNull();
  });
});
