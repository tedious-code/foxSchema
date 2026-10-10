/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Clone Table: archive a huge table as name_N, recreate an empty
 * table with the original name/schema so apps keep working. Settings for
 * suffix number, keep indexes, and recreate outbound foreign keys.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Loader2, Play, X } from 'lucide-react';
import { executeSql } from '@/shared/api/sqlApi';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/app/store/uiStore';
import type { TableSchema } from '@/shared/lib/types';
import { PROVIDER_SETTINGS, connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { insertAtCursor } from '@/features/sql-editor';
import { WriteConfirmDialog } from '@/features/sql-editor/ui';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { Autocomplete, type AutocompleteOption } from '@/shared/components/Autocomplete';
import {
  dialectFkConstraintSupport,
  dialectIndexSupport,
  executableSqlStatements,
  findInboundForeignKeyTables,
  generateCloneTableSql,
} from '@/features/sql-editor/ui';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-select this table when opened from Schema explorer. */
  initialTableName?: string | null;
  /** Dock in the Utilities workspace (no overlay). */
  embedded?: boolean;
  /** Workspace credential — hides this form's picker. */
  lockedConnectionId?: string;
}

const LS_CONN = 'foxschema-utilities-clone-table-connection';
/** Matches backend `MAX_STATEMENTS` in sql-execute.ts — Apply chunks at this size. */
const EXECUTE_BATCH_SIZE = 25;

