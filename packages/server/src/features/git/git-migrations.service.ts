/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Migrations as committed files: preview, commit, read back, and which ones
 * a database has not had yet.
 *
 * The file format lives in @foxschema/sql (`buildMigrationFile` /
 * `parseMigrationFile`), so the browser previews exactly what is committed.
 * What ran where is in `git_applied`, which — unlike migration_runs — is
 * never pruned.
 */
import { randomUUID } from 'node:crypto';
import {
  buildMigrationFile,
  migrationFileName,
  parseMigrationFile,
  type MigrationFileHeader,
  type MigrationStep,
} from '@foxschema/sql';
import { getStore } from '../../database/store';
import { GitRepoService, GitOperationError, type GitAuthor } from './git-repo.service';
import { GitReposStore } from './git-repos.store';

export interface PlanInput {
  steps: MigrationStep[];
  note: string;
  dialect: string;
  target?: string;
  source?: string;
}

export interface CommitInput extends PlanInput {
  branch: string;
  /** Push the branch right after committing. */
  push?: boolean;
}

export interface AppliedRecord {
  path: string;
  commit: string;
  status: string;
  appliedAt: string;
  appliedBy: string | null;
}

export interface MigrationListing {
  path: string;
  fileName: string;
  header: MigrationFileHeader | null;
  /** Why the file could not be read, when it could not. */
  error?: string;
  applied: AppliedRecord | null;
  /** Not applied to the chosen database yet, and written for its dialect. */
  incoming: boolean;
}

/** Statuses that mean a committed migration has been applied. */
const APPLIED = new Set(['SUCCESS', 'PARTIAL_SUCCESS']);

export class GitMigrationsService {
  constructor(
    private repos = new GitReposStore(),
    private git = new GitRepoService(repos)
  ) {}

  private header(input: PlanInput, author: GitAuthor, when: Date): MigrationFileHeader {
    return {
      note: input.note,
      dialect: input.dialect,
      target: input.target,
      source: input.source,
      author: author.email,
      created: when.toISOString(),
    };
  }

  /** The file a commit would add, for review. Nothing is written. */
  async preview(repoId: string, input: PlanInput, author: GitAuthor) {
    const repo = await this.repos.get(repoId);
    if (!repo) throw new GitOperationError('Repository not found.');
    const when = new Date();
    const built = buildMigrationFile(this.header(input, author, when), input.steps ?? []);
    const fileName = migrationFileName(input.note, when);
    return { fileName, path: repo.folder ? `${repo.folder}/${fileName}` : fileName, content: built.content, scrubbed: built.scrubbed };
  }

  /** Commit the plan as a new file on `branch`, and push when asked. */
  async commit(repoId: string, input: CommitInput, author: GitAuthor) {
    if (!(await this.repos.get(repoId))) throw new GitOperationError('Repository not found.');
    const when = new Date();
    const built = buildMigrationFile(this.header(input, author, when), input.steps ?? []);
    const fileName = migrationFileName(input.note, when);
    const { oid, path } = await this.git.commitFile(repoId, {
      branch: input.branch,
      fileName,
      content: built.content,
      message: input.note.trim(),
      author,
    });
    let pushed = false;
    let pushError: string | undefined;
    if (input.push) {
      try {
        await this.git.push(repoId, input.branch);
        pushed = true;
      } catch (error) {
        // The commit stands; pushing can be retried from the branch view.
        pushError = error instanceof Error ? error.message : String(error);
      }
    }
    return { commit: oid, path, fileName, scrubbed: built.scrubbed, pushed, ...(pushError ? { pushError } : {}) };
  }

  /** A committed migration's header and steps, at a branch or commit. */
  async read(repoId: string, ref: string, path: string) {
    const content = await this.git.readFile(repoId, ref, path);
    if (content === null) throw new GitOperationError(`${path} is not on ${ref}.`);
    return { content, ...parseMigrationFile(content) };
  }

  /**
   * Migration files on `branch`, oldest first, with whether each has been
   * applied to the database `targetKey` names. With no target, nothing is
   * marked incoming.
   */
  async list(repoId: string, branch: string, target?: { key: string; dialect: string }): Promise<{ head: string | null; migrations: MigrationListing[] }> {
    const { head, paths } = await this.git.listMigrationFiles(repoId, branch);
    const applied = target ? await this.appliedTo(repoId, target.key) : new Map<string, AppliedRecord>();
    const migrations: MigrationListing[] = [];
    for (const path of paths.slice(-500)) {
      const fileName = path.split('/').pop()!;
      let header: MigrationFileHeader | null = null;
      let error: string | undefined;
      try {
        const content = (await this.git.readFile(repoId, head!, path)) ?? '';
        header = parseMigrationFile(content).header;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const done = applied.get(path) ?? null;
      migrations.push({
        path,
        fileName,
        header,
        ...(error ? { error } : {}),
        applied: done,
        incoming: !!target && !done && !!header && header.dialect.toLowerCase() === target.dialect.toLowerCase(),
      });
    }
    return { head, migrations };
  }

  private async appliedTo(repoId: string, targetKey: string): Promise<Map<string, AppliedRecord>> {
    const store = await getStore();
    const rows = await store.all<{ path: string; commit_oid: string; status: string; applied_at: string; applied_by: string | null }>(
      'SELECT path, commit_oid, status, applied_at, applied_by FROM git_applied WHERE repo_id = ? AND target_key = ? ORDER BY applied_at',
      [repoId, targetKey]
    );
    const out = new Map<string, AppliedRecord>();
    for (const r of rows) {
      if (!APPLIED.has(r.status)) continue;
      out.set(r.path, { path: r.path, commit: r.commit_oid, status: r.status, appliedAt: r.applied_at, appliedBy: r.applied_by });
    }
    return out;
  }

  /** Remember that a committed migration ran against a database. */
  async recordApplied(input: {
    repoId: string;
    path: string;
    commit: string;
    targetKey: string;
    status: string;
    runId: string | null;
    userId: string;
  }): Promise<void> {
    const store = await getStore();
    await store.run(
      `INSERT INTO git_applied (id, repo_id, path, commit_oid, target_key, status, run_id, applied_by, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), input.repoId, input.path, input.commit, input.targetKey, input.status, input.runId, input.userId, new Date().toISOString()]
    );
  }

  /** Whether some repository makes committing required before a migration runs. */
  async commitRequired(): Promise<boolean> {
    return (await this.repos.list()).some((r) => r.requireCommit);
  }
}

let shared: { repos: GitReposStore; git: GitRepoService; migrations: GitMigrationsService } | null = null;

/**
 * The one set of Git services the app uses. One instance matters: the
 * per-repository lock lives in the GitRepoService, so two instances would
 * be two locks, and concurrent commits could lose work again.
 */
export function gitServices() {
  if (!shared) {
    const repos = new GitReposStore();
    const git = new GitRepoService(repos);
    shared = { repos, git, migrations: new GitMigrationsService(repos, git) };
  }
  return shared;
}
