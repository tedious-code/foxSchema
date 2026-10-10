/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/app/store/authStore';

const apiAdminListWorkspaces = vi.fn();
const apiArchiveWorkspace = vi.fn();
const apiSelectWorkspace = vi.fn();
const apiSetWorkspaceMember = vi.fn();

vi.mock('@/features/workspaces', () => ({
  WorkspaceSettingsDialog: () => null,
  apiAdminListWorkspaces: (...a: unknown[]) => apiAdminListWorkspaces(...a),
  apiArchiveWorkspace: (...a: unknown[]) => apiArchiveWorkspace(...a),
  apiSelectWorkspace: (...a: unknown[]) => apiSelectWorkspace(...a),
  apiSetWorkspaceMember: (...a: unknown[]) => apiSetWorkspaceMember(...a),
}));

import { AdminWorkspacesPanel } from './AdminWorkspacesPanel';

const shared = { id: 'books', name: 'Private books', visibility: 'private', personalOwner: null, owners: ['ana@x.com'], memberCount: 2, archived: false, adminIsMember: false, createdAt: '' };
const personal = { ...shared, id: 'ben-own', name: "ben's workspace", personalOwner: 'ben@x.com', owners: [], memberCount: 1 };
const joined = { ...shared, id: 'ops', name: 'Ops', adminIsMember: true };

beforeEach(() => {
  for (const f of [apiAdminListWorkspaces, apiArchiveWorkspace, apiSelectWorkspace, apiSetWorkspaceMember]) f.mockReset();
  apiAdminListWorkspaces.mockResolvedValue([shared, personal, joined]);
  useAuthStore.setState({
    user: { id: 'admin', email: 'admin@x.com', onboardingCompleted: true, role: 'admin', permissions: [] },
    status: 'ready',
  } as never);
});

describe('AdminWorkspacesPanel', () => {
  it('lists every workspace with its owners and size, personal ones by whose they are', async () => {
    render(<AdminWorkspacesPanel reload={vi.fn()} />);
    expect((await screen.findByTestId('admin-workspace-books')).textContent).toMatch(/private · owners: ana@x.com · 2 members/);
    expect(screen.getByTestId('admin-workspace-ben-own').textContent).toMatch(/personal · ben@x.com/);
  });

  it('opens a workspace it is not in only by joining, after saying the members will see it', async () => {
    apiSetWorkspaceMember.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminWorkspacesPanel reload={vi.fn()} />);
    expect(await screen.findByTestId('admin-workspace-join-books')).toBeTruthy();
    expect(screen.queryByTestId('admin-workspace-open-books')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-workspace-join-books'));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/members will see you/i));
    await waitFor(() => expect(apiSetWorkspaceMember).toHaveBeenCalledWith('books', 'admin', 'owner'));
    confirm.mockRestore();
  });

  it('opens a workspace it is in by switching to it', async () => {
    apiSelectWorkspace.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<AdminWorkspacesPanel reload={reload} />);
    fireEvent.click(await screen.findByTestId('admin-workspace-open-ops'));
    await waitFor(() => expect(apiSelectWorkspace).toHaveBeenCalledWith('ops'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('archives shared workspaces only', async () => {
    apiArchiveWorkspace.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminWorkspacesPanel reload={vi.fn()} />);
    await screen.findByTestId('admin-workspace-books');
    expect(screen.queryByTestId('admin-workspace-archive-ben-own')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-workspace-archive-books'));
    await waitFor(() => expect(apiArchiveWorkspace).toHaveBeenCalledWith('books'));
    confirm.mockRestore();
  });

  it('can include archived workspaces', async () => {
    render(<AdminWorkspacesPanel reload={vi.fn()} />);
    await screen.findByTestId('admin-workspace-books');
    fireEvent.click(screen.getByTestId('admin-workspaces-show-archived'));
    await waitFor(() => expect(apiAdminListWorkspaces).toHaveBeenLastCalledWith(true));
  });
});
