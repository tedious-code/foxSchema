/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Change Column: rename a column or change its type the safe way.
 * Shows what the change touches, then the steps as SQL to review, copy, or
 * open in a new editor tab for that connection. Nothing runs from here
 * (docs/plans/2026-11-01-safe-column-change.md).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, SquareTerminal } from 'lucide-react';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { DEFAULT_COLUMN_CHANGE_BATCH, planColumnChange, type ColumnChangeStep } from '@/shared/lib/column-change';
import { needsSessionPassword } from '@/shared/lib/provider-settings';
import { sectionLabelCls } from '@/shared/components/surfaces';
import type { TableSchema } from '@/shared/lib/types';

interface Props {
  /** The credential picked in the Utilities header; none while nothing is saved. */
  lockedConnectionId?: string;
}

const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none accent-focus';

/** The steps as one script, each under a comment naming it. */
export function columnChangeScript(steps: ColumnChangeStep[]): string {
  return steps.map((s, i) => `-- Step ${i + 1}: ${s.title}\n${s.sql}`).join('\n\n') + '\n';
}

const CopyButton: React.FC<{ text: string; testId: string; label: string }> = ({ text, testId, label }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:border-slate-500"
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {done ? 'Copied' : label}
    </button>
  );
};

export const ColumnChangePanel: React.FC<Props> = ({ lockedConnectionId = '' }) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [tableName, setTableName] = useState('');
  const [columnName, setColumnName] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [batchSize, setBatchSize] = useState(DEFAULT_COLUMN_CHANGE_BATCH);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const conn = connections.find((c) => c.id === lockedConnectionId) ?? null;
  const needsPassword = Boolean(conn && needsSessionPassword(conn, sessionPasswords[lockedConnectionId]));
  const cache = lockedConnectionId ? schemaCache[lockedConnectionId] : undefined;
  const all: TableSchema[] = useMemo(() => cache?.tables ?? [], [cache?.tables]);
  const tables = useMemo(
    () => all.filter((t) => t.objectType === 'TABLE').slice().sort((a, b) => a.name.localeCompare(b.name)),
    [all]
  );
  const table = tables.find((t) => t.name === tableName) ?? null;
  const column = table?.columns.find((c) => c.name === columnName) ?? null;
  const knownTypes = useMemo(
    () => [...new Set(all.flatMap((t) => t.columns.map((c) => c.type)))].sort((a, b) => a.localeCompare(b)),
    [all]
  );

  const load = useCallback(async () => {
    if (!lockedConnectionId) return;
    setLoading(true);
    setLoadError(null);
    try {
      ensureConnectionSelected(lockedConnectionId);
      await ensureSchema(lockedConnectionId);
      const entry = useSqlEditorStore.getState().schemaCache[lockedConnectionId];
      if (entry?.status === 'error') setLoadError(entry.error || 'Could not load the schema');
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [lockedConnectionId, ensureConnectionSelected, ensureSchema]);

  useEffect(() => {
    setTableName('');
    setColumnName('');
    if (!needsPassword) void load();
    // Reload when the credential changes, or once its password is given.
  }, [lockedConnectionId, needsPassword, load]);

  // A new table or column starts a new change.
  useEffect(() => {
    setNewName('');
    setNewType('');
  }, [tableName, columnName]);

  const plan = useMemo(() => {
    if (!conn || !table || !column || (!newName.trim() && !newType.trim())) return null;
    return planColumnChange({
      dialect: conn.dialect,
      schema: conn.schema?.trim() || undefined,
      table,
      tables: all,
      column: column.name,
      change: { newName: newName.trim() || undefined, newType: newType.trim() || undefined },
      batchSize,
    });
  }, [conn, table, column, newName, newType, batchSize, all]);

  const script = plan?.ok ? columnChangeScript(plan.steps) : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5" data-testid="column-change-panel">
      {needsPassword && (
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={sectionLabelCls}>Session password</span>
            <input
              data-testid="column-change-password"
              type="password"
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            type="button"
            data-testid="column-change-unlock"
            onClick={() => {
              if (!passwordDraft.trim()) return;
              ensureConnectionSelected(lockedConnectionId);
              submitSessionPassword(passwordDraft);
              setPasswordDraft('');
            }}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-[12px] font-bold text-slate-200"
          >
            Unlock
          </button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <label className="block">
          <span className={sectionLabelCls}>Table</span>
          <select
            data-testid="column-change-table"
            value={tableName}
            onChange={(e) => {
              setTableName(e.target.value);
              setColumnName('');
            }}
            className={inputCls}
          >
            <option value="">{loading ? 'Loading…' : tables.length ? 'Pick a table' : 'No tables'}</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={sectionLabelCls}>Column</span>
          <select
            data-testid="column-change-column"
            value={columnName}
            onChange={(e) => setColumnName(e.target.value)}
            disabled={!table}
            className={inputCls}
          >
            <option value="">Pick a column</option>
            {table?.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} · {c.type}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={sectionLabelCls}>New name</span>
          <input
            data-testid="column-change-new-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={column?.name ?? 'Keep the name'}
            disabled={!column}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={sectionLabelCls}>New type</span>
          <input
            data-testid="column-change-new-type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            placeholder={column?.type ?? 'Keep the type'}
            disabled={!column}
            list="column-change-types"
            className={inputCls}
          />
          <datalist id="column-change-types">
            {knownTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className={sectionLabelCls}>Rows per batch</span>
          <input
            data-testid="column-change-batch"
            type="number"
            min={1}
            value={batchSize}
            onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || DEFAULT_COLUMN_CHANGE_BATCH))}
            className={inputCls}
          />
        </label>
      </div>

      {loadError && (
        <p className="text-[12px] text-rose-300" data-testid="column-change-load-error">
          {loadError}
        </p>
      )}

      {!plan && column && (
        <p className="text-[12px] text-slate-500" data-testid="column-change-hint">
          Give a new name, a new type, or both. Nothing runs from here: you get the steps as SQL to review.
        </p>
      )}

      {plan && !plan.ok && (
        <p
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200"
          data-testid="column-change-refused"
        >
          {plan.error}
        </p>
      )}

      {plan?.ok && (
        <>
          <section data-testid="column-change-impact">
            <h2 className={sectionLabelCls}>What it touches</h2>
            <ul className="mt-1 space-y-0.5 text-[12px] text-slate-300">
              {plan.impact.indexes.map((i) => (
                <li key={`i-${i.name}`}>
                  {i.unique ? 'Unique index' : 'Index'} <code>{i.name}</code> ({i.columns.join(', ')})
                </li>
              ))}
              {plan.impact.outboundForeignKeys.map((fk) => (
                <li key={`f-${fk.name}`}>
                  Foreign key <code>{fk.name}</code> → {fk.referencedTable}
                </li>
              ))}
              {plan.impact.views.map((v) => (
                <li key={`v-${v}`}>
                  View <code>{v}</code> may use it
                </li>
              ))}
              {plan.impact.triggers.map((t) => (
                <li key={`t-${t.name}`}>
                  Trigger <code>{t.name}</code> may use it
                </li>
              ))}
              {plan.impact.indexes.length +
                plan.impact.outboundForeignKeys.length +
                plan.impact.views.length +
                plan.impact.triggers.length ===
                0 && <li className="text-slate-500">No index, key, view or trigger uses it.</li>}
            </ul>
          </section>

          {plan.warnings.length > 0 && (
            <ul
              className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200"
              data-testid="column-change-warnings"
            >
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <section className="space-y-3" data-testid="column-change-steps">
            <div className="flex items-center gap-2">
              <h2 className={`${sectionLabelCls} flex-1`}>Steps ({plan.steps.length})</h2>
              <CopyButton text={script} testId="column-change-copy-all" label="Copy all" />
              <button
                type="button"
                data-testid="column-change-open-editor"
                onClick={() => {
                  // A tab of its own, run against this connection only: these
                  // steps belong to one database, never to whatever else is checked.
                  const editor = useSqlEditorStore.getState();
                  editor.addTab();
                  editor.setSql(script);
                  editor.renameTab(useSqlEditorStore.getState().activeTabId, `Change ${table?.name}.${column?.name}`);
                  editor.selectOnlyConnection(lockedConnectionId);
                  setActiveView('sqlEditor');
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200"
              >
                <SquareTerminal className="h-3 w-3" /> Open in editor
              </button>
            </div>
            {plan.steps.map((step, i) => (
              <article
                key={step.title}
                className="rounded-lg border border-slate-800 bg-slate-900/40"
                data-testid={`column-change-step-${i + 1}`}
              >
                <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                  <span className="text-[12px] font-bold text-slate-100">
                    {i + 1}. {step.title}
                  </span>
                  {step.rerunSafe && (
                    <span className="rounded-full border border-sky-500/40 px-1.5 text-[10px] text-sky-300">safe to rerun</span>
                  )}
                  <span className="flex-1" />
                  <CopyButton text={step.sql} testId={`column-change-step-${i + 1}-copy`} label="Copy" />
                </header>
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">{step.sql}</pre>
                {step.note && <p className="px-3 pb-2 text-[11px] text-slate-500">{step.note}</p>}
              </article>
            ))}
          </section>
        </>
      )}

      {loading && (
        <p className="flex items-center gap-1.5 text-[12px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the schema…
        </p>
      )}
    </div>
  );
};
