/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inviting people into a workspace. An invite asks; it never adds: nobody
 * lands in a workspace they did not accept.
 *
 * Inviting an email with no account makes the account (as `inviteUser`
 * does, account role viewer), which only an admin can do — unless the admin
 * turns on "Workspace owners can invite new people". The invite waits for
 * that account's first sign-in.
 */
import { randomUUID } from 'node:crypto';
import {
  isWorkspaceRole,
  permissionSatisfied,
  type WorkspaceRole,
} from '@foxschema/shared';
import { getStore } from '../../database/store';
import type { MetadataStore } from '../../database/stores/types';
import { RbacModule } from '../authorization/rbac.service';
import { AuthModule, type IssuedCode } from '../auth/auth.service';
import { ServiceError } from '../../platform/contracts/actor';
import type { WorkspaceActor } from './workspace-directory.service';

export const OWNERS_INVITE_NEW_KEY = 'workspaces.owners_invite_new';
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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

export async function ownersCanInviteNew(store: MetadataStore): Promise<boolean> {
  const row = await store.get<{ value: string | null }>('SELECT "value" FROM app_settings WHERE "key" = ?', [
    OWNERS_INVITE_NEW_KEY,
  ]);
  return row?.value === 'on';
}

const PENDING = 'i.accepted_at IS NULL AND i.declined_at IS NULL AND i.expires_at > ?';

export class WorkspaceInvites {
  constructor(
    private rbac = new RbacModule(),
    private auth = new AuthModule()
  ) {}

  private async liveWorkspace(store: MetadataStore, id: string) {
    const ws = await store.get<{ id: string; name: string; personal_owner_id: string | null; archived_at: string | null }>(
      'SELECT id, name, personal_owner_id, archived_at FROM workspaces WHERE id = ?',
      [id]
    );
    if (!ws || ws.archived_at) throw new ServiceError('not_found', 'Workspace not found');
    return ws;
  }

