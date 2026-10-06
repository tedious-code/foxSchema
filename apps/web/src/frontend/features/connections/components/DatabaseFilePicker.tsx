/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pick a SQLite / DuckDB file from the machine running the backend.
 *
 * The browser's own file dialog cannot help here: it yields a `File` with a
 * name and no path, and the server needs a path it can open. So this browses
 * the server, listing directories and the files a database driver could open.
 *
 * A file that does not exist yet is a legitimate choice — SQLite creates it on
 * first connect — so the current directory plus a typed name is selectable
 * even when nothing matches it in the list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronUp, Database, Folder, Home, Loader2, RefreshCw, X } from 'lucide-react';
import { browseFiles, type FileBrowseEntry, type FileBrowseResult } from '@/shared/api/fileApi';
import { formatBytes } from '@foxschema/ui-shared';

export interface DatabaseFilePickerProps {
  /** Where to open. A file path opens its directory, with the name filled in. */
  initialPath?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

/** Join a directory and a file name without assuming the platform's separator. */
export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir;
  return `${trimmed}${sep}${name}`;
}

/** True for `/var/db` and `C:\\data`, i.e. something to use as typed. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** The file name in a path, for pre-filling the name box. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export const DatabaseFilePicker: React.FC<DatabaseFilePickerProps> = ({
  initialPath,
  onCancel,
  onSelect,
}) => {
  const [result, setResult] = useState<FileBrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() =>
    initialPath && !initialPath.endsWith('/') ? fileNameOf(initialPath) : ''
  );

  const load = useCallback((path?: string) => {
    setLoading(true);
    setError(null);
    browseFiles(path)
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to list directory'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(initialPath || undefined);
  }, [load, initialPath]);

  // Escape closes; the picker is a modal over a modal, so a click-out would be
  // ambiguous about which one it dismisses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const open = (entry: FileBrowseEntry) => {
    if (entry.kind === 'dir') {
      setFileName('');
      load(entry.path);
    } else {
      setFileName(entry.name);
    }
  };

  // People paste whole paths into a box labelled "File name". Honour it
  // rather than gluing it onto the current directory and producing
  // `/Users/me//var/db/app.db`.
  const typed = fileName.trim();
  const typedIsDir = isAbsolutePath(typed) && /[\\/]$/.test(typed);
  const chosen = !result || !typed ? '' : isAbsolutePath(typed) ? typed : joinPath(result.path, typed);

  return createPortal(
    <div className="modal-overlay" data-testid="file-picker">
      <div className="flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/40 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-100">Select database file</h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500" title={result?.path}>
              {result?.path ?? '…'}
            </p>
          </div>
          <button
            type="button"
            data-testid="file-picker-close"
            onClick={onCancel}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-800 px-3 py-2">
          <button
            type="button"
            data-testid="file-picker-up"
            disabled={!result?.parent || loading}
            onClick={() => result?.parent && load(result.parent)}
            title="Parent directory"
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:text-slate-100 disabled:opacity-40"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            Up
          </button>
          <button
            type="button"
            data-testid="file-picker-home"
            disabled={loading}
            onClick={() => result && load(result.home)}
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:text-slate-100 disabled:opacity-40"
          >
            <Home className="h-3.5 w-3.5" />
            Home
          </button>
          <button
            type="button"
            data-testid="file-picker-refresh"
            disabled={loading}
            onClick={() => result && load(result.path)}
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:text-slate-100 disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="min-h-[220px] flex-1 overflow-y-auto px-2 py-1">
          {loading && !result && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Listing…
            </div>
          )}
          {error && (
            <div
              data-testid="file-picker-error"
              className="m-2 flex items-start gap-2 rounded border border-rose-500/40 bg-rose-950/20 px-2 py-1.5 text-[11px] text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
          {result && result.entries.length === 0 && !error && (
            <p className="px-2 py-3 text-[11px] text-slate-500">
              No sub-folders and no database files here. Use Up, or type a name below to create one.
            </p>
          )}
          <ul>
            {result?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  data-testid={`file-picker-entry-${entry.name}`}
                  onDoubleClick={() => entry.kind === 'file' && onSelect(entry.path)}
                  onClick={() => open(entry)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-slate-800/70 ${
                    entry.kind === 'file' && entry.name === fileName.trim()
                      ? 'bg-slate-800 text-cyan-100'
                      : 'text-slate-300'
                  }`}
                >
                  {entry.kind === 'dir' ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                  ) : (
                    <Database className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.kind === 'file' && (
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {entry.size == null ? '' : formatBytes(entry.size)}
                      {entry.modifiedAt ? ` · ${entry.modifiedAt.slice(0, 10)}` : ''}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {result?.truncated && (
            <p className="px-2 py-2 text-[10px] text-amber-300/80">
              Too many entries to show — narrow down by opening a sub-folder.
            </p>
          )}
        </div>

        <div className="border-t border-slate-800 bg-slate-950/40 px-5 py-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            File name
          </label>
          <div className="mt-1 flex gap-2">
            <input
              data-testid="file-picker-name"
              value={fileName}
              placeholder="app.db — or paste a full path"
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // A pasted directory path navigates; anything else selects.
                if (typedIsDir) {
                  load(typed);
                  setFileName('');
                } else if (chosen) {
                  onSelect(chosen);
                }
              }}
              className="flex-1 rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none accent-focus"
            />
            <button
              type="button"
              data-testid="file-picker-cancel"
              onClick={onCancel}
              className="rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:text-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="file-picker-select"
              disabled={!chosen && !typedIsDir}
              onClick={() => {
                if (typedIsDir) {
                  load(typed);
                  setFileName('');
                } else if (chosen) {
                  onSelect(chosen);
                }
              }}
              className="rounded bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {typedIsDir ? 'Open' : 'Select'}
            </button>
          </div>
          {chosen && (
            <p className="mt-1 truncate font-mono text-[10px] text-slate-500" title={chosen}>
              {chosen}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
