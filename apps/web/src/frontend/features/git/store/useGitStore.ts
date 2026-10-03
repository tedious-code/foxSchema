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
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Some repository makes committing required before a migration runs. */
  commitRequired: () => boolean;
}

export const useGitStore = create<GitState>((set, get) => ({
  repos: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      set({ repos: await gitApi.listRepos(), loaded: true, error: null });
    } catch (e: unknown) {
      set({ repos: [], loaded: true, error: e instanceof Error ? e.message : 'Could not load repositories' });
    }
  },
  commitRequired: () => get().repos.some((r) => r.requireCommit),
}));
