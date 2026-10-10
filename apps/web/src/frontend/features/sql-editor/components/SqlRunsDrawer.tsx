/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Editor Runs drawer — recent queries without burying them in Bookmarks.
 */
import React from 'react';
import { History, X } from 'lucide-react';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { formatRelativeDay } from '@/shared/lib/relativeTime';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

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
  const clearRecentQueries = useSqlEditorStore((s) => s.clearRecentQueries);

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
        <div className="flex justify-end px-3 pt-2">
          <button
            type="button"
            data-testid="sql-runs-clear"
            onClick={() => clearRecentQueries()}
            className="text-[11px] font-bold text-slate-400 hover:text-rose-300"
          >
            Clear recent
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {recentQueries.length === 0 ? (
          <p className="px-1 text-[12px] text-slate-500" data-testid="sql-runs-empty">
            Run a query to see it here.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="sql-runs-list">
            {recentQueries.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid={`sql-runs-open-${r.id}`}
                  title={r.sql.slice(0, 400) || '(empty)'}
                  onClick={() => {
                    openRecentQuery(r.id);
                    onClose();
                  }}
                  className="w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-800/70"
                >
                  <span className="block truncate text-[12px] font-semibold text-slate-200">
                    {r.title?.trim() || 'Query'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[10px] text-slate-500">
                      {previewSql(r.sql)}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-600">
                      {formatRelativeDay(r.ranAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
