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
const apiMyInvites = vi.fn();
const apiAcceptInvite = vi.fn();
const apiDeclineInvite = vi.fn();
const apiInviteToWorkspace = vi.fn();
const apiWorkspaceInvites = vi.fn();
const apiRevokeWorkspaceInvite = vi.fn();
const apiUpdateWorkspace = vi.fn();
const apiDiscoverWorkspaces = vi.fn();
const apiJoinWorkspace = vi.fn();

vi.mock('../api/workspacesApi', () => ({
  apiListWorkspaces: (...a: unknown[]) => apiListWorkspaces(...a),
  apiCreateWorkspace: (...a: unknown[]) => apiCreateWorkspace(...a),
  apiSelectWorkspace: (...a: unknown[]) => apiSelectWorkspace(...a),
  apiWorkspaceMembers: (...a: unknown[]) => apiWorkspaceMembers(...a),
  apiSetWorkspaceMember: (...a: unknown[]) => apiSetWorkspaceMember(...a),
  apiRemoveWorkspaceMember: (...a: unknown[]) => apiRemoveWorkspaceMember(...a),
  apiRenameWorkspace: (...a: unknown[]) => apiRenameWorkspace(...a),
  apiArchiveWorkspace: (...a: unknown[]) => apiArchiveWorkspace(...a),
  apiMyInvites: (...a: unknown[]) => apiMyInvites(...a),
  apiAcceptInvite: (...a: unknown[]) => apiAcceptInvite(...a),
  apiDeclineInvite: (...a: unknown[]) => apiDeclineInvite(...a),
  apiInviteToWorkspace: (...a: unknown[]) => apiInviteToWorkspace(...a),
  apiWorkspaceInvites: (...a: unknown[]) => apiWorkspaceInvites(...a),
  apiRevokeWorkspaceInvite: (...a: unknown[]) => apiRevokeWorkspaceInvite(...a),
  apiUpdateWorkspace: (...a: unknown[]) => apiUpdateWorkspace(...a),
  apiDiscoverWorkspaces: (...a: unknown[]) => apiDiscoverWorkspaces(...a),
  apiJoinWorkspace: (...a: unknown[]) => apiJoinWorkspace(...a),
}));

import { WorkspaceMenu } from './WorkspaceMenu';
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog';

const own = { id: 'own', name: "ana's workspace", visibility: 'private', joinRole: 'viewer', personal: true, role: 'editor', memberCount: 1 };
const team = { id: 'team', name: 'Data team', visibility: 'private', joinRole: 'viewer', personal: false, role: 'owner', memberCount: 2 };

beforeEach(() => {
  for (const f of [apiListWorkspaces, apiCreateWorkspace, apiSelectWorkspace, apiWorkspaceMembers, apiSetWorkspaceMember, apiRemoveWorkspaceMember, apiRenameWorkspace, apiArchiveWorkspace, apiMyInvites, apiAcceptInvite, apiDeclineInvite, apiInviteToWorkspace, apiWorkspaceInvites, apiRevokeWorkspaceInvite, apiUpdateWorkspace, apiDiscoverWorkspaces, apiJoinWorkspace]) f.mockReset();
  apiMyInvites.mockResolvedValue([]);
  apiWorkspaceInvites.mockResolvedValue([]);
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

describe('invitations', () => {
  const invite = { id: 'inv1', workspaceId: 'team', workspaceName: 'Data team', email: 'ana@example.com', role: 'editor', invitedBy: 'boss@example.com', createdAt: '', expiresAt: '' };

  it('the menu shows invitations; accepting joins and goes there', async () => {
    apiMyInvites.mockResolvedValue([invite]);
    apiAcceptInvite.mockResolvedValue('team');
    apiSelectWorkspace.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={reload} />);
    expect((await screen.findByTestId('workspace-menu-invite-inv1')).textContent).toMatch(/data team.*editor/i);
    fireEvent.click(screen.getByTestId('workspace-menu-invite-accept-inv1'));
    await waitFor(() => expect(apiAcceptInvite).toHaveBeenCalledWith('inv1'));
    await waitFor(() => expect(apiSelectWorkspace).toHaveBeenCalledWith('team'));
    expect(reload).toHaveBeenCalled();
  });

  it('declining drops the invitation without joining', async () => {
    apiMyInvites.mockResolvedValue([invite]);
    apiDeclineInvite.mockResolvedValue(undefined);
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('workspace-menu-invite-decline-inv1'));
    await waitFor(() => expect(screen.queryByTestId('workspace-menu-invite-inv1')).toBeNull());
    expect(apiAcceptInvite).not.toHaveBeenCalled();
  });

  it('settings: inviting an email with no account shows the code to pass on', async () => {
    apiWorkspaceMembers.mockResolvedValue([]);
    apiInviteToWorkspace.mockResolvedValue({ invite, newAccount: { code: 'ABCD-EFGH', link: '', expiresAt: '', delivery: 'log' } });
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('workspace-invite-email'), { target: { value: 'New@Example.com' } });
    fireEvent.change(screen.getByTestId('workspace-invite-role'), { target: { value: 'editor' } });
    fireEvent.submit(screen.getByTestId('workspace-invite-form'));
    await waitFor(() => expect(apiInviteToWorkspace).toHaveBeenCalledWith('team', 'new@example.com', 'editor'));
    expect((await screen.findByTestId('workspace-invite-new-account-code')).textContent).toBe('ABCD-EFGH');
  });

  it('settings: everyone may invite into their own workspace, even as a viewer there', async () => {
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [{ ...own, role: 'viewer' }], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([]);
    render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} reload={vi.fn()} />);
    expect(await screen.findByTestId('workspace-invite-form')).toBeTruthy();
  });

  it('settings: a viewer in a shared workspace cannot invite', async () => {
    apiListWorkspaces.mockResolvedValue({ currentId: 'team', workspaces: [{ ...team, role: 'viewer' }], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([]);
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    await screen.findByTestId('workspace-settings-members');
    await waitFor(() => expect(screen.getByTestId('workspace-settings-name')).toBeTruthy());
    expect(screen.queryByTestId('workspace-invite-form')).toBeNull();
  });
});

