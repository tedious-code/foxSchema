/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared workspaces: creating them, choosing one, renaming and archiving,
 * and who is in them with what role.
 *
 * What a caller may do to a workspace comes from its role *in that
 * workspace* (`workspace.settings`, `workspace.members`), not from the
 * workspace the request happens to act in. Creating one is an install
 * permission (`workspace.create`, admin by default), or anyone's when the
 * admin turns on "Members can create workspaces".
 *
 * Two guards mirror the admin ones: a workspace always keeps an owner, and a
 * personal workspace always keeps the account it belongs to.
 */
import { randomUUID } from 'node:crypto';
import {
  isWorkspaceRole,
  permissionSatisfied,
  type AppRole,
  type Permission,
  type WorkspaceRole,
} from '@foxschema/shared';
import { getStore } from '../../database/store';
import type { MetadataStore } from '../../database/stores/types';
import { RbacModule } from '../../platform/authorization/rbac.service';
import { ServiceError } from '../../platform/contracts/actor';

export const MEMBERS_CREATE_KEY = 'workspaces.members_create';

export interface WorkspaceActor {
  userId: string;
  appRole: AppRole;
  /** Install permissions the request holds (`workspace.create`). */
  permissions: ReadonlySet<Permission>;
}

export interface WorkspaceListItem {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  /** The role someone gets by joining a public workspace. */
  joinRole: WorkspaceRole;
  personal: boolean;
  role: WorkspaceRole;
  memberCount: number;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  role: WorkspaceRole;
  /** The account whose personal workspace this is: its role follows the account. */
  personalOwner: boolean;
  addedBy: string | null;
  createdAt: string;
}

const NAME_MAX = 80;

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new ServiceError('invalid_input', 'Give the workspace a name.');
  if (name.length > NAME_MAX) throw new ServiceError('invalid_input', `Keep the name under ${NAME_MAX} characters.`);
  return name;
}

export async function membersCanCreate(store: MetadataStore): Promise<boolean> {
  const row = await store.get<{ value: string | null }>('SELECT "value" FROM app_settings WHERE "key" = ?', [
    MEMBERS_CREATE_KEY,
  ]);
  return row?.value === 'on';
}

/** One row of the admin's list: every workspace, private ones included. Names and people only — never its data. */
export interface AdminWorkspaceRow {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  /** Email of the account a personal workspace belongs to; null for shared ones. */
  personalOwner: string | null;
  owners: string[];
  memberCount: number;
  archived: boolean;
  /** Whether the admin asking is a member (and so can open it). */
  adminIsMember: boolean;
  createdAt: string;
}

export class WorkspaceDirectory {
  constructor(private rbac = new RbacModule()) {}

  private async workspace(store: MetadataStore, id: string) {
    const ws = await store.get<{ id: string; name: string; personal_owner_id: string | null; archived_at: string | null }>(
      'SELECT id, name, personal_owner_id, archived_at FROM workspaces WHERE id = ?',
      [id]
    );
    if (!ws || ws.archived_at) throw new ServiceError('not_found', 'Workspace not found');
    return ws;
  }

