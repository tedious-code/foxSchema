/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Rename Column: rename a column or change its type the safe way.
 * A type change is three parts — add a nullable column, copy rows in a loop
 * (with progress), then constraints / triggers / description — each with
 * preview SQL to copy, run, or execute all. Lossy type conversions warn
 * and must be acknowledged before Run or Execute all.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, Play, SquareTerminal } from 'lucide-react';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { executeSql, type SqlStatementResult } from '@/shared/api/sqlApi';
import {
  COLUMN_CHANGE_PHASES,
  DEFAULT_COLUMN_CHANGE_BATCH,
  planColumnChange,
  type ColumnChangePhase,
  type ColumnChangePlan,
  type ColumnChangeProgressSql,
  type ColumnChangeStep,
} from '@/shared/lib/column-change';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import { needsSessionPassword } from '@/shared/lib/provider-settings';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { ColumnReferences } from './ColumnReferences';
import type { TableSchema } from '@/shared/lib/types';

interface Props {
  /** The credential picked in the Utilities header; none while nothing is saved. */
  lockedConnectionId?: string;
}

type RunTarget = ColumnChangePhase | 'all';

const PHASE_ORDER: ColumnChangePhase[] = ['add', 'copy', 'finish'];

function statusFor(phase: ColumnChangePhase): string {
  if (phase === 'add') return 'New column is in place.';
  if (phase === 'copy') return 'Copy finished. Check the mismatch count is 0 before the last part.';
  return 'Constraints, triggers and description are applied.';
}

function progressFor(phase: ColumnChangePhase): string {
  if (phase === 'add') return 'Adding the new column…';
  if (phase === 'copy') return 'Copying data…';
  return 'Applying constraints, triggers and description…';
}

const inputCls =
  'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none accent-focus';

/** The steps as one script, each under a comment naming it. */
export function columnChangeScript(steps: ColumnChangeStep[]): string {
  return steps.map((s, i) => `-- Step ${i + 1}: ${s.title}\n${s.sql}`).join('\n\n') + '\n';
}

function statementsOf(sql: string): string[] {
  return splitSqlStatements(sql)
    .map((s) => s.text.trim())
    .filter(Boolean);
}

function countFrom(result: SqlStatementResult | undefined): number {
  if (!result) throw new Error('No row count came back.');
  if (!result.ok) throw new Error(result.error);
  const raw = result.rows?.[0]?.[0];
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) throw new Error('Could not read the row count.');
  return n;
}

