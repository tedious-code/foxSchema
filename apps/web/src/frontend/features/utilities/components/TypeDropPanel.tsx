/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Drop Type: drop a user-defined type. A database refuses to drop
 * a type a column is declared with, so the plan first moves each such column
 * onto a built-in type, then drops the type. Fox shows what uses the type and
 * the SQL as steps to copy, open in the editor, or execute. It never writes
 * CASCADE: anything it did not see makes the database refuse instead.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, Play, SquareTerminal } from 'lucide-react';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { executeSql } from '@/shared/api/sqlApi';
import { dialectSupportsTypeDrop, planTypeDrop, userTypesOf, type UserTypeKind } from '@/shared/lib/type-drop';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import { needsSessionPassword, PROVIDER_SETTINGS } from '@/shared/lib/provider-settings';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { ColumnReferences } from './ColumnReferences';
import { stepStatements } from '../lib/stepTransaction';
import type { TableSchema } from '@/shared/lib/types';

interface Props {
  /** The credential picked in the Utilities header; none while nothing is saved. */
  lockedConnectionId?: string;
}

/** Tables for where the type is used, routines and views for what may name it, and the types themselves. */
const SCOPE = ['TABLE', 'VIEW', 'MQT', 'PROCEDURE', 'FUNCTION', 'TYPE'] as const;

const KIND_LABEL: Record<UserTypeKind, string> = {
  enum: 'enum',
  domain: 'domain',
  alias: 'alias type',
  composite: 'composite type',
};

const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none accent-focus';

