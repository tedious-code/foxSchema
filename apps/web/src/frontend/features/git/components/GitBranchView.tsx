/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Git view (from Applies): a repository's branch — fetch, pull, push —
 * the migrations on it and whether each has been applied to the current
 * target database, and the incoming ones to review and run.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useAuthStore } from '@/app/store/authStore';
import { buildRef } from '@/app/store/sync-helpers';
import { toast } from '@/app/store/toastStore';
import { gitApi, type BranchState, type MigrationListing } from '../api/gitApi';
import { useGitStore } from '../store/useGitStore';

const btn = 'inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-40';

export const GitBranchView: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { repos, load } = useGitStore();
  const canMigrate = useAuthStore((s) => s.can('schema.migrate'));
  const targetConfig = useSyncStore((s) => s.targetConfig);
  const targetConnected = useSyncStore((s) => s.targetConnected);
  const runCommittedMigration = useSyncStore((s) => s.runCommittedMigration);
  const isMigrating = useSyncStore((s) => s.isMigrating);

  const [repoId, setRepoId] = useState('');
  const [branches, setBranches] = useState<BranchState[]>([]);
  const [branch, setBranch] = useState('');
  // The listing with the repository and branch it was read from: a run uses all
  // three together, so it can never pair a new branch with an old commit.
  const [listing, setListing] = useState<{ repoId: string; branch: string; head: string | null; migrations: MigrationListing[] } | null>(null);
  const latestRequest = useRef(0);
  const [review, setReview] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // From the Run click until the run ends, file fetch and confirm included:
  // isMigrating only starts once the run does, so a second Run could slip in.
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  const repo = repos.find((r) => r.id === repoId);
  const state = branches.find((b) => b.name === branch);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => {
    if (open && !repoId && repos[0]) setRepoId(repos[0].id);
  }, [open, repos, repoId]);

  const refresh = useCallback(async () => {
    if (!repoId) return;
    const request = ++latestRequest.current;
    const list = await gitApi.branches(repoId);
    if (request !== latestRequest.current) return; // a newer selection has replaced this one
    setBranches(list);
    const name = branch || repo?.defaultBranch || list[0]?.name || '';
    if (!branch) setBranch(name);
    if (!name) return;
    const res = await gitApi.migrations(repoId, name, targetConnected ? buildRef(targetConfig) : undefined);
    if (request !== latestRequest.current) return;
    setListing({ repoId, branch: name, head: res.head, migrations: res.migrations });
  }, [repoId, branch, repo, targetConfig, targetConnected]);

  useEffect(() => {
    if (open && repoId) refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not read the repository'));
  }, [open, repoId, branch, refresh]);
  // Work that finishes later (pull, push, a run) refreshes what is selected
  // THEN, not what was selected when it started.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  if (!open) return null;

  // Another repository starts over on its default branch; the same one changes nothing.
  const chooseRepo = (id: string) => {
    if (id === repoId) return;
    setRepoId(id);
    setBranch('');
    setBranches([]);
    setError(null);
  };

  const act = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refreshRef.current();
      if (done) toast({ tone: 'success', title: done });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  // Only the listing of what is selected now: never a previous repository's or branch's.
  const shown = listing && listing.repoId === repoId && listing.branch === branch ? listing : null;
  const head = shown?.head ?? null;
  const migrations = shown?.migrations ?? [];

  const run = async (m: MigrationListing) => {
    if (!shown?.head || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const ref = { repoId: shown.repoId, branch: shown.branch, commit: shown.head, path: m.path };
      const file = await gitApi.file(ref.repoId, ref.commit, ref.path);
      if (!window.confirm(`Run "${file.header.note.split('\n')[0]}" (${file.steps.length} step(s)) against ${targetConfig.option.database ?? ''}.${targetConfig.schema}?`)) return;
      const ok = await runCommittedMigration(ref, file.steps);
      toast({ tone: ok ? 'success' : 'warning', title: ok ? `Applied ${m.fileName}` : `${m.fileName} did not apply — see the migration progress` });
      await refreshRef.current();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Could not run ${m.fileName}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const incoming = migrations.filter((m) => m.incoming);

  return createPortal(
    <div className="fixed inset-0 z-[330] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        data-testid="git-branch-view"
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <GitBranch className="w-4 h-4 text-amber-300" />
          <h2 className="text-sm font-bold text-slate-100 flex-1">Migrations in Git</h2>
          <button data-testid="git-branch-view-close" type="button" aria-label="Close" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {repos.length === 0 ? (
          <p className="px-4 py-6 text-xs text-slate-400">No Git repository is set up yet. An admin can add one under Access control → Git.</p>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <select data-testid="git-branch-view-repo" aria-label="Repository" value={repoId} onChange={(e) => chooseRepo(e.target.value)} className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-xs">
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <select data-testid="git-branch-view-branch" aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-xs">
                {branches.length === 0 && <option value={branch}>{branch || '—'}</option>}
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
              {state && (
                <span data-testid="git-ahead-behind" className="text-[11px] text-slate-400">
                  {state.behind} behind · {state.ahead} ahead{!state.remote ? ' · not on the remote yet' : ''}
                </span>
              )}
              <div className="flex-1" />
              <button data-testid="git-branch-view-fetch" type="button" className={btn} disabled={!!busy} onClick={() => void act('Fetch', () => gitApi.fetch(repoId), 'Fetched')}>
                {busy === 'Fetch' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Fetch
              </button>
              {canMigrate && (
                <>
                  <button data-testid="git-branch-view-pull" type="button" className={btn} disabled={!!busy || !branch} onClick={() => void act('Pull', () => gitApi.pull(repoId, branch), `Pulled ${branch}`)}>
                    <ArrowDownToLine className="w-3.5 h-3.5" /> Pull
                  </button>
                  <button data-testid="git-branch-view-push"
                    type="button"
                    className={btn}
                    disabled={!!busy || !state?.local || (state.ahead === 0 && !!state.remote)}
                    onClick={() => void act('Push', () => gitApi.push(repoId, branch), `Pushed ${branch}`)}
                  >
                    <ArrowUpFromLine className="w-3.5 h-3.5" /> Push
                  </button>
                </>
              )}
            </div>

            {error && (
              <div role="alert" className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">{error}</div>
            )}

            <p className="text-[11px] text-slate-500">
              {targetConnected
                ? `Applied / incoming for ${targetConfig.option.database ?? ''}.${targetConfig.schema} (${targetConfig.dialect}).`
                : 'Connect a target in Sync to see which migrations it has had.'}
              {incoming.length > 0 && ` ${incoming.length} incoming.`}
            </p>

            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {migrations.length === 0 && <li className="px-3 py-2 text-[11px] text-slate-500">No migrations on this branch yet.</li>}
              {[...migrations].reverse().map((m) => (
                <li key={m.path} data-testid={`git-migration-${m.fileName}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-[14rem]">
                    <div className="text-xs text-slate-200">{m.header?.note.split('\n')[0] ?? m.fileName}</div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {m.fileName}
                      {m.header?.author ? ` · ${m.header.author}` : ''}
                      {m.error ? ` · ${m.error}` : ''}
                    </div>
                  </div>
                  {m.applied ? (
                    <span className="text-[10px] font-semibold text-emerald-300">Applied {new Date(m.applied.appliedAt).toLocaleDateString()}</span>
                  ) : m.incoming ? (
                    <span className="text-[10px] font-semibold text-amber-300">Incoming</span>
                  ) : null}
                  <button data-testid={`git-review-${m.fileName}`}
                    type="button"
                    className={btn}
                    onClick={() => void gitApi.file(repoId, head ?? branch, m.path).then((f) => setReview({ path: m.path, content: f.content })).catch((e) => setError(e.message))}
                  >
                    Review
                  </button>
                  {m.incoming && canMigrate && (
                    <button
                      type="button"
                      data-testid={`git-run-${m.fileName}`}
                      className={btn}
                      disabled={isMigrating || running || !targetConnected}
                      onClick={() => void run(m).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Run failed'))}
                    >
                      <Play className="w-3.5 h-3.5" /> Run
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {review && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-400 flex-1">{review.path}</span>
                  <button data-testid="git-review-close" type="button" aria-label="Close review" onClick={() => setReview(null)} className="text-slate-500 hover:text-slate-200">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <pre data-testid="git-review" className="max-h-72 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-300">
                  {review.content}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