  private async roleIn(store: MetadataStore, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await store.get<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspaceId, userId]
    );
    return row && isWorkspaceRole(row.role) ? row.role : null;
  }

  /**
   * Refuse unless the actor may do `permission` in `workspaceId`. A
   * non-member gets not found, so a private workspace's id is not confirmed.
   */
  private async require(store: MetadataStore, actor: WorkspaceActor, workspaceId: string, permission: Permission) {
    const ws = await this.workspace(store, workspaceId);
    if (actor.appRole === 'admin') return ws;
    // Everyone runs the membership of their own workspace, whatever its role there.
    if (permission === 'workspace.members' && ws.personal_owner_id === actor.userId) return ws;
    const role = await this.roleIn(store, workspaceId, actor.userId);
    if (!role) throw new ServiceError('not_found', 'Workspace not found');
    if (!permissionSatisfied(await this.rbac.permissionsForRole(role), permission)) {
      throw new ServiceError('forbidden', `Permission denied: this needs "${permission}" in this workspace.`);
    }
    return ws;
  }

  async canCreate(actor: WorkspaceActor): Promise<boolean> {
    if (actor.appRole === 'admin' || actor.permissions.has('workspace.create')) return true;
    return membersCanCreate(await getStore());
  }

  /** The workspaces the account is in, personal first. */
  async listMine(userId: string): Promise<WorkspaceListItem[]> {
    const store = await getStore();
    const rows = await store.all<{
      id: string;
      name: string;
      visibility: string;
      join_role: string;
      personal_owner_id: string | null;
      role: string;
      member_count: number;
    }>(
      `SELECT w.id, w.name, w.visibility, w.join_role, w.personal_owner_id, m.role,
              (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ? AND w.archived_at IS NULL
        ORDER BY CASE WHEN w.personal_owner_id = ? THEN 0 ELSE 1 END, w.name`,
      [userId, userId]
    );
    return rows
      .filter((r) => isWorkspaceRole(r.role))
      .map((r) => ({
        id: r.id,
        name: r.name,
        visibility: r.visibility === 'public' ? 'public' : 'private',
        joinRole: isWorkspaceRole(r.join_role) ? r.join_role : 'viewer',
        personal: r.personal_owner_id === userId,
        role: r.role as WorkspaceRole,
        memberCount: Number(r.member_count),
      }));
  }

  async create(actor: WorkspaceActor, rawName: unknown): Promise<WorkspaceListItem> {
    if (!(await this.canCreate(actor))) {
      throw new ServiceError('forbidden', 'Only an admin can create workspaces on this install.');
    }
    const name = cleanName(rawName);
    const store = await getStore();
    const id = randomUUID();
    const now = new Date().toISOString();
    await store.run(
      'INSERT INTO workspaces (id, name, visibility, join_role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, 'private', 'viewer', actor.userId, now]
    );
    await store.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, actor.userId, 'owner', actor.userId, now]
    );
    return { id, name, visibility: 'private', joinRole: 'viewer', personal: false, role: 'owner', memberCount: 1 };
  }

  /** Make `workspaceId` the one this account's requests act in. */
  async select(userId: string, workspaceId: string): Promise<void> {
    const store = await getStore();
    await this.workspace(store, workspaceId);
    if (!(await this.roleIn(store, workspaceId, userId))) throw new ServiceError('not_found', 'Workspace not found');
    await store.upsert(
      'user_preferences',
      ['user_id'],
      { user_id: userId, last_workspace_id: workspaceId, updated_at: new Date().toISOString() },
      ['last_workspace_id', 'updated_at']
    );
  }

  async rename(actor: WorkspaceActor, workspaceId: string, rawName: unknown): Promise<void> {
    await this.updateSettings(actor, workspaceId, { name: rawName });
  }

  /**
   * Name, visibility and join role, each optional. A personal workspace stays
   * private: making it public would list one account's own connections to all.
   * Public → private keeps its members and hides it from everyone else.
   */
  async updateSettings(
    actor: WorkspaceActor,
    workspaceId: string,
    input: { name?: unknown; visibility?: unknown; joinRole?: unknown }
  ): Promise<void> {
    const store = await getStore();
    const ws = await this.require(store, actor, workspaceId, 'workspace.settings');
    const sets: string[] = [];
    const params: string[] = [];
    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(cleanName(input.name));
    }
    if (input.visibility !== undefined) {
      if (input.visibility !== 'private' && input.visibility !== 'public') {
        throw new ServiceError('invalid_input', "visibility must be 'private' or 'public'.");
      }
      if (input.visibility === 'public' && ws.personal_owner_id) {
        throw new ServiceError('conflict', 'A personal workspace stays private.');
      }
      sets.push('visibility = ?');
      params.push(input.visibility);
    }
    if (input.joinRole !== undefined) {
      // Never owner: anyone signed in can join a public workspace, and an
      // owner could remove the real owners and archive it.
      if (input.joinRole !== 'viewer' && input.joinRole !== 'editor') {
        throw new ServiceError('invalid_input', 'joinRole must be viewer or editor.');
      }
      sets.push('join_role = ?');
      params.push(input.joinRole);
    }
    if (sets.length === 0) throw new ServiceError('invalid_input', 'Nothing to change.');
    await store.run(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`, [...params, workspaceId]);
  }

  /** Public workspaces the account is not in yet: what anyone signed in may join. */
  async discover(userId: string): Promise<Array<{ id: string; name: string; joinRole: WorkspaceRole; memberCount: number }>> {
    const store = await getStore();
    const rows = await store.all<{ id: string; name: string; join_role: string; member_count: number }>(
      `SELECT w.id, w.name, w.join_role,
              (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
         FROM workspaces w
        WHERE w.visibility = 'public' AND w.archived_at IS NULL AND w.personal_owner_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?)
        ORDER BY w.name`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      joinRole: isWorkspaceRole(r.join_role) ? r.join_role : 'viewer',
      memberCount: Number(r.member_count),
    }));
  }

  /** Join a public workspace with its join role. A private one answers not found. */
  async join(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const store = await getStore();
    const ws = await store.get<{ visibility: string; join_role: string; personal_owner_id: string | null; archived_at: string | null }>(
      'SELECT visibility, join_role, personal_owner_id, archived_at FROM workspaces WHERE id = ?',
      [workspaceId]
    );
    if (!ws || ws.archived_at || ws.visibility !== 'public' || ws.personal_owner_id) {
      throw new ServiceError('not_found', 'Workspace not found');
    }
    const existing = await this.roleIn(store, workspaceId, userId);
    if (existing) return existing;
    const role: WorkspaceRole = isWorkspaceRole(ws.join_role) ? ws.join_role : 'viewer';
    await store.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, userId, role, userId, new Date().toISOString()]
    );
    return role;
  }

  /** Archive: hidden from everyone, its rows kept. A personal workspace cannot be. */
  async archive(actor: WorkspaceActor, workspaceId: string): Promise<void> {
    const store = await getStore();
    const ws = await this.require(store, actor, workspaceId, 'workspace.settings');
    if (ws.personal_owner_id) throw new ServiceError('conflict', 'A personal workspace cannot be archived.');
    await store.run('UPDATE workspaces SET archived_at = ? WHERE id = ?', [new Date().toISOString(), workspaceId]);
  }

  async members(actor: WorkspaceActor, workspaceId: string): Promise<WorkspaceMember[]> {
    const store = await getStore();
    const ws = await this.workspace(store, workspaceId);
    if (actor.appRole !== 'admin' && !(await this.roleIn(store, workspaceId, actor.userId))) {
      throw new ServiceError('not_found', 'Workspace not found');
    }
    const rows = await store.all<{ user_id: string; email: string; role: string; added_by: string | null; created_at: string }>(
      `SELECT m.user_id, u.email, m.role, a.email AS added_by, m.created_at
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN users a ON a.id = m.added_by
        WHERE m.workspace_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.email`,
      [workspaceId]
    );
    return rows
      .filter((r) => isWorkspaceRole(r.role))
      .map((r) => ({
        userId: r.user_id,
        email: r.email,
        role: r.role as WorkspaceRole,
        personalOwner: ws.personal_owner_id === r.user_id,
        addedBy: r.added_by,
        createdAt: r.created_at,
      }));
  }

  private async assertOwnerRemains(store: MetadataStore, workspaceId: string, leavingUserId: string) {
    const row = await store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND user_id != ?",
      [workspaceId, leavingUserId]
    );
    if (Number(row?.n ?? 0) === 0) {
      throw new ServiceError('conflict', 'A workspace needs an owner. Make someone else an owner first.');
    }
  }

  /**
   * Every workspace, for an admin: who owns it and how many are in it, but
   * nothing of what it holds. Opening one means joining it, which its members see.
   */
  async listAll(actor: WorkspaceActor, includeArchived = false): Promise<AdminWorkspaceRow[]> {
    if (actor.appRole !== 'admin') throw new ServiceError('forbidden', 'Only an admin sees every workspace.');
    const store = await getStore();
    const rows = await store.all<{
      id: string;
      name: string;
      visibility: string;
      personal_email: string | null;
      archived_at: string | null;
      created_at: string;
      member_count: number;
      admin_member: number;
    }>(
      `SELECT w.id, w.name, w.visibility, p.email AS personal_email, w.archived_at, w.created_at,
              (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count,
              (SELECT COUNT(*) FROM workspace_members y WHERE y.workspace_id = w.id AND y.user_id = ?) AS admin_member
         FROM workspaces w LEFT JOIN users p ON p.id = w.personal_owner_id
        WHERE ? = 1 OR w.archived_at IS NULL
        ORDER BY CASE WHEN w.personal_owner_id IS NULL THEN 0 ELSE 1 END, w.name`,
      [actor.userId, includeArchived ? 1 : 0]
    );
    const owners = await store.all<{ workspace_id: string; email: string }>(
      `SELECT m.workspace_id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.role = 'owner' ORDER BY u.email`
    );
    const ownersOf = new Map<string, string[]>();
    for (const o of owners) ownersOf.set(o.workspace_id, [...(ownersOf.get(o.workspace_id) ?? []), o.email]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      visibility: r.visibility === 'public' ? 'public' : 'private',
      personalOwner: r.personal_email,
      owners: ownersOf.get(r.id) ?? [],
      memberCount: Number(r.member_count),
      archived: !!r.archived_at,
      adminIsMember: Number(r.admin_member) > 0,
      createdAt: r.created_at,
    }));
  }

  /** Add an existing account directly, with a role. Admins only; owners invite (they ask, this adds). */
  async addMember(actor: WorkspaceActor, workspaceId: string, userId: string, role: unknown): Promise<void> {
    if (actor.appRole !== 'admin') throw new ServiceError('forbidden', 'Only an admin adds people directly. Invite them instead.');
    if (!isWorkspaceRole(role)) throw new ServiceError('invalid_input', 'role must be viewer, editor or owner.');
    const store = await getStore();
    await this.workspace(store, workspaceId);
    const user = await store.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) throw new ServiceError('not_found', 'User not found.');
    await store.upsert(
      'workspace_members',
      ['workspace_id', 'user_id'],
      { workspace_id: workspaceId, user_id: userId, role, added_by: actor.userId, created_at: new Date().toISOString() },
      ['role']
    );
  }

  async setMemberRole(actor: WorkspaceActor, workspaceId: string, userId: string, role: unknown): Promise<void> {
    if (!isWorkspaceRole(role)) throw new ServiceError('invalid_input', 'role must be viewer, editor or owner.');
    const store = await getStore();
    const ws = await this.require(store, actor, workspaceId, 'workspace.members');
    const current = await this.roleIn(store, workspaceId, userId);
    if (!current) throw new ServiceError('not_found', 'That account is not in this workspace.');
    if (ws.personal_owner_id === userId) {
      throw new ServiceError('conflict', 'Your role in your own workspace follows your account role.');
    }
    // A personal workspace always keeps its account, so it never runs out of an owner.
    if (current === 'owner' && role !== 'owner' && !ws.personal_owner_id) await this.assertOwnerRemains(store, workspaceId, userId);
    await store.run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [role, workspaceId, userId]);
  }

  /** Remove a member; anyone may remove themselves (leave). */
  async removeMember(actor: WorkspaceActor, workspaceId: string, userId: string): Promise<void> {
    const store = await getStore();
    const ws =
      userId === actor.userId
        ? await this.workspace(store, workspaceId)
        : await this.require(store, actor, workspaceId, 'workspace.members');
    const current = await this.roleIn(store, workspaceId, userId);
    if (!current) throw new ServiceError('not_found', 'That account is not in this workspace.');
    if (ws.personal_owner_id === userId) throw new ServiceError('conflict', 'Nobody leaves their own workspace.');
    if (current === 'owner' && !ws.personal_owner_id) await this.assertOwnerRemains(store, workspaceId, userId);
    await store.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    await store.run('UPDATE user_preferences SET last_workspace_id = NULL WHERE user_id = ? AND last_workspace_id = ?', [
      userId,
      workspaceId,
    ]);
  }
}
