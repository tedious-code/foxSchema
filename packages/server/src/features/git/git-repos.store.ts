/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Configured Git repositories (`git_repos`).
 *
 * The access token is encrypted with the install key on the way in and only
 * decrypted to hand to the remote; no summary ever carries it.
 */
import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { decryptSecret, encryptSecret } from '../../platform/crypto/crypto';
import { normalizeBranchName, normalizeFolder, normalizeRemoteUrl } from './git-url';
import { normalizeRepoRoles } from './git-access';
import type { AppRole } from '@foxschema/shared';

export interface GitRepoSummary {
  id: string;
  name: string;
  remoteUrl: string;
  defaultBranch: string;
  folder: string;
  authUsername: string;
  hasToken: boolean;
  requireCommit: boolean;
  /** The app roles that may see it; null for everyone with git.view. */
  roles: AppRole[] | null;
  createdAt: string;
  updatedAt: string;
}

/** What the Git service needs to talk to the remote. */
export interface GitRepoSecret extends GitRepoSummary {
  token: string;
}

export interface GitRepoInput {
  name?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  folder?: string;
  authUsername?: string;
  /** Empty or absent on update keeps the stored token, unless the remote moves to another server. */
  token?: string;
  requireCommit?: boolean;
  /** Limit it to these app roles; null or empty for everyone with git.view. Absent on update keeps it. */
  roles?: AppRole[] | null;
}

interface Row {
  id: string;
  name: string;
  remote_url: string;
  default_branch: string;
  folder: string;
  auth_username: string | null;
  encrypted_token: string | null;
  require_commit: number;
  roles: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, name, remote_url, default_branch, folder, auth_username, encrypted_token, require_commit, roles, created_at, updated_at';

/** Usernames hosts expect alongside a token; most accept anything. */
export const DEFAULT_AUTH_USERNAME = 'x-access-token';

function toSummary(r: Row): GitRepoSummary {
  return {
    id: r.id,
    name: r.name,
    remoteUrl: r.remote_url,
    defaultBranch: r.default_branch,
    folder: r.folder,
    authUsername: r.auth_username || DEFAULT_AUTH_USERNAME,
    hasToken: !!r.encrypted_token,
    requireCommit: Number(r.require_commit) === 1,
    roles: r.roles ? (JSON.parse(r.roles) as AppRole[]) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class GitReposStore {
  async list(): Promise<GitRepoSummary[]> {
    const store = await getStore();
    const rows = await store.all<Row>(`SELECT ${COLUMNS} FROM git_repos ORDER BY name`);
    return rows.map(toSummary);
  }

  async get(id: string): Promise<GitRepoSummary | null> {
    const store = await getStore();
    const row = await store.get<Row>(`SELECT ${COLUMNS} FROM git_repos WHERE id = ?`, [id]);
    return row ? toSummary(row) : null;
  }

  /** The repository with its token decrypted, for the Git service only. */
  async withSecret(id: string): Promise<GitRepoSecret | null> {
    const store = await getStore();
    const row = await store.get<Row>(`SELECT ${COLUMNS} FROM git_repos WHERE id = ?`, [id]);
    if (!row) return null;
    let token = '';
    if (row.encrypted_token) {
      try {
        token = decryptSecret(row.encrypted_token);
      } catch {
        throw new Error('The stored access token cannot be read with this install key. Enter it again.');
      }
    }
    return { ...toSummary(row), token };
  }

  async create(input: GitRepoInput, userId: string, allowInsecureHttp = false): Promise<GitRepoSummary> {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('Name is required.');
    const remoteUrl = normalizeRemoteUrl(input.remoteUrl ?? '', allowInsecureHttp);
    const defaultBranch = normalizeBranchName(input.defaultBranch || 'main');
    const folder = normalizeFolder(input.folder ?? 'migrations');
    const token = (input.token ?? '').trim();
    const roles = normalizeRepoRoles(input.roles);
    const now = new Date().toISOString();
    const id = randomUUID();
    const store = await getStore();
    await store.run(
      `INSERT INTO git_repos (id, name, remote_url, default_branch, folder, auth_username, encrypted_token, require_commit, roles, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        remoteUrl,
        defaultBranch,
        folder,
        (input.authUsername ?? '').trim() || null,
        token ? encryptSecret(token) : null,
        input.requireCommit ? 1 : 0,
        roles ? JSON.stringify(roles) : null,
        userId,
        now,
        now,
      ]
    );
    return (await this.get(id))!;
  }

  async update(id: string, input: GitRepoInput, allowInsecureHttp = false): Promise<GitRepoSummary | null> {
    const current = await this.get(id);
    if (!current) return null;
    const store = await getStore();
    const token = (input.token ?? '').trim();
    const remoteUrl = input.remoteUrl !== undefined ? normalizeRemoteUrl(input.remoteUrl, allowInsecureHttp) : current.remoteUrl;
    const roles = input.roles !== undefined ? normalizeRepoRoles(input.roles) : current.roles;
    // A stored token goes only to the server it was entered for. Moving the
    // remote to another server without entering it again would hand it to
    // whoever runs that server on the next fetch.
    if (!token && current.hasToken && new URL(remoteUrl).origin !== new URL(current.remoteUrl).origin) {
      throw new Error('Enter the access token again: a saved token is only sent to the server it was entered for.');
    }
    await store.run(
      `UPDATE git_repos SET name = ?, remote_url = ?, default_branch = ?, folder = ?, auth_username = ?,
         require_commit = ?, roles = ?, updated_at = ?${token ? ', encrypted_token = ?' : ''} WHERE id = ?`,
      [
        (input.name ?? current.name).trim() || current.name,
        remoteUrl,
        input.defaultBranch !== undefined ? normalizeBranchName(input.defaultBranch) : current.defaultBranch,
        input.folder !== undefined ? normalizeFolder(input.folder) : current.folder,
        input.authUsername !== undefined ? input.authUsername.trim() || null : current.authUsername === DEFAULT_AUTH_USERNAME ? null : current.authUsername,
        (input.requireCommit ?? current.requireCommit) ? 1 : 0,
        roles ? JSON.stringify(roles) : null,
        new Date().toISOString(),
        ...(token ? [encryptSecret(token)] : []),
        id,
      ]
    );
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const store = await getStore();
    const r = await store.run('DELETE FROM git_repos WHERE id = ?', [id]);
    return r.changes > 0;
  }
}
