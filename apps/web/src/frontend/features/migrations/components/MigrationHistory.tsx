import React, { useEffect, useState, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { X, History, RefreshCw, Trash2, Download, Database, CheckSquare, Square, GitBranch } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { GitBranchView } from '@/features/git/components/GitBranchView';
import {
  apiListMigrations,
  apiGetMigration,
  apiDeleteMigration,
  apiDeleteMigrations,
  apiClearMigrations,
  type MigrationRunSummary,
  type MigrationRunDetail,
  type MigrationRunStatus,
} from '../api/migrationApi';

const SqlEditor = lazy(() =>
  import('@/features/sql-editor/components/SqlEditor').then((m) => ({ default: m.SqlEditor }))
);

interface Props {
  open: boolean;
  onClose: () => void;
}

const STATUS: Record<MigrationRunStatus, { label: string; cls: string }> = {
  SUCCESS: { label: 'Success', cls: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/25' },
  PARTIAL_SUCCESS: { label: 'Partial (skipped failures)', cls: 'text-amber-400 bg-amber-950/40 border-amber-500/25' },
  FAILED: { label: 'Failed', cls: 'text-rose-400 bg-rose-950/40 border-rose-500/25' },
  ROLLED_BACK: { label: 'Rolled back', cls: 'text-amber-400 bg-amber-950/40 border-amber-500/25' },
  RUNNING: { label: 'Running', cls: 'text-cyan-400 bg-cyan-950/40 border-cyan-500/25' },
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');
const safe = (s?: string) => (s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

const StatusBadge: React.FC<{ status: MigrationRunStatus }> = ({ status }) => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS[status].cls}`}>{STATUS[status].label}</span>
);

/** Per-user log of executed migrations, with the script, snapshot, and results. */
export const MigrationHistory: React.FC<Props> = ({ open, onClose }) => {
  const [runs, setRuns] = useState<MigrationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MigrationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Multi-select for bulk delete (keyed by run id).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const canViewGit = useAuthStore((s) => s.can('git.view'));
  const [showGit, setShowGit] = useState(false);

  const loadList = async () => {
    setLoading(true);
    try {
      const list = await apiListMigrations();
      setRuns(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      // Drop selections for runs that no longer exist.
      setChecked((prev) => new Set([...prev].filter((id) => list.some((r) => r.id === id))));
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadList();
    // loadList is stable (defined outside the effect); only re-run when open changes.
  }, [open]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiGetMigration(selectedId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  if (!open) return null;

  const remove = async (id: string) => {
    await apiDeleteMigration(id).catch(() => undefined);
    setRuns((rs) => rs.filter((r) => r.id !== id));
    setChecked((prev) => { const n = new Set(prev); n.delete(id); return n; });
    if (selectedId === id) setSelectedId(null);
  };

  const toggleCheck = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allChecked = runs.length > 0 && checked.size === runs.length;
  const toggleCheckAll = () =>
    setChecked(allChecked ? new Set() : new Set(runs.map((r) => r.id)));

  const deleteSelected = async () => {
    const ids = [...checked];
    if (!ids.length) return;
    await apiDeleteMigrations(ids).catch(() => undefined);
    setRuns((rs) => rs.filter((r) => !checked.has(r.id)));
    if (selectedId && checked.has(selectedId)) setSelectedId(null);
    setChecked(new Set());
  };

  const clearAll = async () => {
    await apiClearMigrations().catch(() => undefined);
    setRuns([]);
    setChecked(new Set());
    setSelectedId(null);
    setConfirmClear(false);
  };

  const downloadSnapshot = (d: MigrationRunDetail) => {
    if (!d.snapshotDdl) return;
    const url = URL.createObjectURL(new Blob([d.snapshotDdl], { type: 'text/sql' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `snapshot_${safe(d.host)}_${safe(d.database)}_${safe(d.schema)}_${d.startedAt.replace(/[:.]/g, '-')}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return createPortal(
    <div data-testid="history-dialog" className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-[1000px] h-[80vh] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40 shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="text-slate-100 font-bold text-base">Migration History</h2>
              <p className="text-xs text-slate-400 mt-0.5">Every executed sync, with its script, snapshot, and results</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {canViewGit && (
              <button
                type="button"
                data-testid="applies-git-btn"
                onClick={() => setShowGit(true)}
                title="Migrations in Git: fetch, pull, push, incoming"
                className="flex items-center gap-1 px-2 py-1 hover:bg-slate-800 rounded text-xs text-slate-300 hover:text-slate-100 transition"
              >
                <GitBranch className="w-4 h-4" /> Git
              </button>
            )}
            <button onClick={loadList} title="Refresh" className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button data-testid="history-dialog-close-btn" onClick={onClose} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Run list */}
          <div className="w-72 shrink-0 border-r border-slate-800 flex flex-col min-h-0">
            {runs.length > 0 && (
              <div className="shrink-0 border-b border-slate-800 bg-slate-950/40">
                {/* Select-all row */}
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    onClick={toggleCheckAll}
                    className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-100 transition"
                    title={allChecked ? 'Deselect all' : 'Select all'}
                  >
                    {allChecked ? <CheckSquare className="w-4 h-4 text-cyan-400" /> : <Square className="w-4 h-4 text-slate-500" />}
                    {checked.size > 0 ? `${checked.size} selected` : 'Select all'}
                  </button>
                  <div className="flex items-center gap-1">
                    {checked.size > 0 && (
                      <button
                        onClick={deleteSelected}
                        title="Delete selected records"
                        className="flex items-center gap-1 text-[11px] font-semibold text-rose-300 hover:text-rose-200 border border-rose-500/30 bg-rose-950/30 hover:bg-rose-950/50 rounded px-2 py-1 transition cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    )}
                    <button
                      onClick={() => setConfirmClear(true)}
                      title="Clear all records"
                      className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded px-2 py-1 transition cursor-pointer"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
                {/* Inline confirm for the destructive clear-all */}
                {confirmClear && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-rose-950/30 border-t border-rose-500/20">
                    <span className="text-[11px] text-rose-200">Delete all {runs.length} record{runs.length === 1 ? '' : 's'}?</span>
                    <div className="flex items-center gap-1">
                      <button onClick={clearAll} className="text-[11px] font-bold text-slate-950 bg-rose-400 hover:bg-rose-300 rounded px-2 py-1 transition on-accent-fg">Clear all</button>
                      <button onClick={() => setConfirmClear(false)} className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 transition">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
            {runs.length === 0 ? (
              <div className="text-center py-12 px-4 text-slate-500 text-sm">
                <Database className="w-8 h-8 mx-auto mb-2 text-slate-700" />
                {loading ? 'Loading…' : 'No migrations executed yet.'}
              </div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  data-testid="history-run-item"
                  data-run-id={r.id}
                  data-status={r.status}
                  onClick={() => setSelectedId(r.id)}
                  className={`flex items-start gap-2.5 px-3 py-3 border-b border-slate-850 transition cursor-pointer ${
                    selectedId === r.id ? 'bg-slate-800/70' : 'hover:bg-slate-900/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(r.id)}
                    onChange={() => toggleCheck(r.id)}
                    onClick={(e) => e.stopPropagation()}
                    title="Select this record"
                    className="w-4 h-4 mt-0.5 accent-cyan-500 cursor-pointer shrink-0"
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-[10px] text-slate-500 shrink-0">{r.objectCount} obj</span>
                    </div>
                    <p className="text-xs text-slate-300 font-mono truncate mt-1.5" title={`${r.host} / ${r.database} / ${r.schema}`}>
                      {r.database}{r.schema ? ` / ${r.schema}` : ''}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{fmt(r.startedAt)}</p>
                  </div>
                </div>
              ))
            )}
            </div>
          </div>

          {/* Detail */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {!detail ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                {detailLoading ? 'Loading…' : 'Select a migration to view details.'}
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={detail.status} />
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/50">
                        {detail.dialect.toUpperCase()}
                      </span>
                      <span className="text-xs text-slate-400">{detail.objectCount} object(s)</span>
                      {detail.git && (
                        <span
                          data-testid="applies-git-commit"
                          title={`${detail.git.path} on ${detail.git.branch ?? ''}`}
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-300 border border-slate-700 rounded px-1.5 py-0.5"
                        >
                          <GitBranch className="w-3 h-3" /> {detail.git.commit.slice(0, 7)}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-200 font-mono mt-2 break-all">
                      {detail.host} / {detail.database}{detail.schema ? ` / ${detail.schema}` : ''}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Started {fmt(detail.startedAt)} · Finished {fmt(detail.finishedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {detail.snapshotDdl && (
                      <button
                        onClick={() => downloadSnapshot(detail)}
                        title="Download pre-migration snapshot"
                        className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-slate-100 border border-slate-700 rounded px-2 py-1 hover:bg-slate-800 transition"
                      >
                        <Download className="w-3.5 h-3.5" /> Snapshot
                      </button>
                    )}
                    <button
                      onClick={() => remove(detail.id)}
                      title="Delete this record"
                      className="p-1.5 text-slate-500 hover:text-rose-300 hover:bg-rose-950/20 rounded transition cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {detail.error && (
                  <div className="text-xs text-rose-300 bg-rose-950/20 border border-rose-500/20 rounded-lg px-3 py-2 font-mono break-all">
                    {detail.error}
                  </div>
                )}

                {/* Per-object results */}
                {detail.results.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1.5">Objects</p>
                    <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="bg-slate-900 border-b border-slate-800 text-slate-400">
                            <th className="p-2.5 font-semibold">Object</th>
                            <th className="p-2.5 font-semibold">Action</th>
                            <th className="p-2.5 font-semibold text-right">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-850">
                          {detail.results.map((r, i) => (
                            <tr key={`${r.name}-${i}`}>
                              <td className="p-2.5 font-mono text-slate-200">{r.name} <span className="text-slate-600">{r.type}</span></td>
                              <td className="p-2.5 text-slate-400">{r.action}</td>
                              <td className={`p-2.5 text-right font-semibold ${r.status === 'FAILED' ? 'text-rose-400' : r.status === 'SUCCESS' ? 'text-emerald-400' : 'text-slate-400'}`}>
                                {r.status}{r.error ? ` · ${r.error}` : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Executed script */}
                {detail.script && (
                  <div>
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1.5">Executed Script</p>
                    <div className="bg-slate-950 border border-slate-850 rounded-lg overflow-hidden h-72">
                      <Suspense fallback={<div className="p-4 text-xs text-slate-500">Loading editor…</div>}>
                        <SqlEditor value={detail.script} dialect={detail.dialect} />
                      </Suspense>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <GitBranchView open={showGit} onClose={() => setShowGit(false)} />
    </div>,
    document.body
  );
};
