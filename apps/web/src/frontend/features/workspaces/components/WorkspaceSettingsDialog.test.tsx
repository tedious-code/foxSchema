/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The roles the dialog offers are the roles the server accepts: nobody gives
 * more than they can do, so a viewer sharing its own workspace is offered
 * viewer and nothing above it.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/platform/authStore';

const apiListWorkspaces = vi.fn();
const apiWorkspaceMembers = vi.fn();
const apiWorkspaceInvites = vi.fn();

vi.mock('../api/workspacesApi', () => ({
  apiListWorkspaces: (...a: unknown[]) => apiListWorkspaces(...a),
  apiWorkspaceMembers: (...a: unknown[]) => apiWorkspaceMembers(...a),
  apiWorkspaceInvites: (...a: unknown[]) => apiWorkspaceInvites(...a),
  apiArchiveWorkspace: vi.fn(),
  apiInviteToWorkspace: vi.fn(),
  apiRevokeWorkspaceInvite: vi.fn(),
  apiUpdateWorkspace: vi.fn(),
  apiRemoveWorkspaceMember: vi.fn(),
  apiRenameWorkspace: vi.fn(),
  apiSetWorkspaceMember: vi.fn(),
}));

import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog';

const personal = (role: string) => ({
  id: 'own',
  name: "ana's workspace",
  visibility: 'private',
  joinRole: 'viewer',
  personal: true,
  role,
  memberCount: 2,
});
const team = { id: 'team', name: 'Data team', visibility: 'private', joinRole: 'viewer', personal: false, role: 'owner', memberCount: 2 };
const guest = { userId: 'bo', email: 'bo@example.com', role: 'viewer', personalOwner: false, addedBy: null, createdAt: '' };
const self = (role: string) => ({ userId: 'ana', email: 'ana@example.com', role, personalOwner: true, addedBy: null, createdAt: '' });

function signIn(role: string) {
  useAuthStore.setState({
    user: { id: 'ana', email: 'ana@example.com', onboardingCompleted: true, role, permissions: [] },
    status: 'ready',
  } as never);
}

/** The roles a select offers, and which of them can be picked. */
function options(testId: string) {
  return [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((o) => ({ role: o.value, enabled: !o.disabled }));
}

beforeEach(() => {
  apiListWorkspaces.mockReset();
  apiWorkspaceMembers.mockReset();
  apiWorkspaceInvites.mockReset().mockResolvedValue([]);
});

describe('WorkspaceSettingsDialog · roles on offer', () => {
  it('a viewer sharing its own workspace is offered viewer, and told why not more', async () => {
    signIn('viewer');
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [personal('viewer')], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([self('viewer'), guest]);
    render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} />);

    await screen.findByTestId('workspace-member-role-bo');
    const expected = [
      { role: 'viewer', enabled: true },
      { role: 'editor', enabled: false },
      { role: 'owner', enabled: false },
    ];
    expect(options('workspace-invite-role')).toEqual(expected);
    expect(options('workspace-member-role-bo')).toEqual(expected);
    expect(screen.getByTestId('workspace-invite-ceiling').textContent).toMatch(/up to viewer/);
  });

  it('an editor account offers up to editor in its own workspace', async () => {
    signIn('editor');
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [personal('editor')], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([self('editor'), guest]);
    render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} />);

    await screen.findByTestId('workspace-member-role-bo');
    expect(options('workspace-invite-role').filter((o) => o.enabled).map((o) => o.role)).toEqual(['viewer', 'editor']);
  });

  it('an owner of a shared workspace, and an admin anywhere, are offered every role', async () => {
    signIn('editor');
    apiListWorkspaces.mockResolvedValue({ currentId: 'team', workspaces: [team], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([{ ...self('owner'), personalOwner: false }, guest]);
    const { unmount } = render(<WorkspaceSettingsDialog workspaceId="team" onClose={() => undefined} />);
    await screen.findByTestId('workspace-member-role-bo');
    expect(options('workspace-invite-role').every((o) => o.enabled)).toBe(true);
    expect(screen.queryByTestId('workspace-invite-ceiling')).toBeNull();
    unmount();

    signIn('admin');
    apiListWorkspaces.mockResolvedValue({ currentId: 'own', workspaces: [personal('viewer')], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([self('owner'), guest]);
    render(<WorkspaceSettingsDialog workspaceId="own" onClose={() => undefined} />);
    await screen.findByTestId('workspace-member-role-bo');
    expect(options('workspace-invite-role').every((o) => o.enabled)).toBe(true);
  });
});

describe('WorkspaceSettingsDialog · closing', () => {
  it('Escape closes it', async () => {
    signIn('editor');
    apiListWorkspaces.mockResolvedValue({ currentId: 'team', workspaces: [team], canCreate: false });
    apiWorkspaceMembers.mockResolvedValue([guest]);
    const onClose = vi.fn();
    render(<WorkspaceSettingsDialog workspaceId="team" onClose={onClose} />);
    await screen.findByTestId('workspace-member-role-bo');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
