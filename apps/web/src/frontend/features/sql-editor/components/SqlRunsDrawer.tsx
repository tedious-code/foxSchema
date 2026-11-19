/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Editor Runs drawer — recent queries without burying them in Bookmarks.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, History, Trash2, X } from 'lucide-react';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { formatRelativeDay } from '@/shared/lib/relativeTime';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { writeClipboard } from '@/shared/utils/clipboard';
import { toast } from '@/platform/toastStore';

function previewSql(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

export const SqlRunsDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const recentQueries = useSqlEditorStore((s) => s.recentQueries);
  const openRecentQuery = useSqlEditorStore((s) => s.openRecentQuery);
  const removeRecentQuery = useSqlEditorStore((s) => s.removeRecentQuery);
  const clearRecentQueries = useSqlEditorStore((s) => s.clearRecentQueries);
  const [search, setSearch] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) setConfirmClear(false);
  }, [open]);

  const filteredQueries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recentQueries;
    return recentQueries.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.sql.toLowerCase().includes(q) ||
        (r.errorSummary?.toLowerCase().includes(q) ?? false)
    );
  }, [recentQueries, search]);

  if (!open) return null;

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-slate-800 bg-slate-950"
      data-testid="sql-runs-drawer"
      aria-label="Recent runs"
    >
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">
          <History className="h-3.5 w-3.5 text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
          Runs
        </span>
        <button
          type="button"
          data-testid="sql-runs-close"
          aria-label="Close runs"
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {recentQueries.length > 0 && (
        <div className="space-y-1.5 border-b border-slate-800/70 px-3 py-2">
          <input
            type="text"
            data-testid="sql-runs-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search runs…"
            aria-label="Search recent runs"
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-500 outline-none accent-focus"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-slate-500">
              {filteredQueries.length} of {recentQueries.length}
            </span>
            {confirmClear ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="sql-runs-clear-confirm"
                  onClick={() => {
                    clearRecentQueries();
                    setConfirmClear(false);
                  }}
                  className="rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-slate-950 hover:bg-rose-400"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  data-testid="sql-runs-clear-cancel"
                  onClick={() => setConfirmClear(false)}
                  className="text-[10px] font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="sql-runs-clear"
                onClick={() => setConfirmClear(true)}
                className="text-[11px] font-bold text-slate-400 hover:text-rose-300"
              >
                Clear recent
              </button>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {recentQueries.length === 0 ? (
          <p className="px-1 text-[12px] text-slate-500" data-testid="sql-runs-empty">
            Run a query to see it here.
          </p>
        ) : filteredQueries.length === 0 ? (
          <p className="px-1 text-[12px] text-slate-500" data-testid="sql-runs-no-match">
            No matching runs.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="sql-runs-list">
            {filteredQueries.map((r) => (
              <li
                key={r.id}
                className="group flex items-start gap-1 rounded-md hover:bg-slate-800/70"
              >
                <button
                  type="button"
                  data-testid={`sql-runs-open-${r.id}`}
                  title={r.errorSummary ? `${r.errorSummary}\n\n${r.sql.slice(0, 350)}` : r.sql.slice(0, 400) || '(empty)'}
                  onClick={() => {
                    openRecentQuery(r.id);
                    onClose();
                  }}
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {typeof r.ok === 'boolean' && (
                      <span
                        className={`shrink-0 rounded px-1 py-0.2 text-[9px] font-bold uppercase ${
                          r.ok
                            ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-950/60 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {r.ok ? 'OK' : 'ERR'}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-[12px] font-semibold text-slate-200">
                      {r.title?.trim() || 'Query'}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[10px] text-slate-500">
                      {previewSql(r.sql)}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-600">
                      {r.durationMs != null ? `${r.durationMs}ms · ` : ''}
                      {r.ok && r.rowCount != null ? `${r.rowCount}r · ` : ''}
                      {formatRelativeDay(r.ranAt)}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-1.5">
                  <button
                    type="button"
                    data-testid={`sql-runs-copy-${r.id}`}
                    aria-label="Copy run SQL"
                    title="Copy SQL"
                    onClick={() => {
                      void writeClipboard(r.sql).then((ok) =>
                        toast({
                          tone: ok ? 'success' : 'warning',
                          title: ok ? 'SQL copied' : 'Copy failed',
                        })
                      );
                    }}
                    className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-cyan-300"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-testid={`sql-runs-delete-${r.id}`}
                    aria-label="Remove run from history"
                    title="Remove from history"
                    onClick={() => removeRecentQuery?.(r.id)}
                    className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
