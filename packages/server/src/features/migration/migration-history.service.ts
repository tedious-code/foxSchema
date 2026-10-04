import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { truncateForDisplay } from '../../database/stored-text';
import type { MigrationRunStatus } from '@foxschema/shared';

export type { MigrationRunStatus };

export interface MigrationObjectResult {
  name: string;
  type: string;
  action: string;
  status: string;
  error?: string;
}

/** Lightweight row for the history list (no large text columns). */
export interface MigrationRunSummary {
  id: string;
  status: MigrationRunStatus;
  dialect: string;
  host?: string;
  database?: string;
  schema?: string;
  objectCount: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** The committed migration this run applied, when it came from Git. */
  git?: { repoId: string; branch?: string; commit: string; path: string };
}

/** Full record including the script, snapshot, and per-object results. */
export interface MigrationRunDetail extends MigrationRunSummary {
  script?: string;
  snapshotDdl?: string;
  results: MigrationObjectResult[];
}

interface Row {
  id: string;
  status: MigrationRunStatus;
  dialect: string;
  target_host: string | null;
  database_name: string | null;
  schema: string | null;
  object_count: number;
  script: string | null;
  snapshot_ddl: string | null;
  results_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  git_repo_id?: string | null;
  git_branch?: string | null;
  git_commit?: string | null;
  git_path?: string | null;
}

// Bounds so the metadata DB can't grow unbounded.
const MAX_RUNS_PER_USER = 200;

/**
 * Per-user log of executed migrations. A row is created (RUNNING) when a
 * migration starts and finalized when it ends, so even an interrupted run
 * leaves a trace. No credentials are stored — only host/database/schema names.
 * The table is bounded: at most MAX_RUNS_PER_USER recent runs are kept per user.
 */
export class MigrationHistoryStore {
  /** Record the start of a migration; returns the run id. */
  async start(
    userId: string,
    input: {
      dialect: string;
      host?: string;
      database?: string;
      schema?: string;
      objectCount: number;
      script: string;
      /** The committed migration this run applies, when it came from Git. */
      git?: { repoId: string; branch?: string; commit: string; path: string };
    }
  ): Promise<string> {
    const id = randomUUID();
    const store = await getStore();
    await store.run(
      `INSERT INTO migration_runs
         (id, user_id, status, dialect, target_host, database_name, "schema", object_count, script, started_at,
          git_repo_id, git_branch, git_commit, git_path)
       VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        input.dialect,
        input.host ?? null,
        input.database ?? null,
        input.schema ?? null,
        input.objectCount,
        truncateForDisplay(input.script) ?? null,
        new Date().toISOString(),
        input.git?.repoId ?? null,
        input.git?.branch ?? null,
        input.git?.commit ?? null,
        input.git?.path ?? null,
      ]
    );
    await this.prune(userId);
    return id;
  }

  /** Keep only the most recent MAX_RUNS_PER_USER runs for a user. */
  private async prune(userId: string): Promise<void> {
    const store = await getStore();
    await store.run(
      `DELETE FROM migration_runs
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM migration_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?
            ) AS keep
          )`,
      [userId, userId, MAX_RUNS_PER_USER]
    );
  }

  /** Finalize a run with its outcome. */
  async finish(
    id: string,
    outcome: { status: MigrationRunStatus; results: MigrationObjectResult[]; snapshotDdl?: string; error?: string }
  ): Promise<void> {
    const store = await getStore();
    await store.run(
      `UPDATE migration_runs
          SET status = ?, results_json = ?, snapshot_ddl = ?, error = ?, finished_at = ?
        WHERE id = ?`,
      [
        outcome.status,
        JSON.stringify(outcome.results ?? []),
        truncateForDisplay(outcome.snapshotDdl) ?? null,
        outcome.error ?? null,
        new Date().toISOString(),
        id,
      ]
    );
  }

  private summary(r: Row): MigrationRunSummary {
    return {
      id: r.id,
      status: r.status,
      dialect: r.dialect,
      host: r.target_host ?? undefined,
      database: r.database_name ?? undefined,
      schema: r.schema ?? undefined,
      objectCount: r.object_count,
      error: r.error ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      ...(r.git_repo_id && r.git_commit && r.git_path
        ? { git: { repoId: r.git_repo_id, branch: r.git_branch ?? undefined, commit: r.git_commit, path: r.git_path } }
        : {}),
    };
  }

  async list(userId: string, limit = 100): Promise<MigrationRunSummary[]> {
    const store = await getStore();
    const rows = await store.all<Row>(
      `SELECT id, status, dialect, target_host, database_name, "schema", object_count, error, started_at, finished_at,
              git_repo_id, git_branch, git_commit, git_path
         FROM migration_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.map((r) => this.summary(r));
  }

  async get(userId: string, id: string): Promise<MigrationRunDetail | null> {
    const store = await getStore();
    const r = await store.get<Row>('SELECT * FROM migration_runs WHERE id = ? AND user_id = ?', [id, userId]);
    if (!r) return null;
    let results: MigrationObjectResult[] = [];
    try {
      results = r.results_json ? (JSON.parse(r.results_json) as MigrationObjectResult[]) : [];
    } catch {
      /* corrupt JSON — show empty */
    }
    return {
      ...this.summary(r),
      script: r.script ?? undefined,
      snapshotDdl: r.snapshot_ddl ?? undefined,
      results,
    };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run('DELETE FROM migration_runs WHERE id = ? AND user_id = ?', [id, userId]);
    return result.changes > 0;
  }

  /** Delete a set of runs owned by the user. Returns how many were removed. */
  async removeMany(userId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const store = await getStore();
    const placeholders = ids.map(() => '?').join(', ');
    const result = await store.run(
      `DELETE FROM migration_runs WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...ids]
    );
    return result.changes;
  }

  /** Delete every run for the user. Returns how many were removed. */
  async clear(userId: string): Promise<number> {
    const store = await getStore();
    const result = await store.run('DELETE FROM migration_runs WHERE user_id = ?', [userId]);
    return result.changes;
  }
}