/** Loop the one-batch patch until remaining is 0. Never run the preview DO / procedure / WHILE. */
async function runCopyBatches(
  progress: ColumnChangeProgressSql,
  exec: (sql: string) => Promise<SqlStatementResult[]>,
  report: (state: { done: number; total: number }) => void,
): Promise<void> {
  async function rows(sql: string): Promise<number> {
    return countFrom((await exec(sql))[0]);
  }
  const total = await rows(progress.totalSql);
  let remaining = await rows(progress.remainingSql);
  report({ done: Math.max(0, total - remaining), total });
  while (remaining > 0) {
    const before = remaining;
    await exec(progress.patchSql);
    remaining = await rows(progress.remainingSql);
    report({ done: Math.max(0, total - remaining), total });
    if (remaining >= before) {
      throw new Error(
        `A batch copied no further rows (${remaining.toLocaleString('en-US')} still waiting). Stop and check the preview SQL.`
      );
    }
  }
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
  const [runningTarget, setRunningTarget] = useState<RunTarget | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<RunTarget | null>(null);
  const [ackLossy, setAckLossy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const safeMode = useSqlEditorStore((s) => s.safeMode);

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
      await ensureSchema(lockedConnectionId, {
        scope: ['TABLE', 'VIEW', 'MQT', 'PROCEDURE', 'FUNCTION'],
      });
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
    setRunError(null);
    setRunStatus(null);
    setConfirmTarget(null);
    setAckLossy(false);
    setProgress(null);
  }, [tableName, columnName]);

  useEffect(() => {
    setAckLossy(false);
    setConfirmTarget(null);
  }, [newType]);

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
  const typeChange = Boolean(plan?.ok && plan.progress);
  const conversionWarning = plan?.ok ? plan.impact.lossy : undefined;
  const runDisabled =
    Boolean(runningTarget) || needsPassword || Boolean(conversionWarning && !ackLossy);
  const parts = typeChange
    ? COLUMN_CHANGE_PHASES
    : [{ id: 'add' as const, title: 'Rename', blurb: 'Instant catalog rename. Indexes follow; application SQL that names the column does not.' }];

  const runStatements = useCallback(
    async (sql: string): Promise<SqlStatementResult[]> => {
      const statements = statementsOf(sql);
      if (statements.length === 0) return [];
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
        { stopOnError: true }
      );
      const failed = results.find((row) => !row.ok);
      if (failed && !failed.ok) throw new Error(failed.error);
      return results;
    },
    [lockedConnectionId, sessionPasswords, conn]
  );

  const executePhase = useCallback(
    async (phase: ColumnChangePhase, live: Extract<ColumnChangePlan, { ok: true }>, reload: boolean) => {
      const steps = live.steps.filter((s) => s.phase === phase);
      if (steps.length === 0) return;
      if (phase === 'copy' && live.progress) {
        for (const step of steps) {
          if (step.title.startsWith('Copy the data')) {
            await runCopyBatches(live.progress, runStatements, setProgress);
          } else {
            await runStatements(step.sql);
          }
        }
      } else {
        for (const step of steps) await runStatements(step.sql);
        if (reload && phase !== 'copy') await ensureSchema(lockedConnectionId, { force: true });
      }
    },
    [runStatements, ensureSchema, lockedConnectionId]
  );

  const runPhase = useCallback(
    async (phase: ColumnChangePhase, live: Extract<ColumnChangePlan, { ok: true }>) => {
      setRunningTarget(phase);
      setRunError(null);
      setRunStatus(null);
      setConfirmTarget(null);
      try {
        await executePhase(phase, live, true);
        setRunStatus(statusFor(phase));
      } catch (e: unknown) {
        setRunError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunningTarget(null);
      }
    },
    [executePhase]
  );

  const runAll = useCallback(
    async (live: Extract<ColumnChangePlan, { ok: true }>) => {
      const phases = live.progress ? PHASE_ORDER : (['add'] as ColumnChangePhase[]);
      setRunningTarget('all');
      setRunError(null);
      setRunStatus(null);
      setConfirmTarget(null);
      try {
        for (let i = 0; i < phases.length; i++) {
          const phase = phases[i]!;
          setRunStatus(progressFor(phase));
          await executePhase(phase, live, i === phases.length - 1);
        }
        setRunStatus(live.progress ? 'All parts finished.' : 'Rename finished.');
      } catch (e: unknown) {
        setRunError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunningTarget(null);
      }
    },
    [executePhase]
  );

  const startRun = (target: RunTarget, live: Extract<ColumnChangePlan, { ok: true }>) => {
    if (target === 'all') void runAll(live);
    else void runPhase(target, live);
  };

  const askOrRun = (target: RunTarget) => {
    if (!plan?.ok) return;
    if (needsPassword) {
      setRunError('Enter the session password for this credential first.');
      return;
    }
    if (plan.impact.lossy && !ackLossy) {
      setRunError('Acknowledge the type-conversion warning before running.');
      return;
    }
    if (safeMode) {
      setConfirmTarget(target);
      return;
    }
    startRun(target, plan);
  };

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
          Give a new name, a new type, or both. You get the SQL in parts to copy or run here.
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
                  {i.constraint ? 'Unique constraint' : i.unique ? 'Unique index' : 'Index'}{' '}
                  <code>{i.name}</code> ({i.columns.join(', ')})
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
              {plan.impact.functions.map((fn) => (
                <li key={`fn-${fn}`}>
                  Function <code>{fn}</code> may use it
                </li>
              ))}
              {plan.impact.procedures.map((p) => (
                <li key={`p-${p}`}>
                  Procedure <code>{p}</code> may use it
                </li>
              ))}
              {plan.impact.indexes.length +
                plan.impact.outboundForeignKeys.length +
                plan.impact.views.length +
                plan.impact.triggers.length +
                plan.impact.functions.length +
                plan.impact.procedures.length ===
                0 && <li className="text-slate-500">No index, key, view, trigger, function or procedure uses it.</li>}
            </ul>
          </section>

          <ColumnReferences dependents={plan.impact.dependents} column={columnName} />

          {conversionWarning && (
            <div
              className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100"
              data-testid="column-change-conversion"
            >
              <p>
                <span className="font-bold">Type conversion warning.</span> {conversionWarning} Acknowledge this
                before Run or Execute all.
              </p>
              <label className="flex items-start gap-1.5 text-amber-200">
                <input
                  type="checkbox"
                  data-testid="column-change-confirm-lossy"
                  checked={ackLossy}
                  onChange={(e) => setAckLossy(e.target.checked)}
                  className="mt-0.5 h-3 w-3 accent-amber-500"
                />
                I understand some values may fail to convert or be truncated.
              </label>
            </div>
          )}

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
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`${sectionLabelCls} flex-1`}>
                {typeChange ? 'Three parts' : 'Rename'} ({plan.steps.length} steps)
              </h2>
              <CopyButton text={script} testId="column-change-copy-all" label="Copy all" />
              {confirmTarget === 'all' ? (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="column-change-confirm-all"
                    onClick={() => startRun('all', plan)}
                    className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-bold on-accent-fg"
                  >
                    Confirm execute all
                  </button>
                  <button
                    type="button"
                    data-testid="column-change-confirm-all-cancel"
                    onClick={() => setConfirmTarget(null)}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="column-change-run-all"
                  disabled={runDisabled}
                  onClick={() => askOrRun('all')}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold text-emerald-200 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {runningTarget === 'all' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  {runningTarget === 'all' ? 'Executing…' : 'Execute all'}
                </button>
              )}
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

            {runError && (
              <p className="text-[12px] text-rose-300" data-testid="column-change-run-error">
                {runError}
              </p>
            )}
            {runStatus && !runError && (
              <p className="text-[12px] text-emerald-300" data-testid="column-change-run-status">
                {runStatus}
              </p>
            )}

            {parts.map((part) => {
              const steps = plan.steps.filter((s) => s.phase === part.id);
              if (steps.length === 0) return null;
              const partScript = columnChangeScript(steps);
              const busy = runningTarget === part.id || runningTarget === 'all';
              return (
                <section
                  key={part.id}
                  className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3"
                  data-testid={`column-change-part-${part.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[12px] font-bold text-slate-100">{part.title}</h3>
                    <span className="flex-1 text-[11px] text-slate-500">{part.blurb}</span>
                    <CopyButton text={partScript} testId={`column-change-part-${part.id}-copy`} label="Copy SQL" />
                    {confirmTarget === part.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`column-change-confirm-${part.id}`}
                          onClick={() => startRun(part.id, plan)}
                          className="rounded-md bg-amber-400 px-2 py-1 text-[11px] font-bold on-accent-fg"
                        >
                          Confirm run
                        </button>
                        <button
                          type="button"
                          data-testid={`column-change-confirm-${part.id}-cancel`}
                          onClick={() => setConfirmTarget(null)}
                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`column-change-run-${part.id}`}
                        disabled={runDisabled}
                        onClick={() => askOrRun(part.id)}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold text-emerald-200 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        {busy ? 'Running…' : 'Run'}
                      </button>
                    )}
                  </div>
                  {part.id === 'copy' && progress && (
                    <p className="font-mono text-[12px] text-sky-300" data-testid="column-change-progress">
                      Processing {progress.done.toLocaleString('en-US')} / {progress.total.toLocaleString('en-US')}
                    </p>
                  )}
                  {steps.map((step) => {
                    const index = plan.steps.indexOf(step);
                    return (
                      <article
                        key={step.title}
                        className="rounded-lg border border-slate-800 bg-slate-900/40"
                        data-testid={`column-change-step-${index + 1}`}
                      >
                        <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                          <span className="text-[12px] font-bold text-slate-100">
                            {index + 1}. {step.title}
                          </span>
                          {step.rerunSafe && (
                            <span className="rounded-full border border-sky-500/40 px-1.5 text-[10px] text-sky-300">
                              safe to rerun
                            </span>
                          )}
                          <span className="flex-1" />
                          <CopyButton text={step.sql} testId={`column-change-step-${index + 1}-copy`} label="Copy" />
                        </header>
                        <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">
                          {step.sql}
                        </pre>
                        {step.note && <p className="px-3 pb-2 text-[11px] text-slate-500">{step.note}</p>}
                      </article>
                    );
                  })}
                </section>
              );
            })}
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