export const CloneTableModal: React.FC<Props> = ({
  open,
  onClose,
  initialTableName = null,
  embedded = false,
  lockedConnectionId,
}) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [connectionId, setConnectionId] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [tableName, setTableName] = useState('');
  const [suffixMode, setSuffixMode] = useState<'auto' | 'fixed'>('auto');
  const [startNumber, setStartNumber] = useState(1);
  const [keepIndexes, setKeepIndexes] = useState(true);
  const [keepForeignKeys, setKeepForeignKeys] = useState(true);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const wasOpen = React.useRef(false);

  // Initialize only when the modal opens — do not reset when `connections`
  // re-emits after schema load (that cleared the table picker mid-flight).
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const saved = localStorage.getItem(LS_CONN) || '';
    const fallback = connections[0]?.id || '';
    const next = lockedConnectionId
      ? lockedConnectionId
      : connections.some((c) => c.id === saved)
        ? saved
        : fallback;
    setConnectionId(next);
    setTableName(initialTableName?.trim() || '');
    setError(null);
    setStatus(null);
    setConfirmApply(false);
    setPasswordDraft('');
  }, [open, connections, initialTableName, lockedConnectionId]);

  useEffect(() => {
    if (!open || !lockedConnectionId) return;
    setConnectionId((cur) => (cur === lockedConnectionId ? cur : lockedConnectionId));
  }, [open, lockedConnectionId]);

  // If opened from Schema with a table name after mount, honor it once.
  useEffect(() => {
    if (!open || !initialTableName?.trim()) return;
    setTableName(initialTableName.trim());
  }, [open, initialTableName]);

  const conn = connections.find((c) => c.id === connectionId) || null;
  // File dialects carry no password; asking for one blocked the utility outright.
  const needsPassword = Boolean(
    conn && !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod) && !sessionPasswords[connectionId]
  );
  const cache = connectionId ? schemaCache[connectionId] : undefined;

  const tables: TableSchema[] = useMemo(() => {
    return (cache?.tables ?? [])
      .filter((t) => t.objectType === 'TABLE' || t.objectType === 'MQT')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cache?.tables]);

  const selected = tables.find((t) => t.name === tableName) || null;
  const existingNames = useMemo(() => tables.map((t) => t.name), [tables]);
  const tableOptions = useMemo(
    (): AutocompleteOption[] =>
      tables.map((t) => {
        const parts = [
          t.indices?.length ? `${t.indices.length} idx` : '',
          t.foreignKeys?.length ? `${t.foreignKeys.length} fk` : '',
        ].filter(Boolean);
        return { value: t.name, hint: parts.join(' · ') || undefined };
      }),
    [tables]
  );
  const dialect = conn?.dialect || '';
  const indexSupport = dialectIndexSupport(dialect);
  const fkSupport = dialectFkConstraintSupport(dialect);

  const plan = useMemo(() => {
    if (!selected || !conn) return null;
    return generateCloneTableSql({
      table: selected,
      dialect: conn.dialect,
      schema: conn.schema?.trim() || undefined,
      existingTableNames: existingNames,
      suffixMode,
      startNumber,
      keepIndexes: keepIndexes && indexSupport.create,
      keepForeignKeys:
        keepForeignKeys && (fkSupport.alterAdd || fkSupport.createInline),
    });
  }, [
    selected,
    conn,
    existingNames,
    suffixMode,
    startNumber,
    keepIndexes,
    keepForeignKeys,
    indexSupport.create,
    fkSupport.alterAdd,
    fkSupport.createInline,
  ]);

  const inbound = useMemo(
    () => (selected ? findInboundForeignKeyTables(tables, selected.name) : []),
    [selected, tables]
  );

  const executable = useMemo(
    () => (plan ? executableSqlStatements(plan.statements) : []),
    [plan]
  );

  const loadSchema = useCallback(async () => {
    if (!connectionId) return;
    setLoadingSchema(true);
    setError(null);
    setStatus(null);
    try {
      ensureConnectionSelected(connectionId);
      await ensureSchema(connectionId, { force: true });
      const entry = useSqlEditorStore.getState().schemaCache[connectionId];
      if (entry?.status === 'error') {
        setError(entry.error || 'Failed to load schema');
        return;
      }
      const list = (entry?.tables ?? []).filter(
        (t) => t.objectType === 'TABLE' || t.objectType === 'MQT'
      );
      setStatus(`Loaded ${list.length} table(s) from schema catalog.`);
      setTableName((prev) => {
        if (initialTableName?.trim()) return initialTableName.trim();
        if (prev && list.some((t) => t.name === prev)) return prev;
        return list[0]?.name ?? '';
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSchema(false);
    }
  }, [connectionId, ensureConnectionSelected, ensureSchema, initialTableName]);

  useEffect(() => {
    if (!open || !connectionId) return;
    if (cache?.status === 'ready' && (cache.tables?.length ?? 0) > 0) {
      setTableName((prev) => {
        if (initialTableName?.trim()) return initialTableName.trim();
        if (prev) return prev;
        const first = (cache.tables ?? []).find(
          (t) => t.objectType === 'TABLE' || t.objectType === 'MQT'
        );
        return first?.name ?? '';
      });
      return;
    }
    void loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to connection/open only; `cache.tables` changes identity constantly and would re-run this on every schema poll
  }, [open, connectionId, loadSchema, initialTableName]);

  const runClone = useCallback(async () => {
    if (!connectionId || !conn || !plan || plan.error || executable.length === 0) return;
    if (needsPassword) {
      setError('Enter the session password for this credential first.');
      return;
    }
    setRunning(true);
    setError(null);
    setStatus(null);
    const live = bareLabel(selected?.name || '');
    const archive = plan.archiveName;
    const ref = {
      connectionId,
      password: sessionPasswords[connectionId] || undefined,
      schema: conn.schema?.trim() || undefined,
    };
    try {
      // Stop on first failure; chunk to backend MAX_STATEMENTS.
      let ran = 0;
      for (let i = 0; i < executable.length; i += EXECUTE_BATCH_SIZE) {
        const batch = executable.slice(i, i + EXECUTE_BATCH_SIZE);
        const result = await executeSql(ref, batch);
        for (let j = 0; j < result.results.length; j++) {
          const r = result.results[j]!;
          if (r.ok) {
            ran += 1;
            continue;
          }
          setError(
            `${r.error || 'Clone failed'} — stopped after ${ran}/${executable.length} statements. ` +
              `If rename already ran, ${live} may only exist as ${archive}. ` +
              `Recover: rename ${archive} back to ${live}, or Insert SQL and finish manually.`
          );
          return;
        }
      }
      await ensureSchema(connectionId, { force: true });
      setStatus(
        `Cloned: ${live} data kept as ${archive}; empty ${live} recreated.`
      );
      setConfirmApply(false);
    } catch (err: unknown) {
      setError(
        `${err instanceof Error ? err.message : String(err)} — ` +
          `if rename already ran, recover by renaming ${archive} → ${live} or Insert SQL.`
      );
    } finally {
      setRunning(false);
    }
  }, [
    connectionId,
    conn,
    plan,
    executable,
    needsPassword,
    sessionPasswords,
    ensureSchema,
    selected?.name,
  ]);

  const onApplyClick = () => {
    if (!plan || plan.error || executable.length === 0) return;
    if (safeMode) {
      setConfirmApply(true);
      return;
    }
    void runClone();
  };

  if (!open) return null;

  const sheet = (
        <div
          className={
            embedded
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-900'
              : 'w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden border border-amber-400/30 shadow-2xl bg-gradient-to-b from-slate-800 via-slate-800/95 to-slate-900'
          }
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-3.5 border-b border-amber-400/20 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-slate-800/20 flex items-center gap-2.5 shrink-0">
            <span className="shrink-0 p-1.5 rounded-lg bg-amber-400/15 ring-1 ring-amber-400/30">
              <Copy className="w-4 h-4 text-amber-200" strokeWidth={SQL_ICON_STROKE} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-slate-50 font-bold text-base">Clone Table</h2>
              <p className="text-[11px] text-amber-100/70 font-semibold">
                Archive huge table as name_N · recreate empty live table · keep apps working
              </p>
            </div>
            {!embedded && (
            <button data-testid="clone-close"
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/80"
              aria-label="Close"
            >
              <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
            </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
              {!lockedConnectionId && (
              <label className="block min-w-0">
                <span className="text-[10px] font-bold uppercase text-slate-500">
                  Credential
                </span>
                <select
                  data-testid="clone-table-connection"
                  value={connectionId}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    localStorage.setItem(LS_CONN, e.target.value);
                    setTableName('');
                  }}
                  className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100"
                >
                  {connections.length === 0 ? (
                    <option value="">No credentials</option>
                  ) : (
                    connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.id}
                        {c.dialect ? ` (${PROVIDER_SETTINGS[c.dialect]?.label || c.dialect})` : ''}
                      </option>
                    ))
                  )}
                </select>
              </label>
              )}
              <button
                type="button"
                data-testid="clone-table-load"
                onClick={() => void loadSchema()}
                disabled={!connectionId || loadingSchema}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-[12px] font-bold text-amber-100 disabled:opacity-50"
              >
                {loadingSchema ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
                ) : null}
                Load tables
              </button>
            </div>

            {needsPassword && (
              <div className="flex gap-2 items-end">
                <label className="block flex-1">
                  <span className="text-[10px] font-bold uppercase text-slate-500">
                    Session password
                  </span>
                  <input data-testid="clone-password-draft"
                    type="password"
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100"
                  />
                </label>
                <button data-testid="clone-unlock"
                  type="button"
                  onClick={() => {
                    if (!connectionId || !passwordDraft.trim()) return;
                    // ensureConnectionSelected sets pendingPassword; submit stores it.
                    ensureConnectionSelected(connectionId);
                    submitSessionPassword(passwordDraft);
                    setPasswordDraft('');
                  }}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 text-[12px] font-bold text-slate-200"
                >
                  Unlock
                </button>
              </div>
            )}

            <label className="block">
              <span className="text-[10px] font-bold uppercase text-slate-500">Table</span>
              <div className="mt-0.5">
                <Autocomplete
                  data-testid="clone-table-name"
                  value={tableName}
                  onChange={setTableName}
                  options={tableOptions}
                  placeholder={tables.length ? 'Select or type a table…' : 'Load tables first'}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] font-mono text-slate-100 outline-none accent-focus placeholder:text-slate-500"
                />
              </div>
            </label>

            <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Archive name number
              </p>
              <div className="flex flex-wrap gap-3 items-center">
                <label className="inline-flex items-center gap-2 text-[13px] text-slate-200 cursor-pointer">
                  <input
                    type="radio"
                    name="clone-suffix-mode"
                    checked={suffixMode === 'auto'}
                    onChange={() => setSuffixMode('auto')}
                    data-testid="clone-suffix-auto"
                  />
                  Auto (continue next free)
                </label>
                <label className="inline-flex items-center gap-2 text-[13px] text-slate-200 cursor-pointer">
                  <input
                    type="radio"
                    name="clone-suffix-mode"
                    checked={suffixMode === 'fixed'}
                    onChange={() => setSuffixMode('fixed')}
                    data-testid="clone-suffix-fixed"
                  />
                  Start at
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={startNumber}
                  disabled={suffixMode !== 'fixed'}
                  onChange={(e) =>
                    setStartNumber(Math.max(1, Math.floor(Number(e.target.value) || 1)))
                  }
                  data-testid="clone-suffix-number"
                  className="w-20 rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-[13px] font-mono text-slate-100 disabled:opacity-40"
                />
              </div>
              {plan?.archiveName && !plan.error ? (
                <p className="text-[12px] text-amber-100/90 font-mono" data-testid="clone-archive-preview">
                  {bareLabel(tableName)} →{' '}
                  <span className="text-amber-200 font-bold">{plan.archiveName}</span>
                  {' · '}
                  new empty <span className="text-emerald-300 font-bold">{bareLabel(tableName)}</span>
                </p>
              ) : null}
              <p className="text-[11px] text-slate-500">
                Apply is not transactional: if it stops mid-way after rename, recover by renaming
                the archive back or finishing via Insert SQL.
              </p>
            </div>

            <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3 space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Recreate on new table
              </p>
              <label
                className={`flex items-start gap-2 text-[13px] cursor-pointer ${
                  indexSupport.create ? 'text-slate-200' : 'text-slate-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={keepIndexes && indexSupport.create}
                  disabled={!indexSupport.create}
                  onChange={(e) => setKeepIndexes(e.target.checked)}
                  data-testid="clone-keep-indexes"
                  className="mt-0.5"
                />
                <span>
                  Keep indexes
                  <span className="block text-[11px] text-slate-500">
                    {indexSupport.create
                      ? 'CREATE INDEX on the empty live table (archive keeps its data + indexes under renamed names when needed)'
                      : indexSupport.hint}
                  </span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 text-[13px] cursor-pointer ${
                  fkSupport.alterAdd || fkSupport.createInline
                    ? 'text-slate-200'
                    : 'text-slate-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={
                    keepForeignKeys && (fkSupport.alterAdd || fkSupport.createInline)
                  }
                  disabled={!fkSupport.alterAdd && !fkSupport.createInline}
                  onChange={(e) => setKeepForeignKeys(e.target.checked)}
                  data-testid="clone-keep-fks"
                  className="mt-0.5"
                />
                <span>
                  Foreign keys (auto)
                  <span className="block text-[11px] text-slate-500">
                    Recreate outbound FKs on the new empty table from the live catalog
                    {fkSupport.alterAdd || fkSupport.createInline
                      ? ''
                      : ` — ${fkSupport.hint}`}
                  </span>
                </span>
              </label>
              {inbound.length > 0 ? (
                <p
                  className="text-[11px] text-amber-100/85 rounded-lg border border-amber-500/30 bg-amber-950/30 px-2.5 py-2"
                  data-testid="clone-inbound-warning"
                >
                  {inbound.length} table(s) reference this table (
                  {inbound.slice(0, 6).join(', ')}
                  {inbound.length > 6 ? '…' : ''}). After rename their FKs still point at
                  the archive — adjust those before dropping history if the app needs the
                  empty live table.
                </p>
              ) : null}
            </div>

            {plan?.error ? (
              <p className="text-[12px] text-rose-300" data-testid="clone-plan-error">
                {plan.error}
              </p>
            ) : null}
            {error ? (
              <p className="text-[12px] text-rose-300" data-testid="clone-error">
                {error}
              </p>
            ) : null}
            {status ? (
              <p className="text-[12px] text-emerald-300" data-testid="clone-status">
                {status}
              </p>
            ) : null}

            {plan && !plan.error && plan.statements.length > 0 ? (
              <div>
                <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">
                  SQL preview ({executable.length} executable)
                </p>
                <pre
                  data-testid="clone-sql-preview"
                  className="max-h-56 overflow-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-[11px] font-mono text-slate-300 whitespace-pre-wrap"
                >
                  {plan.statements.join('\n')}
                </pre>
              </div>
            ) : null}
          </div>

          <div className="px-5 py-3 border-t border-slate-700/80 flex flex-wrap justify-end gap-2 shrink-0 bg-slate-900/80">
            {!embedded && (
            <button data-testid="clone-table-close"
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] font-semibold text-slate-400 hover:text-slate-200"
            >
              Close
            </button>
            )}
            <button
              type="button"
              data-testid="clone-insert-sql"
              disabled={!plan || !!plan.error || plan.statements.length === 0}
              onClick={() => {
                if (!plan?.statements.length) return;
                insertAtCursor(plan.statements.join('\n') + '\n');
                setStatus('Clone SQL inserted into the editor');
                setActiveView('sqlEditor');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-[12px] font-bold text-slate-200 disabled:opacity-40"
            >
              Insert SQL
            </button>
            <button
              type="button"
              data-testid="clone-apply"
              disabled={
                !plan || !!plan.error || executable.length === 0 || running || needsPassword
              }
              onClick={onApplyClick}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-500/20 px-3 py-1.5 text-[12px] font-bold text-amber-50 disabled:opacity-40"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
              ) : (
                <Play className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
              )}
              Apply clone
            </button>
          </div>
        </div>
  );

  const confirm = confirmApply ? (
        <WriteConfirmDialog
          writeStatements={executable}
          credentialCount={1}
          onCancel={() => setConfirmApply(false)}
          onConfirm={() => {
            setConfirmApply(false);
            void runClone();
          }}
        />
  ) : null;

  if (embedded) {
    return (
      <>
        <div
          data-testid="clone-table-modal"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {sheet}
        </div>
        {confirm}
      </>
    );
  }

  return createPortal(
    <>
      <div
        data-testid="clone-table-modal"
        className="modal-overlay modal-overlay-soft"
        onClick={onClose}
      >
        {sheet}
      </div>
      {confirm}
    </>,
    document.body
  );
};

function bareLabel(name: string): string {
  const t = name.trim();
  if (!t) return t;
  const parts = t.split('.');
  return parts[parts.length - 1] ?? t;
}
