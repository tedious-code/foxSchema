/**
 * Utilities → Query files: import CSV / JSON / fixed-width text into a
 * temporary SQLite workspace or bulk-load into a saved credential.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, Loader2, X } from 'lucide-react';
import {
  clearFileImports,
  importFileSmart,
  listFileImports,
  type FileImportListItem,
  type FileQueryFormat,
  type TextOffsetColumn,
} from '@/shared/api/fileQueryApi';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { scrubRemovedFileConnections } from '@/features/sql-editor/state';
import { toast } from '@/app/store/toastStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful import so the Files sidebar can refresh. */
  onImported?: () => void;
  /** Dock in the Utilities workspace (no overlay). */
  embedded?: boolean;
}

const EMPTY_OFFSETS: TextOffsetColumn[] = [
  { name: 'col1', start: 0, length: 10 },
  { name: 'col2', start: 10, length: 20 },
];

type DestMode = 'temp' | 'workspace' | 'credential';

function isFilesConnectionName(name: string | undefined): boolean {
  return !!name && /^Files:\s+/i.test(name.trim());
}

export const FileQueryModal: React.FC<Props> = ({
  open,
  onClose,
  onImported,
  embedded = false,
}) => {
  const loadConnections = useSyncStore((s) => s.loadConnections);
  const connections = useSyncStore((s) => s.connections);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const shareDestinations = useSqlEditorStore((s) => s.shareDestinations);

  const [format, setFormat] = useState<FileQueryFormat>('csv');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [tableName, setTableName] = useState('');
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [jsonMode, setJsonMode] = useState<'array' | 'ndjson'>('array');
  const [skipLines, setSkipLines] = useState(0);
  const [offsetsText, setOffsetsText] = useState(
    EMPTY_OFFSETS.map((c) => `${c.name},${c.start},${c.length}`).join('\n')
  );
  const [replacePrevious, setReplacePrevious] = useState(false);
  const [replaceTable, setReplaceTable] = useState(false);
  const [destMode, setDestMode] = useState<DestMode>('temp');
  const [workspaceId, setWorkspaceId] = useState('');
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [fileWorkspaces, setFileWorkspaces] = useState<FileImportListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credentialOptions = useMemo(
    () => connections.filter((c) => !isFilesConnectionName(c.name)),
    [connections]
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    void loadConnections();
    void listFileImports().then((res) => {
      if (res.ok) setFileWorkspaces(res.imports ?? []);
    });
  }, [open, loadConnections]);

  const onPickFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    if (!tableName) {
      setTableName(file.name.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_'));
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.json') || lower.endsWith('.ndjson')) setFormat('json');
    else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
      setFormat('csv');
      if (lower.endsWith('.tsv')) setDelimiter('\t');
    } else if (lower.endsWith('.txt') || lower.endsWith('.dat')) setFormat('text');
    setContent(await file.text());
  }, [tableName]);

  const parseOffsets = (): TextOffsetColumn[] => {
    const lines = offsetsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((line, i) => {
      const [name, startS, lenS] = line.split(/[,\t]/).map((s) => s.trim());
      const start = Number(startS);
      const length = Number(lenS);
      if (!name || !Number.isFinite(start) || !Number.isFinite(length)) {
        throw new Error(
          `Offset line ${i + 1} must be: name,start,length (e.g. id,0,5)`
        );
      }
      return { name, start, length };
    });
  };

  const selectDestination = (connectionId: string) => {
    const store = useSqlEditorStore.getState();
    if (shareDestinations) {
      useSqlEditorStore.setState({ sharedConnectionIds: [connectionId] });
    } else {
      store.ensureConnectionSelected(connectionId);
      const tab = store.tabs.find((t) => t.id === store.activeTabId);
      if (tab) {
        useSqlEditorStore.setState({
          tabs: store.tabs.map((t) =>
            t.id === tab.id ? { ...t, selectedConnectionIds: [connectionId] } : t
          ),
        });
      }
    }
    void store.ensureSchema(connectionId);
  };

  const onImport = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!content.trim()) throw new Error('Choose a file or paste content first');
      if (destMode === 'workspace' && !workspaceId) {
        throw new Error('Choose a Files workspace to add this table to');
      }
      if (destMode === 'credential' && !targetConnectionId) {
        throw new Error('Choose a credential to import into');
      }
      const ext = format === 'csv' ? 'csv' : format === 'json' ? 'json' : 'txt';
      const resolvedName =
        fileName.trim() ||
        `${(tableName || 'data').replace(/[^\w.-]+/g, '_')}.${ext}`;
      const body = {
        format,
        fileName: resolvedName,
        content,
        tableName: tableName || undefined,
        csv: format === 'csv' ? { delimiter, hasHeader } : undefined,
        json: format === 'json' ? { mode: jsonMode } : undefined,
        text:
          format === 'text'
            ? { skipLines, columns: parseOffsets() }
            : undefined,
        replacePrevious: destMode === 'temp' ? replacePrevious : false,
        replaceTable: destMode !== 'temp' ? replaceTable : false,
        workspaceConnectionId: destMode === 'workspace' ? workspaceId : undefined,
        targetConnectionId: destMode === 'credential' ? targetConnectionId : undefined,
        workspaceName:
          destMode === 'temp' && workspaceName.trim()
            ? workspaceName.trim()
            : undefined,
      };
      const res = await importFileSmart(body);
      const connectionId = res.connection?.id || res.connectionId;
      if (!res.ok || !connectionId) throw new Error(res.error || 'Import failed');

      scrubRemovedFileConnections(res.removedConnectionIds ?? []);
      await loadConnections();
      selectDestination(connectionId);
      if (res.sampleSql) setSql(res.sampleSql);

      const label =
        res.connection?.name ||
        connections.find((c) => c.id === connectionId)?.name ||
        connectionId;
      const chunkNote =
        res.chunks != null && res.chunks > 0 ? ` (${res.chunks} bulk chunk(s))` : '';
      const modeNote =
        res.mode === 'credential'
          ? ` Loaded into credential via bulk INSERT${chunkNote}.`
          : destMode === 'workspace'
            ? ' Added as a table in the Files workspace.'
            : '';
      toast({
        tone: 'success',
        title: `Loaded ${res.rowCount ?? 0} row(s)`,
        body: `"${label}" is checked — run the sample SELECT.${modeNote}`,
      });
      onImported?.();
      if (!embedded) onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const onClearImports = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await clearFileImports();
      if (!res.ok) throw new Error(res.error || 'Clear failed');
      scrubRemovedFileConnections(res.removedConnectionIds ?? []);
      await loadConnections();
      setFileWorkspaces([]);
      toast({
        tone: 'success',
        title: 'File imports cleared',
        body:
          (res.removedConnectionIds?.length ?? 0) === 0
            ? 'No previous Query-files credentials to remove.'
            : `Removed ${res.removedConnectionIds!.length} credential(s) and ${res.removedFiles ?? 0} temp DB file(s).`,
      });
      onImported?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const form = (
      <div
        className={
          embedded
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-900'
            : 'w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden'
        }
      >
        {!embedded && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-100 font-semibold">
            <FileSpreadsheet className="w-4 h-4 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
            Query files
          </div>
          <button data-testid="file-query-close"
            type="button"
            onClick={onClose}
            className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        )}

        <div
          className={`px-4 py-3 space-y-3 text-xs text-slate-300 overflow-y-auto ${
            embedded ? 'min-h-0 flex-1' : 'max-h-[70vh]'
          }`}
        >
          <p className="text-slate-400 leading-relaxed">
            Import CSV, JSON, or fixed-width text. Default lands in a temporary SQLite
            workspace (multiple files can share one DB). Or bulk-load into a saved
            credential. Large files upload in chunks.
          </p>

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              Destination
            </span>
            <select
              data-testid="file-query-dest-mode"
              value={destMode}
              onChange={(e) => setDestMode(e.target.value as DestMode)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
            >
              <option value="temp">New temp SQLite workspace</option>
              <option value="workspace" disabled={fileWorkspaces.length === 0}>
                Add table to existing Files workspace
              </option>
              <option value="credential">Import into saved credential…</option>
            </select>
          </label>

          {destMode === 'temp' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Workspace name (optional)
              </span>
              <input
                data-testid="file-query-workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Uses the file name when empty"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
          )}

          {destMode === 'workspace' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Files workspace
              </span>
              <select
                data-testid="file-query-workspace"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                <option value="">Select workspace…</option>
                {fileWorkspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.tables.length} table{w.tables.length === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
            </label>
          )}

          {destMode === 'credential' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Credential
              </span>
              <select
                data-testid="file-query-target-credential"
                value={targetConnectionId}
                onChange={(e) => setTargetConnectionId(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                <option value="">Select credential…</option>
                {credentialOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    [{c.dialect}] {c.name}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-slate-500 leading-snug">
                Uses chunked multi-row INSERT (dialect-aware). Requires create-table
                permission on the target.
              </span>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              File
            </span>
            <input
              type="file"
              data-testid="file-query-input"
              accept=".csv,.tsv,.json,.ndjson,.txt,.dat,text/csv,application/json,text/plain"
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
              className="block w-full text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-100 hover:file:bg-slate-700"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Format
              </span>
              <select
                data-testid="file-query-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as FileQueryFormat)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="text">Text (offsets)</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Table name
              </span>
              <input
                data-testid="file-query-table"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder="data"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 font-mono"
              />
            </label>
          </div>

          {format === 'csv' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Delimiter
                  </span>
                  <select
                    data-testid="file-query-delimiter"
                    value={
                      delimiter === ','
                        ? ','
                        : delimiter === '\t'
                          ? '\t'
                          : delimiter === ';'
                            ? ';'
                            : delimiter === '|'
                              ? '|'
                              : 'custom'
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'custom') {
                        setDelimiter(
                          delimiter.length === 1 && ![',', '\t', ';', '|'].includes(delimiter)
                            ? delimiter
                            : ':'
                        );
                      } else {
                        setDelimiter(v);
                      }
                    }}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100"
                  >
                    <option value=",">Comma (,)</option>
                    <option value={'\t'}>Tab (TSV)</option>
                    <option value=";">Semicolon (;)</option>
                    <option value="|">Pipe (|)</option>
                    <option value="custom">Custom…</option>
                  </select>
                </label>
                <label className="flex items-end gap-2 pb-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    data-testid="file-query-has-header"
                    checked={hasHeader}
                    onChange={(e) => setHasHeader(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span>First row is header</span>
                </label>
              </div>
              {![',', '\t', ';', '|'].includes(delimiter) && (
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Custom delimiter
                  </span>
                  <input
                    data-testid="file-query-delimiter-custom"
                    value={delimiter === '\t' ? '\\t' : delimiter}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDelimiter(v === '\\t' ? '\t' : v || ',');
                    }}
                    placeholder="e.g. || or :"
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono"
                  />
                </label>
              )}
            </div>
          )}

          {format === 'json' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                JSON shape
              </span>
              <select data-testid="file-query-json-shape"
                value={jsonMode}
                onChange={(e) => setJsonMode(e.target.value as 'array' | 'ndjson')}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
              >
                <option value="array">Array of objects</option>
                <option value="ndjson">NDJSON (one object per line)</option>
              </select>
            </label>
          )}

          {format === 'text' && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Skip lines
                </span>
                <input data-testid="file-query-skip-lines"
                  type="number"
                  min={0}
                  value={skipLines}
                  onChange={(e) => setSkipLines(Number(e.target.value) || 0)}
                  className="w-28 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Columns (name,start,length)
                </span>
                <textarea
                  data-testid="file-query-offsets"
                  value={offsetsText}
                  onChange={(e) => setOffsetsText(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px]"
                />
              </label>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              Preview / paste
            </span>
            <textarea
              data-testid="file-query-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Paste file contents here, or choose a file above…"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200"
            />
            {content.length > 600_000 && (
              <span className="text-[11px] text-amber-300/90">
                Large content — will upload in chunks ({(content.length / 1024).toFixed(0)} KB).
              </span>
            )}
          </label>

          {destMode === 'temp' && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="file-query-replace-previous"
                checked={replacePrevious}
                onChange={(e) => setReplacePrevious(e.target.checked)}
                className="accent-amber-500 mt-0.5"
              />
              <span className="text-slate-400 leading-snug">
                <span className="text-slate-200 font-semibold">Replace previous file imports</span>
                <span className="block">
                  Deletes earlier <span className="font-mono text-slate-300">Files:</span> credentials
                  and their temp SQLite tables when you import a new workspace.
                </span>
              </span>
            </label>
          )}

          {destMode !== 'temp' && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="file-query-replace-table"
                checked={replaceTable}
                onChange={(e) => setReplaceTable(e.target.checked)}
                className="accent-amber-500 mt-0.5"
              />
              <span className="text-slate-400 leading-snug">
                <span className="text-slate-200 font-semibold">Replace table if it exists</span>
                <span className="block">Drop and recreate the target table before loading.</span>
              </span>
            </label>
          )}

          {error && (
            <p className="text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-md px-2 py-1.5">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-between gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/40">
          <button
            type="button"
            data-testid="file-query-clear"
            disabled={busy}
            onClick={() => void onClearImports()}
            className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-500/40 hover:bg-rose-950/30 font-semibold disabled:opacity-50"
          >
            Clear file imports
          </button>
          <div className="flex gap-2">
            {!embedded && (
            <button data-testid="file-query-cancel"
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 font-semibold"
            >
              Cancel
            </button>
            )}
            <button
              type="button"
              data-testid="file-query-import"
              disabled={busy}
              onClick={() => void onImport()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-amber-600/50 bg-amber-900/50 text-amber-100 hover:bg-amber-800/60 font-semibold disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Import & open
            </button>
          </div>
        </div>
      </div>
  );

  if (embedded) {
    return (
      <div
        data-testid="file-query-modal"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {form}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[280] flex items-center justify-center bg-slate-950/70 backdrop-blur-[2px] p-4"
      data-testid="file-query-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {form}
    </div>,
    document.body
  );
};
