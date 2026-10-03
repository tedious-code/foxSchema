/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Commit the current migration plan to Git: choose the repository and a
 * branch (or a new one), write the note, review the exact file, commit —
 * and push, if you like. Execute then runs the plan from that commit.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitCommitHorizontal, Loader2, X } from 'lucide-react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { toast } from '@/app/store/toastStore';
import { gitApi, type BranchState } from '../api/gitApi';
import { useGitStore } from '../store/useGitStore';

const NEW_BRANCH = '__new__';
const inputCls = 'w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus';
const labelCls = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400';

/** `database.schema` (no host: it differs per environment). */
function targetName(cfg: { option: { database?: string }; schema: string }): string {
  return [cfg.option.database, cfg.schema].filter(Boolean).join('.');
}

export const CommitMigrationDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { repos, load } = useGitStore();
  const currentMigrationPlan = useSyncStore((s) => s.currentMigrationPlan);
  const targetConfig = useSyncStore((s) => s.targetConfig);
  const sourceConfig = useSyncStore((s) => s.sourceConfig);
  const setCommittedMigration = useSyncStore((s) => s.setCommittedMigration);

  const [repoId, setRepoId] = useState('');
  const [branches, setBranches] = useState<BranchState[]>([]);
  const [branch, setBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [note, setNote] = useState('');
  // The file and the repository and inputs it was built from: Commit sends
  // exactly what was reviewed, so it waits for the preview of what is on screen.
  const [preview, setPreview] = useState<{ path: string; content: string; scrubbed: number; repoId: string; input: object } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan as it was when the dialog opened: a fresh array every render
  // would re-trigger the preview forever.
  const [plan, setPlan] = useState<ReturnType<typeof currentMigrationPlan>>([]);
  useEffect(() => {
    if (open) setPlan(currentMigrationPlan());
  }, [open, currentMigrationPlan]);

  const repo = repos.find((r) => r.id === repoId);
  const planInput = useMemo(
    () => ({
      steps: plan,
      note,
      dialect: targetConfig.dialect,
      target: targetName(targetConfig),
      source: targetName(sourceConfig),
    }),
    [plan, note, targetConfig, sourceConfig]
  );

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (open && !repoId && repos[0]) setRepoId(repos[0].id);
  }, [open, repos, repoId]);

  // The branches as of the last fetch; fetch once when there are none yet.
  useEffect(() => {
    if (!open || !repoId) return;
    let alive = true;
    (async () => {
      try {
        let list = await gitApi.branches(repoId);
        if (list.length === 0) list = await gitApi.fetch(repoId);
        if (!alive) return;
        setBranches(list);
        const def = repos.find((r) => r.id === repoId)?.defaultBranch ?? 'main';
        setBranch((cur) => cur || (list.some((b) => b.name === def) || list.length === 0 ? def : list[0]!.name));
      } catch (e: unknown) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not read branches');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, repoId, repos]);

  // The exact file, rebuilt by the server as the note changes.
  useEffect(() => {
    if (!open || !repoId || !note.trim() || plan.length === 0) {
      setPreview(null);
      return;
    }
    let current = true; // false once a newer note or repository replaces this request
    const t = setTimeout(() => {
      gitApi
        .preview(repoId, planInput)
        .then((p) => {
          if (!current) return;
          setPreview({ ...p, repoId, input: planInput });
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (!current) return;
          setPreview(null);
          setPreviewError(e instanceof Error ? e.message : 'Could not build the file');
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [open, repoId, note, plan.length, planInput]);

  if (!open) return null;

  const targetBranch = branch === NEW_BRANCH ? newBranch.trim() : branch;
  const current = branches.find((b) => b.name === targetBranch);
  const previewIsCurrent = !!preview && preview.repoId === repoId && preview.input === planInput;
  const canCommit = !!repo && !!targetBranch && previewIsCurrent && !busy;

  // Another repository starts over on its default branch; the same one changes nothing.
  const chooseRepo = (id: string) => {
    if (id === repoId) return;
    setRepoId(id);
    setBranch('');
  };

  const commit = async (push: boolean) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const res = await gitApi.commit(repo.id, { ...planInput, branch: targetBranch, push });
      setCommittedMigration({ repoId: repo.id, branch: targetBranch, commit: res.commit, path: res.path });
      toast({
        tone: res.pushError ? 'warning' : 'success',
        title: `Committed ${res.commit.slice(0, 7)} to ${targetBranch}`,
        body: res.pushError
          ? `Not pushed: ${res.pushError}`
          : `${res.path}${res.pushed ? ' · pushed' : ''}${res.scrubbed ? ` · ${res.scrubbed} password(s) replaced with a placeholder` : ''}`,
      });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[330] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        data-testid="git-commit-dialog"
        className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <GitCommitHorizontal className="w-4 h-4 text-amber-300" />
          <h2 className="text-sm font-bold text-slate-100 flex-1">Commit migration to Git</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {repos.length === 0 ? (
            <p className="text-xs text-slate-400">No Git repository is set up yet. An admin can add one under Access control → Git.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor="git-commit-repo" className={labelCls}>Repository</label>
                  <select id="git-commit-repo" value={repoId} onChange={(e) => chooseRepo(e.target.value)} className={inputCls}>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="git-commit-branch" className={labelCls}>Branch</label>
                  <select id="git-commit-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={inputCls}>
                    {!branches.some((b) => b.name === repo?.defaultBranch) && repo && (
                      <option value={repo.defaultBranch}>{repo.defaultBranch} (first commit)</option>
                    )}
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.behind ? ` · ${b.behind} behind` : ''}
                        {b.ahead ? ` · ${b.ahead} to push` : ''}
                      </option>
                    ))}
                    <option value={NEW_BRANCH}>New branch…</option>
                  </select>
                </div>
              </div>

              {branch === NEW_BRANCH && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="git-commit-new-branch" className={labelCls}>New branch name</label>
                  <input
                    id="git-commit-new-branch"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="feature/orders-index"
                    className={inputCls}
                  />
                  <p className="text-[11px] text-slate-500">Starts from {repo?.defaultBranch ?? 'the default branch'}.</p>
                </div>
              )}

              {current && current.behind > 0 && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
                  <GitBranch className="w-3.5 h-3.5" /> {targetBranch} is {current.behind} commit(s) behind the remote. Pull it from the Git view before pushing.
                </p>
              )}

              <div className="flex flex-col gap-1">
                <label htmlFor="git-commit-note" className={labelCls}>Note (the commit message)</label>
                <textarea
                  id="git-commit-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="What this migration does and why"
                  className={`${inputCls} resize-y`}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className={labelCls}>
                  File to add{preview ? ` · ${preview.path}` : ''}
                  {preview && !previewIsCurrent && !previewError && ' · updating…'}
                </span>
                {previewError ? (
                  <p role="alert" className="text-xs text-rose-300">{previewError}</p>
                ) : preview ? (
                  <>
                    {preview.scrubbed > 0 && (
                      <p className="text-[11px] text-amber-300">
                        {preview.scrubbed} password(s) replaced with a placeholder — they are never committed.
                      </p>
                    )}
                    <pre data-testid="git-commit-preview" className="max-h-72 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-300">
                      {preview.content}
                    </pre>
                  </>
                ) : (
                  <p className="text-[11px] text-slate-500">Write a note to see the file.</p>
                )}
              </div>
            </>
          )}
          {error && (
            <div role="alert" className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {repos.length > 0 && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-800">
            <button type="button" onClick={onClose} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              data-testid="git-commit-only"
              disabled={!canCommit}
              onClick={() => void commit(false)}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-100 disabled:opacity-40"
            >
              Commit
            </button>
            <button
              type="button"
              data-testid="git-commit-push"
              disabled={!canCommit}
              onClick={() => void commit(true)}
              className="flex items-center gap-1.5 rounded-md accent-grad on-accent-fg px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Commit &amp; push
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
