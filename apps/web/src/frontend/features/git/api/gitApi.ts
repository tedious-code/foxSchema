/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * /api/git — repositories migrations are committed to.
 */
import { api } from '@/shared/api/client';
import type { ConnectionRef } from '@/shared/api/schemaApi';
import type { MigrationFileHeader, MigrationStep } from '@foxschema/sql';

export interface GitRepo {
  id: string;
  name: string;
  remoteUrl: string;
  defaultBranch: string;
  folder: string;
  authUsername: string;
  hasToken: boolean;
  requireCommit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GitRepoInput {
  name?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  folder?: string;
  authUsername?: string;
  /** Empty keeps the stored token. */
  token?: string;
  requireCommit?: boolean;
}

export interface BranchState {
  name: string;
  local: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
}

export interface MigrationListing {
  path: string;
  fileName: string;
  header: MigrationFileHeader | null;
  error?: string;
  applied: { path: string; commit: string; status: string; appliedAt: string; appliedBy: string | null } | null;
  incoming: boolean;
}

export interface PlanInput {
  steps: MigrationStep[];
  note: string;
  dialect: string;
  target?: string;
  source?: string;
}

/** Who changed a repository or moved its branches (admins only). */
export interface GitActivity {
  id: string;
  action: 'repo.added' | 'repo.edited' | 'repo.removed' | 'branch.created' | 'committed' | 'pushed' | 'pulled';
  detail: Record<string, unknown>;
  userEmail: string | null;
  at: string;
}

const base = (id: string) => `/git/repos/${encodeURIComponent(id)}`;

export const gitApi = {
  listRepos: async () => (await api.get<{ repos: GitRepo[] }>('/git/repos')).repos,
  createRepo: async (input: GitRepoInput) => (await api.post<{ repo: GitRepo }>('/git/repos', input)).repo,
  updateRepo: async (id: string, input: GitRepoInput) => (await api.put<{ repo: GitRepo }>(base(id), input)).repo,
  removeRepo: async (id: string) => {
    await api.delete(base(id));
  },

  branches: async (id: string) => (await api.get<{ branches: BranchState[] }>(`${base(id)}/branches`)).branches,
  fetch: async (id: string) => (await api.post<{ branches: BranchState[] }>(`${base(id)}/fetch`, {})).branches,
  createBranch: async (id: string, name: string, from?: string) =>
    (await api.post<{ branches: BranchState[] }>(`${base(id)}/branches`, { name, ...(from ? { from } : {}) })).branches,
  pull: (id: string, branch: string) =>
    api.post<{ result: 'up-to-date' | 'fast-forward' | 'merged' | 'created'; head: string | null }>(`${base(id)}/pull`, { branch }),
  push: (id: string, branch: string) => api.post<{ head: string }>(`${base(id)}/push`, { branch }),
  activity: async (id: string) => (await api.get<{ activity: GitActivity[] }>(`${base(id)}/activity`)).activity,
  log: async (id: string, branch: string, limit = 50) =>
    (await api.get<{ commits: CommitInfo[] }>(`${base(id)}/log`, { query: { branch, limit } })).commits,

  preview: (id: string, plan: PlanInput) =>
    api.post<{ fileName: string; path: string; content: string; scrubbed: number }>(`${base(id)}/preview`, plan),
  commit: (id: string, input: PlanInput & { branch: string; push?: boolean }) =>
    api.post<{ commit: string; path: string; fileName: string; scrubbed: number; pushed: boolean; pushError?: string }>(
      `${base(id)}/commit`,
      input
    ),
  migrations: (id: string, branch: string, target?: ConnectionRef) =>
    api.post<{ head: string | null; migrations: MigrationListing[] }>(`${base(id)}/migrations`, { branch, ...(target ?? {}) }),
  file: (id: string, ref: string, path: string) =>
    api.get<{ content: string; header: MigrationFileHeader; steps: MigrationStep[] }>(`${base(id)}/file`, { query: { ref, path } }),
};
