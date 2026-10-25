/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workspaces: what owns connections, secrets, history and runs.
 *
 * Every account has a personal workspace, made with the account. The
 * member's role in it mirrors the account role (an admin is its owner), so
 * a personal workspace grants nothing the account role did not. Shared
 * workspaces and their members come later; this file is the part every
 * request needs — which workspace it acts in, and with what role.
 *
 * The functions take the store so the startup backfill can use them before
 * `getStore()` has resolved.
 */
import { randomUUID } from 'node:crypto';
import {
  isAppRole,
  isWorkspaceRole,
  lowerWorkspaceRole,
  workspaceRoleAtMost,
  type AppRole,
  type WorkspaceRole,
} from '@foxschema/shared';
import type { MetadataStore } from '../../database/stores/types';
import { ServiceError } from '../contracts/actor';

export type { WorkspaceScope } from '../http/scope';

export interface ResolvedWorkspace {
  id: string;
  name: string;
  personal: boolean;
  role: WorkspaceRole;
}

/** The workspace role an account role carries into its personal workspace. */
export function personalRoleFor(accountRole: AppRole | string | null | undefined): WorkspaceRole {
  if (accountRole === 'admin') return 'owner';
  return isWorkspaceRole(accountRole) ? accountRole : 'viewer';
}

/**
 * The most anyone can do in a workspace. A shared one: owner. A personal one:
 * what its own account may do there. Sharing a personal workspace lends its
 * connections; it never lends more than the account holds — otherwise a viewer
 * could invite a colleague as owner, and between them run DDL and GRANT with
 * credentials an admin handed out for reading.
 */
export function workspaceRoleCeiling(
  personalOwnerId: string | null | undefined,
  personalOwnerAccountRole: string | null | undefined
): WorkspaceRole {
  return personalOwnerId ? personalRoleFor(personalOwnerAccountRole) : 'owner';
}

/**
 * `userId`'s role in `workspaceId` as it takes effect: the stored role, capped
 * at the workspace's ceiling. Null when not a member. The cap is applied on
 * read, so a membership granted before the ceiling existed, or an account
 * demoted since, cannot keep more than the ceiling allows.
 */
export async function effectiveMemberRole(
  store: MetadataStore,
  workspaceId: string,
  userId: string
): Promise<WorkspaceRole | null> {
  const row = await store.get<{ role: string; personal_owner_id: string | null; owner_role: string | null }>(
    `SELECT m.role, w.personal_owner_id, o.app_role AS owner_role
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN users o ON o.id = w.personal_owner_id
      WHERE m.workspace_id = ? AND m.user_id = ?`,
    [workspaceId, userId]
  );
  if (!row || !isWorkspaceRole(row.role)) return null;
  return lowerWorkspaceRole(row.role, workspaceRoleCeiling(row.personal_owner_id, row.owner_role));
}

/**
 * Refuse to give `role` in `workspaceId` when it is more than the granter may
 * do there. An admin may give any role. Everyone else gives at most their own
 * effective role — which in a personal workspace is its ceiling, and in a
 * shared one is owner for anyone allowed to manage members at all, unless an
 * admin widened `workspace.members` to a lesser role.
 */
export async function assertRoleGrantable(
  store: MetadataStore,
  actor: { userId: string; appRole: AppRole | string },
  workspaceId: string,
  role: WorkspaceRole
): Promise<void> {
  if (actor.appRole === 'admin') return;
  const own = (await effectiveMemberRole(store, workspaceId, actor.userId)) ?? 'viewer';
  if (!workspaceRoleAtMost(role, own)) {
    throw new ServiceError(
      'forbidden',
      `You can give at most the ${own} role here: nobody gives more than they can do themselves.`
    );
  }
}

/** "ana's workspace" for ana@example.com. */
export function personalWorkspaceName(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  return `${local || 'My'}'s workspace`;
}

/** The account's personal workspace id, created (with its membership) when missing. */
export async function ensurePersonalWorkspace(
  store: MetadataStore,
  userId: string,
  email: string,
  accountRole: AppRole | string | null | undefined
): Promise<string> {
  const role = personalRoleFor(accountRole);
  const existing = await store.get<{ id: string }>('SELECT id FROM workspaces WHERE personal_owner_id = ?', [userId]);
  const now = new Date().toISOString();
  const id = existing?.id ?? randomUUID();
  if (!existing) {
    try {
      await store.run(
        'INSERT INTO workspaces (id, name, visibility, join_role, personal_owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, personalWorkspaceName(email), 'private', 'viewer', userId, userId, now]
      );
    } catch (err) {
      // A concurrent request made it first (idx_workspaces_personal): use that one.
      const raced = await store.get<{ id: string }>('SELECT id FROM workspaces WHERE personal_owner_id = ?', [userId]);
      if (!raced) throw err;
      return ensurePersonalWorkspace(store, userId, email, accountRole);
    }
  }
  const member = existing
    ? await store.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [id, userId])
    : undefined;
  if (!member) {
    await store.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, userId, role, null, now]
    );
  }
  return id;
}