  /**
   * Throw unless `actor` may manage members of `workspaceId`: admins
   * anywhere, everyone in their own workspace, otherwise `workspace.members`.
   */
  private async requireMembers(store: MetadataStore, actor: WorkspaceActor, workspaceId: string) {
    const ws = await this.liveWorkspace(store, workspaceId);
    if (actor.appRole === 'admin' || ws.personal_owner_id === actor.userId) return ws;
    const row = await store.get<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspaceId, actor.userId]
    );
    if (!row || !isWorkspaceRole(row.role)) throw new ServiceError('not_found', 'Workspace not found');
    if (!permissionSatisfied(await this.rbac.permissionsForRole(row.role), 'workspace.members')) {
      throw new ServiceError('forbidden', 'Only someone who manages members here can invite.');
    }
    return ws;
  }

  /**
   * Invite `email` with `role`. Returns the invite, and — when this made the
   * account — the one-time account code to pass on (email it, or hand it over).
   */
  async invite(
    actor: WorkspaceActor,
    workspaceId: string,
    rawEmail: unknown,
    role: unknown
  ): Promise<{ invite: WorkspaceInvite; newAccount?: IssuedCode }> {
    if (!isWorkspaceRole(role)) throw new ServiceError('invalid_input', 'role must be viewer, editor or owner.');
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ServiceError('invalid_input', 'Enter an email address.');
    const store = await getStore();
    const ws = await this.requireMembers(store, actor, workspaceId);

    let user = await store.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
    let newAccount: IssuedCode | undefined;
    if (user) {
      const member = await store.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
        workspaceId,
        user.id,
      ]);
      if (member) throw new ServiceError('conflict', `${email} is already in this workspace.`);
    } else {
      if (actor.appRole !== 'admin' && !(await ownersCanInviteNew(store))) {
        throw new ServiceError(
          'forbidden',
          `${email} has no account here, and only an admin can add new people. Ask an admin to add them first.`
        );
      }
      const made = await this.auth.inviteUser(email, 'viewer');
      user = { id: made.user.id };
      newAccount = made.invite;
    }

    // One pending invite per person and workspace: a new one replaces it.
    const now = new Date();
    await store.run(
      'DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND declined_at IS NULL',
      [workspaceId, email]
    );
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    await store.run(
      `INSERT INTO workspace_invites (id, workspace_id, user_id, email, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, user.id, email, role, actor.userId, now.toISOString(), expiresAt]
    );
    const inviter = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [actor.userId]);
    return {
      invite: {
        id,
        workspaceId,
        workspaceName: ws.name,
        email,
        role,
        invitedBy: inviter?.email ?? '',
        createdAt: now.toISOString(),
        expiresAt,
      },
      ...(newAccount ? { newAccount } : {}),
    };
  }

  private async pending(store: MetadataStore, where: string, params: (string | number)[]): Promise<WorkspaceInvite[]> {
    const rows = await store.all<{
      id: string;
      workspace_id: string;
      name: string;
      email: string;
      role: string;
      inviter: string | null;
      created_at: string;
      expires_at: string;
    }>(
      `SELECT i.id, i.workspace_id, w.name, i.email, i.role, u.email AS inviter, i.created_at, i.expires_at
         FROM workspace_invites i
         JOIN workspaces w ON w.id = i.workspace_id AND w.archived_at IS NULL
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE ${PENDING} AND ${where}
        ORDER BY i.created_at DESC`,
      [new Date().toISOString(), ...params]
    );
    return rows
      .filter((r) => isWorkspaceRole(r.role))
      .map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        workspaceName: r.name,
        email: r.email,
        role: r.role as WorkspaceRole,
        invitedBy: r.inviter ?? '',
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }));
  }

  /** Pending invites into a workspace, for those who manage its members. */
  async listForWorkspace(actor: WorkspaceActor, workspaceId: string): Promise<WorkspaceInvite[]> {
    const store = await getStore();
    await this.requireMembers(store, actor, workspaceId);
    return this.pending(store, 'i.workspace_id = ?', [workspaceId]);
  }

  async revoke(actor: WorkspaceActor, workspaceId: string, inviteId: string): Promise<void> {
    const store = await getStore();
    await this.requireMembers(store, actor, workspaceId);
    const result = await store.run(
      'DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL',
      [inviteId, workspaceId]
    );
    if (result.changes === 0) throw new ServiceError('not_found', 'Invite not found');
  }

  /** The invites waiting for this account. */
  async mine(userId: string): Promise<WorkspaceInvite[]> {
    return this.pending(await getStore(), 'i.user_id = ?', [userId]);
  }

  private async ownPending(store: MetadataStore, userId: string, inviteId: string) {
    const [invite] = await this.pending(store, 'i.id = ? AND i.user_id = ?', [inviteId, userId]);
    if (!invite) throw new ServiceError('not_found', 'Invite not found, or it has expired.');
    return invite;
  }

  /** Join with the invited role. Returns the workspace id. */
  async accept(userId: string, inviteId: string): Promise<string> {
    const store = await getStore();
    const invite = await this.ownPending(store, userId, inviteId);
    const row = await store.get<{ invited_by: string }>('SELECT invited_by FROM workspace_invites WHERE id = ?', [inviteId]);
    const now = new Date().toISOString();
    const already = await store.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
      invite.workspaceId,
      userId,
    ]);
    if (!already) {
      await store.run(
        'INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
        [invite.workspaceId, userId, invite.role, row?.invited_by ?? null, now]
      );
    }
    await store.run('UPDATE workspace_invites SET accepted_at = ? WHERE id = ?', [now, inviteId]);
    return invite.workspaceId;
  }

  async decline(userId: string, inviteId: string): Promise<void> {
    const store = await getStore();
    await this.ownPending(store, userId, inviteId);
    await store.run('UPDATE workspace_invites SET declined_at = ? WHERE id = ?', [new Date().toISOString(), inviteId]);
  }
}
