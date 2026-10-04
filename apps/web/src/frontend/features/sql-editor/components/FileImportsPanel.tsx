import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import {
  clearFileImports,
  deleteFileImport,
  listFileImports,
  type FileImportListItem,
} from '@/shared/api/fileQueryApi';
import { useSyncStore } from '@/app/store/useSyncStore';
import { toast } from '@/app/store/toastStore';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { scrubRemovedFileConnections, selectFileImportInEditor } from '../lib/fileQueryEditorHelpers';
import { formatFileImportWhen, importCreatedAtMs } from '../lib/relativeTime';

type Props = {
  refreshKey?: number;
  onImportClick: () => void;
  /** After picking a table, jump to the SQL Editor (Utilities workspace). */
  onUseInEditor?: () => void;
};

/**
 * Sidebar manager for reusable Query-files imports (temp SQLite credentials).
 * Click a table to check that file DB and load a sample SELECT.
 */
export const FileImportsPanel: React.FC<Props> = ({
  refreshKey = 0,
  onImportClick,
  onUseInEditor,
}) => {
  const loadConnections = useSyncStore((s) => s.loadConnections);
  const [imports, setImports] = useState<FileImportListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFileImports();
      if (!res.ok) throw new Error(res.error || 'Failed to load file imports');
      setImports(res.imports ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load file imports');
      setImports([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const afterMutate = async (removedIds: string[]) => {
    scrubRemovedFileConnections(removedIds);
    await loadConnections();
    await load();
  };

  const handleDeleteOne = async (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from file imports?`)) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await deleteFileImport(id);
      if (!res.ok) throw new Error(res.error || 'Delete failed');
      await afterMutate(res.removedConnectionIds ?? [id]);
      toast({ tone: 'success', title: 'File import removed', body: name });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Clear all imported file databases?')) return;
    setBusyId('__all__');
    setError(null);
    try {
      const res = await clearFileImports();
      if (!res.ok) throw new Error(res.error || 'Clear failed');
      await afterMutate(res.removedConnectionIds ?? []);
      toast({
        tone: 'success',
        title: 'File imports cleared',
        body:
          (res.removedConnectionIds?.length ?? 0) === 0
            ? 'No previous Query-files credentials to remove.'
            : `Removed ${res.removedConnectionIds!.length} credential(s).`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 min-h-0 flex-1" data-testid="file-imports-panel">
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          data-testid="file-imports-refresh"
          title="Refresh"
          onClick={() => void load()}
          disabled={loading}
          className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            strokeWidth={SQL_ICON_STROKE}
          />
        </button>
        <button
          type="button"
          data-testid="file-imports-import"
          title="Import files"
          onClick={onImportClick}
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-semibold text-amber-200/90 hover:bg-amber-950/40 hover:text-amber-100"
        >
          <Upload className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          Import
        </button>
        {imports.length > 0 && (
          <button
            type="button"
            data-testid="file-imports-clear-all"
            title="Clear all file imports"
            onClick={() => void handleClearAll()}
            disabled={busyId !== null}
            className="ml-auto p-1 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-950/30 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-1.5 pr-0.5">
        {error && (
          <p className="text-[11px] text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded px-2 py-1">
            {error}
          </p>
        )}
        {loading && imports.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            Loading…
          </div>
        ) : imports.length === 0 ? (
          <div className="px-1 py-2 text-[11px] leading-relaxed text-slate-500">
            <p className="mb-1.5">No imported files yet.</p>
            <button data-testid="file-import-csv-json"
              type="button"
              className="text-amber-300/90 hover:text-amber-200 underline-offset-2 hover:underline"
              onClick={onImportClick}
            >
              Import CSV, JSON, or fixed-width text
            </button>
            <p className="mt-2 text-slate-600">
              Imports stay in Destinations until you clear them (temp DBs expire after ~24h).
            </p>
          </div>
        ) : (
          <>
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 px-1 pb-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600 shrink-0"
              data-testid="file-imports-table-head"
            >
              <span>Name</span>
              <span className="text-right">When</span>
              <span />
            </div>
            {imports.map((imp) => {
              const createdMs = importCreatedAtMs(imp.createdAt);
              const whenLabel = formatFileImportWhen(imp.createdAt);
              return (
                <div
                  key={imp.id}
                  className="rounded-md border border-slate-800 bg-slate-950/60 px-1.5 py-1.5"
                  data-testid={`file-import-${imp.id}`}
                >
                  <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-2">
                    <div className="min-w-0">
                      <p
                        className="truncate text-[11px] font-semibold text-slate-200"
                        title={imp.name}
                      >
                        {imp.name.replace(/^Files:\s*/i, '')}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {imp.tables.length} table{imp.tables.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className="text-[10px] font-medium text-slate-500 text-right tabular-nums shrink-0 pt-0.5"
                      data-testid={`file-import-when-${imp.id}`}
                      title={createdMs ? new Date(createdMs).toLocaleString() : undefined}
                    >
                      {whenLabel || '—'}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 p-1 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-950/30 disabled:opacity-40"
                      title="Remove this import"
                      data-testid={`file-import-delete-${imp.id}`}
                      onClick={() => void handleDeleteOne(imp.id, imp.name)}
                      disabled={busyId !== null}
                    >
                      {busyId === imp.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
                      ) : (
                        <Trash2 className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                      )}
                    </button>
                  </div>
                  <ul className="space-y-0.5">
                    {imp.tables.length === 0 ? (
                      <li className="px-1 text-[10px] text-slate-600">No tables</li>
                    ) : (
                      imp.tables.map((tableName) => (
                        <li key={tableName}>
                          <button
                            type="button"
                            className="w-full rounded px-1.5 py-1 text-left text-[11px] font-mono text-slate-300 hover:bg-slate-800 hover:text-slate-100 truncate"
                            title={`Query ${tableName} on this file database`}
                            data-testid={`file-import-use-${imp.id}-${tableName}`}
                            onClick={() => {
                              selectFileImportInEditor(imp.id, tableName);
                              toast({
                                tone: 'success',
                                title: 'Ready to query',
                                body: `"${imp.name}" checked — run the sample SELECT.`,
                              });
                              onUseInEditor?.();
                            }}
                          >
                            {tableName}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
