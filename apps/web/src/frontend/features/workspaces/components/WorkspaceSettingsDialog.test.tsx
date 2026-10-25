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

/** Opens the dialog as an account with `accountRole`, on `workspace` with these members. */
async function openAs(accountRole: string, workspace: object & { id: string }, members: object[], onClose = () => undefined) {
  signIn(accountRole);
  apiListWorkspaces.mockResolvedValue({ currentId: workspace.id, workspaces: [workspace], canCreate: false });
  apiWorkspaceMembers.mockResolvedValue(members);
  const view = render(<WorkspaceSettingsDialog workspaceId={workspace.id} onClose={onClose} />);
  await screen.findByTestId('workspace-member-role-bo');
  return view;
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
    await openAs('viewer', personal('viewer'), [self('viewer'), guest]);
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
    await openAs('editor', personal('editor'), [self('editor'), guest]);
    expect(options('workspace-invite-role').filter((o) => o.enabled).map((o) => o.role)).toEqual(['viewer', 'editor']);
  });

  it('an owner of a shared workspace, and an admin anywhere, are offered every role', async () => {
    const { unmount } = await openAs('editor', team, [{ ...self('owner'), personalOwner: false }, guest]);
    expect(options('workspace-invite-role').every((o) => o.enabled)).toBe(true);
    expect(screen.queryByTestId('workspace-invite-ceiling')).toBeNull();
    unmount();

    await openAs('admin', personal('viewer'), [self('owner'), guest]);
    expect(options('workspace-invite-role').every((o) => o.enabled)).toBe(true);
  });
});

describe('WorkspaceSettingsDialog · closing', () => {
  it('Escape closes it', async () => {
    const onClose = vi.fn();
    await openAs('editor', team, [guest], onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Escape calls the onClose of the latest render', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = await openAs('editor', team, [guest], first);
    rerender(<WorkspaceSettingsDialog workspaceId="team" onClose={latest} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });
});
