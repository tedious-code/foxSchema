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
