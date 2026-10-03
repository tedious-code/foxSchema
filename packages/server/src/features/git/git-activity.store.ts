/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who did what to a Git repository (`git_activity`).
 *
 * Push and pull use the repository's one stored token, so the remote sees a
 * single identity for everyone; the commits carry their authors, but not who
 * pushed them, pulled, or changed the repository's settings. This is the only
 * place that knows. Rows are never edited or pruned, and outlive the
 * repository they describe.
 */
import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';

export type GitAction = 'repo.added' | 'repo.edited' | 'repo.removed' | 'branch.created' | 'committed' | 'pushed' | 'pulled';

export interface GitActivity {
  id: string;
  action: GitAction;
  /** What changed, in a few named fields; never a token. */
  detail: Record<string, unknown>;
  userEmail: string | null;
  at: string;
}

export class GitActivityStore {
  /** Record an action. Never fails the caller: the action itself already happened. */
  async record(repoId: string, action: GitAction, userId: string | undefined, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      const store = await getStore();
      await store.run('INSERT INTO git_activity (id, repo_id, action, detail, user_id, at) VALUES (?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        repoId,
        action,
        JSON.stringify(detail),
        userId ?? null,
        new Date().toISOString(),
      ]);
    } catch {
      /* an audit write that fails must not turn a done push into an error */
    }
  }

  /** The repository's activity, newest first. */
  async list(repoId: string, limit = 100): Promise<GitActivity[]> {
    const store = await getStore();
    const rows = await store.all<{ id: string; action: GitAction; detail: string | null; email: string | null; at: string }>(
      `SELECT a.id, a.action, a.detail, u.email, a.at
         FROM git_activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.repo_id = ?
        ORDER BY a.at DESC
        LIMIT ?`,
      [repoId, Math.min(Math.max(limit, 1), 500)]
    );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {},
      userEmail: r.email,
      at: r.at,
    }));
  }
}
