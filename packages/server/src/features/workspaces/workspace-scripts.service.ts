/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL scripts stored on the workspace, so every member opens the same text.
 * A viewer can read them. An editor or owner can save and delete them.
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceRole } from '@foxschema/shared';
import { getStore } from '../../database/store';
import { ServiceError } from '../../platform/contracts/actor';
import { effectiveMemberRole } from '../../platform/workspaces/workspace.service';

const TITLE_MAX = 120;
const SQL_MAX = 200_000;

export interface WorkspaceScript {
  id: string;
  title: string;
  sql: string;
  updatedBy: string | null;
  updatedAt: string;
}

function cleanTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!title) throw new ServiceError('invalid_input', 'Give the script a name.');
  if (title.length > TITLE_MAX) {
    throw new ServiceError('invalid_input', `Keep the name under ${TITLE_MAX} characters.`);
  }
  return title;
}

function cleanSql(raw: unknown): string {
  const sql = typeof raw === 'string' ? raw : '';
  if (!sql.trim()) throw new ServiceError('invalid_input', 'The script is empty.');
  if (sql.length > SQL_MAX) throw new ServiceError('invalid_input', 'That script is too long.');
  return sql;
}

export class WorkspaceScripts {
  /**
   * The member's role as it takes effect. Capped like every other read: a
   * colleague stored as editor in a viewer's personal workspace is a viewer
   * there, so cannot save or delete its scripts.
   */
  private async roleIn(workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const role = await effectiveMemberRole(await getStore(), workspaceId, userId);
    if (!role) throw new ServiceError('not_found', 'Workspace not found');
    return role;
  }

  async list(userId: string, workspaceId: string): Promise<{ scripts: WorkspaceScript[]; canWrite: boolean }> {
    const role = await this.roleIn(workspaceId, userId);
    const store = await getStore();
    const rows = await store.all<{
      id: string;
      title: string;
      sql: string;
      email: string | null;
      updated_at: string;
    }>(
      `SELECT s.id, s.title, s."sql" AS sql, u.email, s.updated_at
         FROM workspace_scripts s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.workspace_id = ?
        ORDER BY s.updated_at DESC`,
      [workspaceId]
    );
    return {
      canWrite: role === 'editor' || role === 'owner',
      scripts: rows.map((row) => ({
        id: row.id,
        title: row.title,
        sql: row.sql,
        updatedBy: row.email,
        updatedAt: row.updated_at,
      })),
    };
  }

  /** Save under this title. The same name in the workspace updates that script. */
  async save(userId: string, workspaceId: string, titleRaw: unknown, sqlRaw: unknown): Promise<WorkspaceScript> {
    const role = await this.roleIn(workspaceId, userId);
    if (role === 'viewer') {
      throw new ServiceError('forbidden', 'Viewers can open workspace scripts. An editor saves them.');
    }
    const title = cleanTitle(titleRaw);
    const sql = cleanSql(sqlRaw);
    const store = await getStore();
    const now = new Date().toISOString();
    const existing = await store.get<{ id: string; created_by: string; created_at: string }>(
      'SELECT id, created_by, created_at FROM workspace_scripts WHERE workspace_id = ? AND lower(title) = lower(?)',
      [workspaceId, title]
    );
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await store.run(
        'UPDATE workspace_scripts SET title = ?, "sql" = ?, updated_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
        [title, sql, userId, now, id, workspaceId]
      );
    } else {
      await store.run(
        `INSERT INTO workspace_scripts
           (id, workspace_id, title, "sql", created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, workspaceId, title, sql, userId, userId, now, now]
      );
    }
    const email = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId]);
    return { id, title, sql, updatedBy: email?.email ?? null, updatedAt: now };
  }

  async remove(userId: string, workspaceId: string, scriptId: string): Promise<void> {
    const role = await this.roleIn(workspaceId, userId);
    if (role === 'viewer') {
      throw new ServiceError('forbidden', 'Viewers can open workspace scripts. An editor deletes them.');
    }
    const store = await getStore();
    const result = await store.run('DELETE FROM workspace_scripts WHERE id = ? AND workspace_id = ?', [
      scriptId,
      workspaceId,
    ]);
    if (result.changes === 0) throw new ServiceError('not_found', 'Script not found');
  }
}
