/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The configured Git repositories, loaded once and shared by the Migrate
 * panel, the commit dialog, the Git view and the admin tab.
 */
import { create } from 'zustand';
import { gitApi, type GitRepo } from '../api/gitApi';

interface GitState {
  repos: GitRepo[];
  /** The first load has finished (or failed); until then whether a commit is required is unknown. */
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export type CommitRequirement = 'required' | 'not required' | 'unknown';

/**
 * Whether a migration must be committed to Git before it runs: some
 * repository says so. Unknown until the repositories have loaded — never
 * read an empty list as "not required".
 */
export const commitRequirement = (s: Pick<GitState, 'repos' | 'loaded'>): CommitRequirement =>
  !s.loaded ? 'unknown' : s.repos.some((r) => r.requireCommit) ? 'required' : 'not required';

export const useGitStore = create<GitState>((set) => ({
  repos: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      set({ repos: await gitApi.listRepos(), loaded: true, error: null });
    } catch (e: unknown) {
      // Keep the repositories already known: an empty list would read as
      // "commit not required" and unblock Execute on an install that requires it.
      set({ loaded: true, error: e instanceof Error ? e.message : 'Could not load repositories' });
    }
  },
}));
