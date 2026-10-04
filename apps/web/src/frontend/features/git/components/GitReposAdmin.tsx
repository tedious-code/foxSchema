/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin → Access control → Git: the repositories migrations are committed
 * to. The access token is write-only — an empty token field on save keeps the
 * stored one — and never comes back from the server.
 */
import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { PasswordInput } from '@/shared/components/PasswordInput';
import type { AppRole } from '@foxschema/shared';
import { gitApi, type GitActivity, type GitRepo, type GitRepoInput } from '../api/gitApi';
import { useGitStore } from '../store/useGitStore';

const inputCls = 'w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus';
const labelCls = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400';
const FIELD_NAMES: Record<string, string> = {
  name: 'name',
  remoteUrl: 'URL',
  defaultBranch: 'default branch',
  folder: 'folder',
  authUsername: 'user name',
  requireCommit: 'Require a commit',
  roles: 'who can see it',
};

/** Roles a repository can be limited to; admins always see every repository. */
const LIMITABLE_ROLES: AppRole[] = ['viewer', 'editor', 'owner'];

/** One line of a repository's activity, in words. */
function describeActivity(a: GitActivity): string {
  const d = a.detail as Record<string, any>;
  switch (a.action) {
    case 'repo.added':
      return 'added the repository';
    case 'repo.removed':
      return 'removed the repository';
    case 'repo.edited': {
      const fields = Object.keys(d).filter((k) => k !== 'tokenReplaced').map((k) => FIELD_NAMES[k] ?? k);
      const parts = [...(fields.length ? [`changed ${fields.join(', ')}`] : []), ...(d.tokenReplaced ? ['replaced the token'] : [])];
      return parts.join(' and ') || 'saved the repository unchanged';
    }
    case 'branch.created':
      return `created branch ${d.branch}`;
    case 'committed':
      return `committed ${String(d.commit ?? '').slice(0, 7)} to ${d.branch}${d.pushed ? ' and pushed' : ''}`;
    case 'pushed':
      return `pushed ${d.branch}`;
    case 'pulled':
      return `pulled ${d.branch} (${d.result})`;
  }
}

const EMPTY: GitRepoInput = { name: '', remoteUrl: '', defaultBranch: 'main', folder: 'migrations', authUsername: '', token: '', requireCommit: false, roles: null };