describe('public workspaces', () => {
  it('the menu lists public workspaces on request; joining goes there', async () => {
    apiDiscoverWorkspaces.mockResolvedValue([{ id: 'pub', name: 'Open data', joinRole: 'viewer', memberCount: 4 }]);
    apiJoinWorkspace.mockResolvedValue('viewer');
    apiSelectWorkspace.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={reload} />);
    fireEvent.click(await screen.findByTestId('workspace-menu-browse'));
    expect((await screen.findByTestId('workspace-menu-public-pub')).textContent).toMatch(/open data.*4 members · joins as viewer/i);
    fireEvent.click(screen.getByTestId('workspace-menu-public-join-pub'));
    await waitFor(() => expect(apiJoinWorkspace).toHaveBeenCalledWith('pub'));
    await waitFor(() => expect(apiSelectWorkspace).toHaveBeenCalledWith('pub'));
    expect(reload).toHaveBeenCalled();
  });

  it('says so when there is none to join', async () => {
    apiDiscoverWorkspaces.mockResolvedValue([]);
    render(<WorkspaceMenu onOpenSettings={() => undefined} reload={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('workspace-menu-browse'));
    expect(await screen.findByTestId('workspace-menu-public-empty')).toBeTruthy();
  });

  it('an owner makes a workspace public and picks the join role', async () => {
    apiWorkspaceMembers.mockResolvedValue([]);
    apiUpdateWorkspace.mockResolvedValue(undefined);
    apiListWorkspaces
      .mockResolvedValueOnce({ currentId: 'team', workspaces: [team], canCreate: false })
      .mockResolvedValue({ currentId: 'team', workspaces: [{ ...team, visibility: 'public' }], canCreate: false });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('workspace-settings-visibility-select'), { target: { value: 'public' } });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/use its saved connections/i));
    confirm.mockRestore();
    await waitFor(() => expect(apiUpdateWorkspace).toHaveBeenCalledWith('team', { visibility: 'public' }));
    fireEvent.change(await screen.findByTestId('workspace-settings-join-role'), { target: { value: 'editor' } });
    await waitFor(() => expect(apiUpdateWorkspace).toHaveBeenCalledWith('team', { joinRole: 'editor' }));
    const roles = [...(screen.getByTestId('workspace-settings-join-role') as HTMLSelectElement).options].map((o) => o.value);
    expect(roles).toEqual(['viewer', 'editor']);
  });

  it('does not go public unless confirmed', async () => {
    apiWorkspaceMembers.mockResolvedValue([]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('workspace-settings-visibility-select'), { target: { value: 'public' } });
    expect(apiUpdateWorkspace).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('offers no visibility for a personal workspace, nor to a viewer', async () => {
    apiWorkspaceMembers.mockResolvedValue([]);
    const { unmount } = render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} reload={vi.fn()} />);
    await screen.findByTestId('workspace-settings-members');
    await waitFor(() => expect((screen.getByTestId('workspace-settings-name') as HTMLInputElement).value).not.toBe(''));
    expect(screen.queryByTestId('workspace-settings-visibility')).toBeNull();
    unmount();
    apiListWorkspaces.mockResolvedValue({ currentId: 'team', workspaces: [{ ...team, role: 'viewer' }], canCreate: false });
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} reload={vi.fn()} />);
    await screen.findByTestId('workspace-settings-members');
    await waitFor(() => expect((screen.getByTestId('workspace-settings-name') as HTMLInputElement).value).toBe('Data team'));
    expect(screen.queryByTestId('workspace-settings-visibility')).toBeNull();
  });
});