/** Keep the personal workspace role in step with the account role. */
export async function syncPersonalRole(store: MetadataStore, userId: string, accountRole: AppRole): Promise<void> {
  const ws = await store.get<{ id: string }>('SELECT id FROM workspaces WHERE personal_owner_id = ?', [userId]);
  if (!ws) return;
  await store.run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [
    personalRoleFor(accountRole),
    ws.id,
    userId,
  ]);
}

/** Tables a workspace owns. Each has `user_id` (who made the row) and `workspace_id`. */
export const WORKSPACE_OWNED_TABLES = [
  'connections',
  'app_secrets',
  'cloud_provider_credentials',
  'lokee_databases',
  'migration_runs',
  'data_migrate_runs',
] as const;

/**
 * At every startup: give each account without one its personal workspace,
 * and move rows that have no workspace into their author's. On upgrade that
 * is every row, so each account sees exactly what it saw before, with the
 * same permissions. Afterwards it is a cheap no-op — unless an older build
 * (or an old CLI) wrote rows with no workspace, which this rescues instead
 * of leaving invisible.
 */
export async function backfillWorkspaces(store: MetadataStore): Promise<void> {
  const missing = await store.all<{ id: string; email: string; app_role: string | null }>(
    `SELECT u.id, u.email, u.app_role FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.personal_owner_id = u.id)`
  );
  for (const user of missing) {
    await ensurePersonalWorkspace(store, user.id, user.email, isAppRole(user.app_role) ? user.app_role : null);
  }
  for (const table of WORKSPACE_OWNED_TABLES) {
    await store.run(
      `UPDATE ${table}
          SET workspace_id = (SELECT w.id FROM workspaces w WHERE w.personal_owner_id = ${table}.user_id)
        WHERE (workspace_id IS NULL OR workspace_id = 'local')
          AND EXISTS (SELECT 1 FROM workspaces w WHERE w.personal_owner_id = ${table}.user_id)`
    );
  }
}

async function memberWorkspace(
  store: MetadataStore,
  userId: string,
  workspaceId: string
): Promise<ResolvedWorkspace | null> {
  const row = await store.get<{
    id: string;
    name: string;
    personal_owner_id: string | null;
    owner_role: string | null;
    role: string;
  }>(
    `SELECT w.id, w.name, w.personal_owner_id, o.app_role AS owner_role, m.role
     FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
     LEFT JOIN users o ON o.id = w.personal_owner_id
     WHERE w.id = ? AND m.user_id = ? AND w.archived_at IS NULL`,
    [workspaceId, userId]
  );
  if (!row || !isWorkspaceRole(row.role)) return null;
  // The role this request acts with: capped like everywhere else (effectiveMemberRole).
  const role = lowerWorkspaceRole(row.role, workspaceRoleCeiling(row.personal_owner_id, row.owner_role));
  return { id: row.id, name: row.name, personal: row.personal_owner_id === userId, role };
}

/**
 * The workspace a request acts in.
 *
 * Asked for by id (the `X-Fox-Workspace` header): it must be a workspace the
 * account is a member of, else 404 — never 403, which would confirm that a
 * private workspace's id exists. Not asked for: the last one used, else the
 * personal workspace (created if an older code path made the account
 * without one).
 */
export async function resolveWorkspace(
  store: MetadataStore,
  user: { id: string; email: string; role: AppRole },
  requestedId: string | undefined
): Promise<ResolvedWorkspace> {
  if (requestedId) {
    const found = await memberWorkspace(store, user.id, requestedId);
    if (!found) throw new ServiceError('not_found', 'Workspace not found');
    return found;
  }
  const pref = await store.get<{ last_workspace_id: string | null }>(
    'SELECT last_workspace_id FROM user_preferences WHERE user_id = ?',
    [user.id]
  );
  if (pref?.last_workspace_id) {
    const last = await memberWorkspace(store, user.id, pref.last_workspace_id);
    if (last) return last;
  }
  const personalId = await ensurePersonalWorkspace(store, user.id, user.email, user.role);
  const personal = await memberWorkspace(store, user.id, personalId);
  if (!personal) throw new ServiceError('failed', 'Could not open your workspace');
  return personal;
}
