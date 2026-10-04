/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who may see a Git repository.
 *
 * `git.view` opens the Git screens; a repository can further be limited to
 * some app roles. Unlimited, everyone with `git.view` sees it, as before.
 * Whoever manages repositories (`git.manage`) sees all of them. Elsewhere a
 * repository a person may not see answers as if it did not exist.
 */
import { isAppRole, type AppRole } from '@foxschema/shared';

export interface RepoViewer {
  appRole?: AppRole;
  permissions?: ReadonlySet<string>;
}

export function canSeeRepo(repo: { roles: AppRole[] | null }, who: RepoViewer): boolean {
  if (!repo.roles || repo.roles.length === 0) return true;
  if (who.permissions?.has('git.manage')) return true;
  return !!who.appRole && repo.roles.includes(who.appRole);
}

/** The roles a repository is limited to, as given; null for everyone. Unknown names are refused. */
export function normalizeRepoRoles(raw: unknown): AppRole[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw new Error('Roles must be a list of app roles.');
  for (const r of raw) if (!isAppRole(r)) throw new Error(`Unknown role: ${String(r)}.`);
  const roles = [...new Set(raw as AppRole[])];
  return roles.length ? roles : null;
}