/** The steps as one script, each under a comment naming it. */
export function typeDropScript(steps: Array<{ title: string; sql: string }>): string {
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

export const TypeDropPanel: React.FC<Props> = ({ lockedConnectionId = '' }) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [typeName, setTypeName] = useState('');
  const [replacement, setReplacement] = useState('');
  const [keepValuesCheck, setKeepValuesCheck] = useState(true);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);

  const conn = connections.find((c) => c.id === lockedConnectionId) ?? null;
  const supported = Boolean(conn && dialectSupportsTypeDrop(conn.dialect));
  const needsPassword = Boolean(conn && needsSessionPassword(conn, sessionPasswords[lockedConnectionId]));
  const cache = lockedConnectionId ? schemaCache[lockedConnectionId] : undefined;
  const all: TableSchema[] = useMemo(() => cache?.tables ?? [], [cache?.tables]);
  const types = useMemo(() => userTypesOf(all), [all]);
  const type = types.find((t) => t.name === typeName) ?? null;

  const load = useCallback(
    async (force = false) => {
      if (!lockedConnectionId) return;
      setLoading(true);
      setLoadError(null);
      try {
        ensureConnectionSelected(lockedConnectionId);
        await ensureSchema(lockedConnectionId, { scope: SCOPE, force });
        const entry = useSqlEditorStore.getState().schemaCache[lockedConnectionId];
        if (entry?.status === 'error') setLoadError(entry.error || 'Could not load the schema');
      } catch (e: unknown) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [lockedConnectionId, ensureConnectionSelected, ensureSchema]
  );

  useEffect(() => {
    setTypeName('');
    if (supported && !needsPassword) void load();
    // Reload when the credential changes, or once its password is given.
  }, [lockedConnectionId, supported, needsPassword, load]);

  // Another type starts another plan.
  useEffect(() => {
    setReplacement('');
    setKeepValuesCheck(true);
    setConfirming(false);
    setRunError(null);
    setRunStatus(null);
  }, [typeName]);

  const plan = useMemo(() => {
    if (!conn || !type) return null;
    return planTypeDrop({
      dialect: conn.dialect,
      schema: conn.schema?.trim() || undefined,
      type,
      tables: all,
      replacement: replacement.trim() || undefined,
      keepValuesCheck,
    });
  }, [conn, type, all, replacement, keepValuesCheck]);

  const impact = plan?.impact;
  const script = plan?.ok ? typeDropScript(plan.steps) : '';

  const executeAll = useCallback(async () => {
    if (!plan?.ok) return;
    setRunning(true);
    setConfirming(false);
    setRunError(null);
    setRunStatus(null);
    const dropped = typeName;
    try {
      for (const step of plan.steps) {
        const { statements, transaction } = stepStatements(
          splitSqlStatements(step.sql)
            .map((s) => s.text.trim())
            .filter(Boolean)
        );
        if (statements.length === 0) continue;
        const { results } = await executeSql(
          {
            connectionId: lockedConnectionId,
            password: sessionPasswords[lockedConnectionId] || undefined,
            schema: conn?.schema?.trim() || undefined,
          },
          statements,
          undefined,
          undefined,
          undefined,
          { stopOnError: true, transaction }
        );
        const failed = results.find((row) => !row.ok);
        // Stop at the first refusal: the steps after it assume it worked.
        if (failed && !failed.ok) throw new Error(`${step.title}: ${failed.error}`);
      }
      await load(true);
      setTypeName('');
      setRunStatus(`Dropped ${dropped}.`);
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : String(e));
      // Some steps may have run: show the schema as it is now.
      await load(true);
    } finally {
      setRunning(false);
    }
  }, [plan, typeName, lockedConnectionId, sessionPasswords, conn, load]);

  const askOrRun = () => {
    if (!plan?.ok) return;
    if (needsPassword) {
      setRunError('Enter the session password for this credential first.');
      return;
    }
    if (safeMode) setConfirming(true);
    else void executeAll();
  };

  if (conn && !supported) {
    return (
      <div className="p-5" data-testid="type-drop-panel">
        <p className="text-[12px] text-slate-400" data-testid="type-drop-unsupported">
          {PROVIDER_SETTINGS[conn.dialect.toLowerCase()]?.label ?? conn.dialect} has no user-defined types of its own, so
          there is nothing here to drop.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5" data-testid="type-drop-panel">
      {needsPassword && (
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={sectionLabelCls}>Session password</span>
            <input
              data-testid="type-drop-password"
              type="password"
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            type="button"
            data-testid="type-drop-unlock"
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
          <span className={sectionLabelCls}>Type</span>
          <select
            data-testid="type-drop-type"
            value={typeName}
            onChange={(e) => setTypeName(e.target.value)}
            className={inputCls}
          >
            <option value="">{loading ? 'Loading…' : types.length ? 'Pick a type' : 'No user-defined types'}</option>
            {types.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {impact && impact.columns.length > 0 && impact.suggestedReplacement && (
          <label className="block">
            <span className={sectionLabelCls}>Its columns become</span>
            <input
              data-testid="type-drop-replacement"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={impact.suggestedReplacement}
              className={inputCls}
            />
          </label>
        )}
      </div>

      {loadError && (
        <p className="text-[12px] text-rose-300" data-testid="type-drop-load-error">
          {loadError}
        </p>
      )}

      {!type && !loading && !loadError && (
        <p className="text-[12px] text-slate-500" data-testid="type-drop-hint">
          Pick a type to see what uses it and the SQL that drops it. Columns declared with it are moved to a built-in
          type first; nothing is dropped with CASCADE.
        </p>
      )}

      {runStatus && !runError && (
        <p className="text-[12px] text-emerald-300" data-testid="type-drop-run-status">
          {runStatus}
        </p>
      )}

      {impact && type && (
        <section data-testid="type-drop-impact">
          <h2 className={sectionLabelCls}>
            {type.name} — {KIND_LABEL[impact.kind]}
            {impact.values ? ` · ${impact.values.length} ${impact.values.length === 1 ? 'value' : 'values'}` : ''}
            {impact.baseType ? ` · over ${impact.baseType}` : ''}
          </h2>
          {impact.values && impact.values.length > 0 && (
            <p className="mt-1 font-mono text-[11px] text-slate-400" data-testid="type-drop-values">
              {impact.values.join(' · ')}
            </p>
          )}
          <h2 className={`${sectionLabelCls} mt-3`}>What uses it</h2>
          <ul className="mt-1 space-y-0.5 text-[12px] text-slate-300">
            {impact.columns.map((c) => (
              <li key={`c-${c.table}.${c.column.name}`}>
                Column <code>{c.table}.{c.column.name}</code>
                {c.array ? ' (array)' : ''}
                {c.column.nullable ? '' : ' · not null'}
                {c.column.defaultValue ? ` · default ${c.column.defaultValue}` : ''}
              </li>
            ))}
            {impact.types.map((t) => (
              <li key={`t-${t}`}>
                Type <code>{t}</code> is built on it
              </li>
            ))}
            {impact.dependents.map((d) => (
              <li key={`d-${d.objectType}-${d.name}`}>
                {d.objectType.charAt(0) + d.objectType.slice(1).toLowerCase()} <code>{d.name}</code> may use it
              </li>
            ))}
            {impact.columns.length + impact.types.length + impact.dependents.length === 0 && (
              <li className="text-slate-500">No column, type, view or routine uses it.</li>
            )}
          </ul>
        </section>
      )}

      {impact && <ColumnReferences dependents={impact.dependents.filter((d) => d.references.length > 0)} column={typeName} />}

      {plan && !plan.ok && (
        <p
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200"
          data-testid="type-drop-refused"
        >
          {plan.error}
        </p>
      )}

      {plan?.ok && (
        <>
          {plan.impact.canKeepValuesCheck && plan.impact.columns.length > 0 && (
            <label className="flex items-start gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                data-testid="type-drop-keep-check"
                checked={keepValuesCheck}
                onChange={(e) => setKeepValuesCheck(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="font-bold text-slate-200">Keep the allowed values</span>
                <span className="text-slate-500">
                  {' '}
                  — add a check constraint to each column, so it still accepts only what the type allowed.
                </span>
              </span>
            </label>
          )}

          {plan.warnings.length > 0 && (
            <ul
              className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200"
              data-testid="type-drop-warnings"
            >
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <section className="space-y-3" data-testid="type-drop-steps">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`${sectionLabelCls} flex-1`}>
                {plan.steps.length} {plan.steps.length === 1 ? 'step' : 'steps'}
              </h2>
              <CopyButton text={script} testId="type-drop-copy-all" label="Copy all" />
              {confirming ? (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="type-drop-confirm-all"
                    onClick={() => void executeAll()}
                    className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-bold on-accent-fg"
                  >
                    Confirm: drop {typeName}
                  </button>
                  <button
                    type="button"
                    data-testid="type-drop-confirm-all-cancel"
                    onClick={() => setConfirming(false)}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="type-drop-run-all"
                  disabled={running || needsPassword}
                  onClick={askOrRun}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold text-emerald-200 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  {running ? 'Executing…' : 'Execute all'}
                </button>
              )}
              <button
                type="button"
                data-testid="type-drop-open-editor"
                onClick={() => {
                  // A tab of its own, run against this connection only.
                  const editor = useSqlEditorStore.getState();
                  editor.addTab();
                  editor.setSql(script);
                  editor.renameTab(useSqlEditorStore.getState().activeTabId, `Drop ${typeName}`);
                  editor.selectOnlyConnection(lockedConnectionId);
                  setActiveView('sqlEditor');
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200"
              >
                <SquareTerminal className="h-3 w-3" /> Open in editor
              </button>
            </div>

            {plan.steps.map((step, index) => (
              <article
                key={`${index}-${step.title}`}
                className="rounded-lg border border-slate-800 bg-slate-900/40"
                data-testid={`type-drop-step-${index + 1}`}
              >
                <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                  <span className="text-[12px] font-bold text-slate-100">
                    {index + 1}. {step.title}
                  </span>
                  <span className="flex-1" />
                  <CopyButton text={step.sql} testId={`type-drop-step-${index + 1}-copy`} label="Copy" />
                </header>
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">{step.sql}</pre>
                {step.note && <p className="px-3 pb-2 text-[11px] text-slate-500">{step.note}</p>}
              </article>
            ))}
          </section>
        </>
      )}

      {runError && (
        <p className="text-[12px] text-rose-300" data-testid="type-drop-run-error">
          {runError}
        </p>
      )}

      {loading && (
        <p className="flex items-center gap-1.5 text-[12px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the schema…
        </p>
      )}
    </div>
  );
};