export const GitReposAdmin: React.FC = () => {
  const { repos, load } = useGitStore();
  const [editing, setEditing] = useState<GitRepo | 'new' | null>(null);
  const [form, setForm] = useState<GitRepoInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<{ repoId: string; entries: GitActivity[] } | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (repo: GitRepo | 'new') => {
    setEditing(repo);
    setError(null);
    setForm(
      repo === 'new'
        ? EMPTY
        : { name: repo.name, remoteUrl: repo.remoteUrl, defaultBranch: repo.defaultBranch, folder: repo.folder, authUsername: repo.authUsername, token: '', requireCommit: repo.requireCommit, roles: repo.roles }
    );
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') await gitApi.createRepo(form);
      else if (editing) await gitApi.updateRepo(editing.id, form);
      await load();
      setNotice(editing === 'new' ? `Added ${form.name}.` : `Saved ${form.name}.`);
      setEditing(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (repo: GitRepo) => {
    if (!window.confirm(`Remove ${repo.name}? Fox forgets the repository and its local copy; the remote is not touched.`)) return;
    try {
      await gitApi.removeRepo(repo.id);
      await load();
      setNotice(`Removed ${repo.name}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove');
    }
  };

  const set = (k: keyof GitRepoInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <div data-testid="admin-git-repos" className="space-y-3">
      <p className="text-[11px] text-slate-400 leading-snug">
        Git repositories migrations are committed to. People choose one in Migrate, write a note, and commit before
        running; the Git view on Applies fetches, pulls and pushes. Use an HTTPS URL and an access token that can
        read and write the repository.
      </p>
      {notice && <div className="text-xs text-emerald-300">{notice}</div>}

      <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {repos.length === 0 && <li className="px-3 py-2 text-[11px] text-slate-500">No repositories yet.</li>}
        {repos.map((r) => (
          <li key={r.id} data-testid={`admin-git-repo-${r.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex-1 min-w-[12rem]">
              <div className="text-xs font-semibold text-slate-200">{r.name}</div>
              <div className="font-mono text-[11px] text-slate-500 break-all">
                {r.remoteUrl} · {r.defaultBranch} · /{r.folder}
              </div>
            </div>
            {r.roles && (
              <span data-testid={`admin-git-roles-${r.id}`} className="text-[10px] text-slate-400 border border-slate-700 rounded-full px-1.5 py-0.5">
                Only {r.roles.join(', ')}
              </span>
            )}
            {r.requireCommit && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300 border border-amber-500/30 rounded-full px-1.5 py-0.5">
                Commit required
              </span>
            )}
            {!r.hasToken && <span className="text-[10px] text-slate-500">no token</span>}
            <button
              type="button"
              data-testid={`admin-git-activity-${r.id}`}
              onClick={() => {
                if (activity?.repoId === r.id) {
                  setActivity(null);
                  return;
                }
                gitApi
                  .activity(r.id)
                  .then((entries) => setActivity({ repoId: r.id, entries }))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not read the activity'));
              }}
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:text-white"
            >
              Activity
            </button>
            <button type="button" onClick={() => open(r)} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:text-white">
              Edit
            </button>
            <button type="button" aria-label={`Remove ${r.name}`} onClick={() => void remove(r)} className="p-1 text-slate-500 hover:text-rose-300">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {activity?.repoId === r.id && (
              <ol data-testid="admin-git-activity" className="basis-full space-y-0.5 pt-1 text-[11px] text-slate-400">
                {activity.entries.length === 0 && <li>No activity recorded yet.</li>}
                {activity.entries.map((a) => (
                  <li key={a.id}>
                    <span className="text-slate-500">{new Date(a.at).toLocaleString()}</span> · {a.userEmail ?? 'someone since removed'}{' '}
                    {describeActivity(a)}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>

      {editing === null ? (
        <button type="button" data-testid="admin-git-add" onClick={() => open('new')} className="rounded-md accent-grad on-accent-fg px-3 py-1.5 text-xs font-bold">
          Add repository
        </button>
      ) : (
        <form onSubmit={save} data-testid="admin-git-form" className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-name" className={labelCls}>Name</label>
            <input id="git-repo-name" required value={form.name} onChange={set('name')} placeholder="DB migrations" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-url" className={labelCls}>HTTPS URL</label>
            <input id="git-repo-url" required value={form.remoteUrl} onChange={set('remoteUrl')} placeholder="https://github.com/acme/db-migrations.git" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-branch" className={labelCls}>Default branch</label>
            <input id="git-repo-branch" value={form.defaultBranch} onChange={set('defaultBranch')} className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-folder" className={labelCls}>Folder</label>
            <input id="git-repo-folder" value={form.folder} onChange={set('folder')} placeholder="migrations" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-user" className={labelCls}>Token user name (optional)</label>
            <input id="git-repo-user" value={form.authUsername} onChange={set('authUsername')} placeholder="x-access-token" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="git-repo-token" className={labelCls}>Access token</label>
            <PasswordInput
              id="git-repo-token"
              value={form.token}
              onChange={set('token')}
              autoComplete="off"
              placeholder={editing !== 'new' && editing.hasToken ? 'Stored — leave empty to keep' : 'Personal access token'}
              className={inputCls}
            />
          </div>
          <label className="sm:col-span-2 inline-flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={!!form.requireCommit} onChange={set('requireCommit')} className="mt-0.5" />
            <span>
              Require a commit: no migration runs on this install unless it was committed to Git first, and schema
              history revert and force-migrate are turned off. Statements run in the SQL editor or by workflows are not covered.
            </span>
          </label>
          <fieldset className="sm:col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300">
            <legend className={labelCls}>Who can see it</legend>
            {LIMITABLE_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5 capitalize">
                <input
                  type="checkbox"
                  data-testid={`admin-git-role-${role}`}
                  checked={!!form.roles?.includes(role)}
                  onChange={(e) =>
                    setForm((f) => {
                      const next = e.target.checked ? [...(f.roles ?? []), role] : (f.roles ?? []).filter((x) => x !== role);
                      return { ...f, roles: next.length ? next : null };
                    })
                  }
                />
                {role}
              </label>
            ))}
            <span className="text-slate-500">
              {form.roles ? 'Only these roles, and admins.' : 'None ticked: everyone with Git access.'}
            </span>
          </fieldset>
          {error && (
            <div role="alert" className="sm:col-span-2 text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <div className="sm:col-span-2 flex gap-2">
            <button type="submit" disabled={busy} className="rounded-md accent-grad on-accent-fg px-3 py-1.5 text-xs font-bold disabled:opacity-60">
              {editing === 'new' ? 'Add' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
