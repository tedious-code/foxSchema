/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * /api/workspaces. The server keeps which workspace an account acts in, so
 * switching is `select` and a reload — every request after it, from any
 * tab, acts there.
 */
import { api } from '@/shared/api/client';

export type WorkspaceRole = 'viewer' | 'editor' | 'owner';

export interface WorkspaceItem {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  /** The role someone gets by joining it while it is public. */
  joinRole: WorkspaceRole;
  personal: boolean;
  role: WorkspaceRole;
  memberCount: number;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  role: WorkspaceRole;
  personalOwner: boolean;
  addedBy: string | null;
  createdAt: string;
}

export interface WorkspaceList {
  currentId: string;
  workspaces: WorkspaceItem[];
  canCreate: boolean;
}

const enc = encodeURIComponent;

export const apiListWorkspaces = (): Promise<WorkspaceList> => api.get('/workspaces');

export async function apiCreateWorkspace(name: string): Promise<WorkspaceItem> {
  return (await api.post<{ workspace: WorkspaceItem }>('/workspaces', { name })).workspace;
}

export async function apiSelectWorkspace(id: string): Promise<void> {
  await api.post(`/workspaces/${enc(id)}/select`, {});
}

export async function apiRenameWorkspace(id: string, name: string): Promise<void> {
  await api.patch(`/workspaces/${enc(id)}`, { name });
}

export async function apiUpdateWorkspace(
  id: string,
  settings: { visibility?: 'private' | 'public'; joinRole?: WorkspaceRole }
): Promise<void> {
  await api.patch(`/workspaces/${enc(id)}`, settings);
}

export interface PublicWorkspace {
  id: string;
  name: string;
  joinRole: WorkspaceRole;
  memberCount: number;
}

/** Public workspaces this account is not in yet. */
export async function apiDiscoverWorkspaces(): Promise<PublicWorkspace[]> {
  return (await api.get<{ workspaces: PublicWorkspace[] }>('/workspaces/discover')).workspaces;
}

export async function apiJoinWorkspace(id: string): Promise<WorkspaceRole> {
  return (await api.post<{ role: WorkspaceRole }>(`/workspaces/${enc(id)}/join`, {})).role;
}

export async function apiArchiveWorkspace(id: string): Promise<void> {
  await api.post(`/workspaces/${enc(id)}/archive`, {});
}

export async function apiWorkspaceMembers(id: string): Promise<WorkspaceMember[]> {
  return (await api.get<{ members: WorkspaceMember[] }>(`/workspaces/${enc(id)}/members`)).members;
}

export async function apiSetWorkspaceMember(id: string, userId: string, role: WorkspaceRole): Promise<void> {
  await api.put(`/workspaces/${enc(id)}/members/${enc(userId)}`, { role });
}

export async function apiRemoveWorkspaceMember(id: string, userId: string): Promise<void> {
  await api.delete(`/workspaces/${enc(id)}/members/${enc(userId)}`, {});
}

// --- Invites -----------------------------------------------------------------

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

/** When inviting made the account: how its code went out, and the code itself for an admin. */
export interface NewAccountCode {
  code?: string;
  link?: string;
  expiresAt: string;
  delivery: 'email' | 'log' | 'failed';
}

export async function apiInviteToWorkspace(
  id: string,
  email: string,
  role: WorkspaceRole
): Promise<{ invite: WorkspaceInvite; newAccount?: NewAccountCode }> {
  return api.post(`/workspaces/${enc(id)}/invites`, { email, role });
}

export async function apiWorkspaceInvites(id: string): Promise<WorkspaceInvite[]> {
  return (await api.get<{ invites: WorkspaceInvite[] }>(`/workspaces/${enc(id)}/invites`)).invites;
}

export async function apiRevokeWorkspaceInvite(id: string, inviteId: string): Promise<void> {
  await api.delete(`/workspaces/${enc(id)}/invites/${enc(inviteId)}`, {});
}

export async function apiMyInvites(): Promise<WorkspaceInvite[]> {
  return (await api.get<{ invites: WorkspaceInvite[] }>('/workspaces/invites')).invites;
}

export async function apiAcceptInvite(inviteId: string): Promise<string> {
  return (await api.post<{ workspaceId: string }>(`/workspaces/invites/${enc(inviteId)}/accept`, {})).workspaceId;
}

export async function apiDeclineInvite(inviteId: string): Promise<void> {
  await api.post(`/workspaces/invites/${enc(inviteId)}/decline`, {});
}

// --- Admin: every workspace --------------------------------------------------

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  personalOwner: string | null;
  owners: string[];
  memberCount: number;
  archived: boolean;
  adminIsMember: boolean;
  createdAt: string;
}

export async function apiAdminListWorkspaces(includeArchived = false): Promise<AdminWorkspaceRow[]> {
  return (
    await api.get<{ workspaces: AdminWorkspaceRow[] }>('/workspaces/all', {
      query: includeArchived ? { archived: '1' } : undefined,
    })
  ).workspaces;
}
