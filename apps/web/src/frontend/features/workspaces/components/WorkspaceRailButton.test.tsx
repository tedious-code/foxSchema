/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/platform/authStore';

const apiListWorkspaces = vi.fn();
const apiMyInvites = vi.fn();

vi.mock('../api/workspacesApi', () => ({
  apiListWorkspaces: (...args: unknown[]) => apiListWorkspaces(...args),
  apiMyInvites: (...args: unknown[]) => apiMyInvites(...args),
  apiSelectWorkspace: vi.fn(),
  apiCreateWorkspace: vi.fn(),
  apiAcceptInvite: vi.fn(),
  apiDeclineInvite: vi.fn(),
  apiDiscoverWorkspaces: vi.fn(),
  apiJoinWorkspace: vi.fn(),
}));

import { WorkspaceRailButton } from './WorkspaceRailButton';

beforeEach(() => {
  apiListWorkspaces.mockReset();
  apiMyInvites.mockReset();
  apiMyInvites.mockResolvedValue([]);
  apiListWorkspaces.mockResolvedValue({
    currentId: 'own',
    canCreate: false,
    workspaces: [
      {
        id: 'own',
        name: "Ana's workspace",
        visibility: 'private',
        joinRole: 'viewer',
        personal: true,
        role: 'owner',
        memberCount: 1,
      },
    ],
  });
  useAuthStore.setState({
    user: { id: 'ana', email: 'ana@example.com', onboardingCompleted: true, role: 'editor', permissions: [] },
    launch: false,
    status: 'ready',
  } as never);
});

describe('WorkspaceRailButton', () => {
  it('names the one open workspace and opens its menu', async () => {
    render(<WorkspaceRailButton />);
    const button = await screen.findByTestId('workspace-rail-btn');
    expect(button.textContent).toBe('A');
    expect(button.getAttribute('aria-label')).toBe("Workspace Ana's workspace");
    fireEvent.click(button);
    expect(await screen.findByTestId('workspace-menu')).toBeTruthy();
    expect(screen.getByText('One workspace at a time')).toBeTruthy();
  });

  it('closes its menu on Escape', async () => {
    render(<WorkspaceRailButton />);
    fireEvent.click(await screen.findByTestId('workspace-rail-btn'));
    await screen.findByTestId('workspace-rail-menu');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('workspace-rail-menu')).toBeNull());
  });

  it('marks the button when an invitation is waiting', async () => {
    apiMyInvites.mockResolvedValue([{ id: 'inv1' }]);
    render(<WorkspaceRailButton />);
    expect(await screen.findByTestId('workspace-rail-invites')).toBeTruthy();
  });

  it('stays off the rail until the launch session has an account', () => {
    useAuthStore.setState({ launch: true } as never);
    render(<WorkspaceRailButton />);
    expect(screen.queryByTestId('workspace-rail-btn')).toBeNull();
  });
});

describe('WorkspaceRailButton follows the server’s workspace', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reloads once when the editor was on another workspace than the server opened', async () => {
    // Switched elsewhere, or another account signed in on this browser: the
    // editor hydrated from the old workspace and would save its scripts into
    // the one that is open now.
    localStorage.setItem('foxschema-active-workspace', 'team-a');
    const reload = vi.fn();
    render(<WorkspaceRailButton reload={reload} />);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('foxschema-active-workspace')).toBe('own');
  });

  it('does not reload when they already agree, or on the first run', async () => {
    const reload = vi.fn();
    render(<WorkspaceRailButton reload={reload} />);
    expect(await screen.findByTestId('workspace-rail-btn')).toBeTruthy();
    expect(localStorage.getItem('foxschema-active-workspace')).toBe('own');
    render(<WorkspaceRailButton reload={reload} />);
    await screen.findAllByTestId('workspace-rail-btn');
    expect(reload).not.toHaveBeenCalled();
  });
});
