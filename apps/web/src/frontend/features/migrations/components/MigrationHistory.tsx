import React, { useEffect, useMemo, useState, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  History,
  RefreshCw,
  Trash2,
  Download,
  Database,
  CheckSquare,
  Square,
  GitBranch,
  Copy,
  FileCode2,
  Camera,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { useAuthStore } from '@/platform/authStore';
import { useUiStore } from '@/platform/uiStore';
import { toast } from '@/platform/toastStore';
import { writeClipboard } from '@/shared/utils/clipboard';
import { useEscapeKey } from '@/shared/lib/useEscapeKey';
import { GitBranchView } from '@/features/git';
import { loadSqlEditor, openSqlInEditor } from '@/features/sql-editor';
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

const SqlEditor = lazy(loadSqlEditor);

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

function formatRunDuration(startedAt?: string, finishedAt?: string): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

const StatusBadge: React.FC<{ status: MigrationRunStatus }> = ({ status }) => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS[status].cls}`}>{STATUS[status].label}</span>
);

/** Per-user log of executed migrations, with the script, snapshot, and results. */
export const MigrationHistory: React.FC<Props> = ({ open, onClose }) => {
  const [runs, setRuns] = useState<MigrationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MigrationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Multi-select for bulk delete (keyed by run id).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [confirmDeleteRecordId, setConfirmDeleteRecordId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | MigrationRunStatus>('ALL');
  const canViewGit = useAuthStore((s) => s.can('git.view'));
  const canMigrate = useAuthStore((s) => s.can('schema.migrate'));
  const canBrowse = useAuthStore((s) => s.can('schema.browse'));
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [showGit, setShowGit] = useState(false);

  useEscapeKey(onClose, open && !showGit);

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (r.database?.toLowerCase().includes(q) ?? false) ||
        (r.schema?.toLowerCase().includes(q) ?? false) ||
        (r.host?.toLowerCase().includes(q) ?? false) ||
        r.dialect.toLowerCase().includes(q) ||
        (r.author?.toLowerCase().includes(q) ?? false) ||
        (r.git?.commit.toLowerCase().includes(q) ?? false) ||
        (r.error?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [runs, search, statusFilter]);

  const loadList = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await apiListMigrations();
      setRuns(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      // Drop selections for runs that no longer exist.
      setChecked((prev) => new Set([...prev].filter((id) => list.some((r) => r.id === id))));
    } catch (err: unknown) {
      setRuns([]);
      setLoadError(err instanceof Error ? err.message : 'Could not load migration history.');
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

  const duration = detail ? formatRunDuration(detail.startedAt, detail.finishedAt) : null;
  const resultCounts = useMemo(() => {
    if (!detail?.results.length) return null;
    let passed = 0;
    let failed = 0;
    for (const r of detail.results) {
      if (r.status === 'FAILED') failed += 1;
      else if (r.status === 'SUCCESS') passed += 1;
    }
    return { passed, failed };
  }, [detail]);

  if (!open) return null;

  const remove = async (id: string) => {
    try {
      await apiDeleteMigration(id);
      setRuns((rs) => rs.filter((r) => r.id !== id));
      setChecked((prev) => { const n = new Set(prev); n.delete(id); return n; });
      if (selectedId === id) setSelectedId(null);
      setConfirmDeleteRecordId(null);
    } catch (err: unknown) {
      toast({
        tone: 'warning',
        title: 'Could not delete migration record',
        body: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const toggleCheck = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const visibleCheckedCount = filteredRuns.filter((r) => checked.has(r.id)).length;
  const allChecked = filteredRuns.length > 0 && visibleCheckedCount === filteredRuns.length;
  const toggleCheckAll = () =>
    setChecked(allChecked ? new Set() : new Set(filteredRuns.map((r) => r.id)));

  const deleteSelected = async () => {
    const ids = [...checked];
    if (!ids.length) return;
    try {
      await apiDeleteMigrations(ids);
      setRuns((rs) => rs.filter((r) => !checked.has(r.id)));
      if (selectedId && checked.has(selectedId)) setSelectedId(null);
      setChecked(new Set());
      setConfirmDeleteSelected(false);
    } catch (err: unknown) {
      toast({
        tone: 'warning',
        title: 'Could not delete selected records',
        body: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const clearAll = async () => {
    try {
      await apiClearMigrations();
      setRuns([]);
      setChecked(new Set());
      setSelectedId(null);
      setConfirmClear(false);
    } catch (err: unknown) {
      toast({
        tone: 'warning',
        title: 'Could not clear migration history',
        body: err instanceof Error ? err.message : undefined,
      });
    }
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

  const downloadScript = (d: MigrationRunDetail) => {
    if (!d.script) return;
    const url = URL.createObjectURL(new Blob([d.script], { type: 'text/sql;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration_${safe(d.database)}_${d.startedAt.slice(0, 10)}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openScriptInEditor = (d: MigrationRunDetail) => {
    if (!d.script) return;
    void openSqlInEditor(d.script);
    setActiveView('sqlEditor');
    onClose();
  };

  return createPortal(
    <div data-testid="history-dialog" className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="migration-history-title"
        className="w-full max-w-[1000px] h-[80vh] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40 shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 id="migration-history-title" className="text-slate-100 font-bold text-base">Migration History</h2>
              <p className="text-xs text-slate-400 mt-0.5">Audit log of executed sync runs, scripts, and pre-migration snapshots</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {canBrowse && (
              <button
                type="button"
                data-testid="history-open-snapshots"
                onClick={() => {
                  setActiveView('snapshots');
                  onClose();
                }}
                title="Open Schema Snapshots timeline and version diff"
                className="flex items-center gap-1 px-2.5 py-1 hover:bg-slate-800 rounded text-xs font-semibold text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 transition cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" /> Snapshots
              </button>
            )}
            {canViewGit && (
              <button
                type="button"
                data-testid="applies-git-btn"
                onClick={() => setShowGit(true)}
                title="Migrations in Git: fetch, pull, push, incoming"
                className="flex items-center gap-1 px-2 py-1 hover:bg-slate-800 rounded text-xs text-slate-300 hover:text-slate-100 transition cursor-pointer"
              >
                <GitBranch className="w-4 h-4" /> Git
              </button>
            )}
            <button data-testid="history-refresh" onClick={loadList} title="Refresh" className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition cursor-pointer">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button data-testid="history-dialog-close-btn" aria-label="Close migration history" onClick={onClose} className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Run list */}
          <div className="w-72 shrink-0 border-r border-slate-800 flex flex-col min-h-0">
            {runs.length > 0 && (
              <div className="shrink-0 border-b border-slate-800 bg-slate-950/40">
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5">
                  <input
                    type="text"
                    data-testid="migration-history-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search host, db, author…"
                    aria-label="Search migration history"
                    className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-500 outline-none accent-focus"
                  />
                  <select
                    data-testid="migration-history-filter-status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as 'ALL' | MigrationRunStatus)}
                    aria-label="Filter migrations by status"
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px] text-slate-200 outline-none accent-focus"
                  >
                    <option value="ALL">All</option>
                    <option value="SUCCESS">Success</option>
                    <option value="PARTIAL_SUCCESS">Partial</option>
                    <option value="FAILED">Failed</option>
                    <option value="ROLLED_BACK">Rolled back</option>
                    <option value="RUNNING">Running</option>
                  </select>
                </div>
                {canMigrate && (
                  <>
                    {/* Select-all row */}
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-800/60">
                      <button data-testid="history-select-all"
                        onClick={toggleCheckAll}
                        className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-100 transition"
                        title={allChecked ? 'Deselect all' : 'Select all'}
                      >
                        {allChecked ? <CheckSquare className="w-4 h-4 text-cyan-400" /> : <Square className="w-4 h-4 text-slate-500" />}
                        {checked.size > 0 ? `${checked.size} selected` : 'Select all'}
                      </button>
                      <div className="flex items-center gap-1">
                        {checked.size > 0 && (
                          <button data-testid="history-delete-selected"
                            onClick={() => {
                              setConfirmClear(false);
                              setConfirmDeleteSelected(true);
                            }}
                            title="Delete selected records"
                            className="flex items-center gap-1 text-[11px] font-semibold text-rose-300 hover:text-rose-200 border border-rose-500/30 bg-rose-950/30 hover:bg-rose-950/50 rounded px-2 py-1 transition cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </button>
                        )}
                        <button data-testid="history-clear-all"
                          onClick={() => {
                            setConfirmDeleteSelected(false);
                            setConfirmClear(true);
                          }}
                          title="Clear all records"
                          className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded px-2 py-1 transition cursor-pointer"
                        >
                          Clear all
                        </button>
                      </div>
                    </div>
                    {confirmDeleteSelected && checked.size > 0 && (
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-rose-950/30 border-t border-rose-500/20">
                        <span className="text-[11px] text-rose-200">Delete {checked.size} selected?</span>
                        <div className="flex items-center gap-1">
                          <button data-testid="history-delete-selected-confirm" onClick={deleteSelected} className="text-[11px] font-bold text-slate-950 bg-rose-400 hover:bg-rose-300 rounded px-2 py-1 transition on-accent-fg cursor-pointer">Delete</button>
                          <button data-testid="history-delete-selected-cancel" onClick={() => setConfirmDeleteSelected(false)} className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 transition cursor-pointer">Cancel</button>
                        </div>
                      </div>
                    )}
                    {/* Inline confirm for the destructive clear-all */}
                    {confirmClear && (
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-rose-950/30 border-t border-rose-500/20">
                        <span className="text-[11px] text-rose-200">Delete all {runs.length} record{runs.length === 1 ? '' : 's'}?</span>
                        <div className="flex items-center gap-1">
                          <button data-testid="history-clear-all-confirm" onClick={clearAll} className="text-[11px] font-bold text-slate-950 bg-rose-400 hover:bg-rose-300 rounded px-2 py-1 transition on-accent-fg cursor-pointer">Clear all</button>
                          <button data-testid="history-clear-all-cancel" onClick={() => setConfirmClear(false)} className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 transition cursor-pointer">Cancel</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
            {loadError ? (
              <div data-testid="history-load-error" className="text-center py-10 px-4 space-y-2.5 text-xs text-rose-300">
                <AlertTriangle className="w-7 h-7 mx-auto text-rose-400" />
                <p className="font-semibold">Could not load history</p>
                <p className="text-slate-400">{loadError}</p>
                <button
                  type="button"
                  data-testid="history-retry"
                  onClick={() => void loadList()}
                  className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:border-slate-500 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center py-12 px-4 text-slate-500 text-sm">
                <Database className="w-8 h-8 mx-auto mb-2 text-slate-700" />
                {loading ? 'Loading…' : 'No migrations executed yet.'}
              </div>
            ) : filteredRuns.length === 0 ? (
              <div className="text-center py-10 px-4 text-slate-500 text-xs" data-testid="migration-history-no-match">
                No matching migrations.
              </div>
            ) : (
              filteredRuns.map((r) => (
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
                  {canMigrate && (
                    <input data-testid={`history-select-${r.id}`}
                      type="checkbox"
                      checked={checked.has(r.id)}
                      onChange={() => toggleCheck(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      title="Select this record"
                      className="w-4 h-4 mt-0.5 accent-cyan-500 cursor-pointer shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-[10px] text-slate-500 shrink-0">{r.objectCount} obj</span>
                    </div>
                    <p className="text-xs text-slate-300 font-mono truncate mt-1.5" title={`${r.host} / ${r.database} / ${r.schema}`}>
                      {r.database}{r.schema ? ` / ${r.schema}` : ''}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5 truncate">
                      {fmt(r.startedAt)}{r.author ? ` · ${r.author}` : ''}
                    </p>
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
                    <p className="text-[11px] text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>Started {fmt(detail.startedAt)}</span>
                      <span>· Finished {fmt(detail.finishedAt)}</span>
                      {duration && (
                        <span data-testid="history-run-duration" className="inline-flex items-center gap-1 font-mono text-slate-300">
                          <Clock className="w-3 h-3 text-slate-400" /> {duration}
                        </span>
                      )}
                      {detail.author && <span>· by {detail.author}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {detail.snapshotDdl && (
                      <button data-testid="history-download-pre-migration"
                        onClick={() => downloadSnapshot(detail)}
                        title="Download pre-migration snapshot"
                        className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-slate-100 border border-slate-700 rounded px-2 py-1 hover:bg-slate-800 transition cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" /> Snapshot
                      </button>
                    )}
                    {canMigrate &&
                      (confirmDeleteRecordId === detail.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            data-testid="history-delete-record-confirm"
                            onClick={() => void remove(detail.id)}
                            className="rounded border border-rose-500/40 bg-rose-950/60 px-2 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-900/60 cursor-pointer transition"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            data-testid="history-delete-record-cancel"
                            onClick={() => setConfirmDeleteRecordId(null)}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200 cursor-pointer transition"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button data-testid="history-delete-record"
                          onClick={() => setConfirmDeleteRecordId(detail.id)}
                          title="Delete this record"
                          className="p-1.5 text-slate-500 hover:text-rose-300 hover:bg-rose-950/20 rounded transition cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      ))}
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
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Objects</p>
                      {resultCounts && (
                        <span className="text-[11px] font-semibold text-slate-400">
                          <span className="text-emerald-400">{resultCounts.passed} passed</span>
                          {resultCounts.failed > 0 && (
                            <span className="text-rose-400"> · {resultCounts.failed} failed</span>
                          )}
                        </span>
                      )}
                    </div>
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
                              <td className="p-2.5 font-mono text-slate-200">{r.name} <span className="text-slate-500">{r.type}</span></td>
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
                    <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Executed Script</p>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="migration-history-copy-sql"
                          onClick={() => {
                            if (!detail.script) return;
                            void writeClipboard(detail.script).then((ok) =>
                              toast({
                                tone: ok ? 'success' : 'warning',
                                title: ok ? 'Migration SQL copied' : 'Copy failed',
                              })
                            );
                          }}
                          className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-slate-100 border border-slate-700 rounded px-2 py-0.5 hover:bg-slate-800 transition cursor-pointer"
                        >
                          <Copy className="w-3 h-3" /> Copy SQL
                        </button>
                        <button
                          type="button"
                          data-testid="migration-history-download-sql"
                          onClick={() => downloadScript(detail)}
                          className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-slate-100 border border-slate-700 rounded px-2 py-0.5 hover:bg-slate-800 transition cursor-pointer"
                        >
                          <Download className="w-3 h-3" /> Download .sql
                        </button>
                        <button
                          type="button"
                          data-testid="migration-history-open-sql"
                          onClick={() => openScriptInEditor(detail)}
                          className="flex items-center gap-1 text-[11px] text-sky-200 hover:text-white border border-sky-500/40 bg-sky-950/40 rounded px-2 py-0.5 hover:bg-sky-900/50 transition cursor-pointer"
                        >
                          <FileCode2 className="w-3 h-3" /> Open in SQL Editor
                        </button>
                      </div>
                    </div>
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
