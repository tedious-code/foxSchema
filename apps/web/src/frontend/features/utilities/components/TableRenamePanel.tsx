/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Rename Table: dialect SQL to review, copy, or open in a new
 * editor tab for that connection. Nothing runs from here.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, SquareTerminal } from 'lucide-react';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { planTableRename } from '@/features/sql-editor/ui';
import { useUiStore } from '@/platform/uiStore';
import { needsSessionPassword } from '@/shared/lib/provider-settings';
import { sectionLabelCls } from '@/shared/components/surfaces';
import type { TableSchema } from '@/shared/lib/types';

interface Props {
  /** The credential picked in the Utilities header; none while nothing is saved. */
  lockedConnectionId?: string;
}

const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none accent-focus';

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

export const TableRenamePanel: React.FC<Props> = ({ lockedConnectionId = '' }) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [tableName, setTableName] = useState('');
  const [newName, setNewName] = useState('');
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
    setNewName('');
    if (!needsPassword) void load();
  }, [lockedConnectionId, needsPassword, load]);

  useEffect(() => {
    setNewName('');
  }, [tableName]);

  const plan = useMemo(() => {
    if (!conn || !table || !newName.trim()) return null;
    return planTableRename({
      dialect: conn.dialect,
      schema: conn.schema?.trim() || undefined,
      table,
      newName,
      tables: all,
    });
  }, [conn, table, newName, all]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5" data-testid="table-rename-panel">
      {needsPassword && (
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={sectionLabelCls}>Session password</span>
            <input
              data-testid="table-rename-password"
              type="password"
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            type="button"
            data-testid="table-rename-unlock"
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

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={sectionLabelCls}>Table</span>
          <select
            data-testid="table-rename-table"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
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
          <span className={sectionLabelCls}>New name</span>
          <input
            data-testid="table-rename-new-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={table?.name ?? 'New table name'}
            disabled={!table}
            className={inputCls}
          />
        </label>
      </div>

      {loadError && (
        <p className="text-[12px] text-rose-300" data-testid="table-rename-load-error">
          {loadError}
        </p>
      )}

      {!plan && table && (
        <p className="text-[12px] text-slate-500" data-testid="table-rename-hint">
          Give the new table name. Nothing runs from here: you get the SQL to review.
        </p>
      )}

      {plan && !plan.ok && (
        <p
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200"
          data-testid="table-rename-refused"
        >
          {plan.error}
        </p>
      )}

      {plan?.ok && (
        <>
          <section data-testid="table-rename-impact">
            <h2 className={sectionLabelCls}>What it touches</h2>
            <ul className="mt-1 space-y-0.5 text-[12px] text-slate-300">
              {plan.impact.inboundTables.map((name) => (
                <li key={`in-${name}`}>
                  Foreign key from <code>{name}</code>
                </li>
              ))}
              {plan.impact.views.map((v) => (
                <li key={`v-${v}`}>
                  View <code>{v}</code> may name it
                </li>
              ))}
              {plan.impact.triggers.map((t) => (
                <li key={`t-${t}`}>
                  Trigger <code>{t}</code> may name it
                </li>
              ))}
              {plan.impact.inboundTables.length + plan.impact.views.length + plan.impact.triggers.length === 0 && (
                <li className="text-slate-500">No other table, view or trigger names it.</li>
              )}
            </ul>
          </section>

          {plan.warnings.length > 0 && (
            <ul
              className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200"
              data-testid="table-rename-warnings"
            >
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <section className="space-y-3" data-testid="table-rename-sql">
            <div className="flex items-center gap-2">
              <h2 className={`${sectionLabelCls} flex-1`}>SQL</h2>
              <CopyButton text={plan.sql} testId="table-rename-copy" label="Copy" />
              <button
                type="button"
                data-testid="table-rename-open-editor"
                onClick={() => {
                  const editor = useSqlEditorStore.getState();
                  editor.addTab();
                  editor.setSql(plan.sql);
                  editor.renameTab(useSqlEditorStore.getState().activeTabId, `Rename ${table?.name}`);
                  editor.selectOnlyConnection(lockedConnectionId);
                  setActiveView('sqlEditor');
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200"
              >
                <SquareTerminal className="h-3 w-3" /> Open in editor
              </button>
            </div>
            <pre
              className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200"
              data-testid="table-rename-statement"
            >
              {plan.sql}
            </pre>
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
