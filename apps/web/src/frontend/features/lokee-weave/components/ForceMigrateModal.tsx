/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Apply a stored schema version to a database it was never captured from.
 *
 * Deliberately self-contained: it picks its own version and its own target
 * rather than inheriting whatever the graph has selected. The graph's selection
 * means "the version I am reading about"; this modal's means "the version I am
 * about to write onto another database", and quietly reusing one as the other
 * is how you deploy the wrong schema.
 *
 * Two acknowledgements, not one. `confirmLossy` answers "data will be
 * destroyed"; `confirmForce` answers "this is not the database this history
 * came from". A plan that destroys nothing still needs the second, so the
 * checkboxes are separate and the server refuses until each that applies is
 * given.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, TriangleAlert, X } from 'lucide-react';
import {
  executeLokeeForceMigrate,
  listLokeeVersions,
  planLokeeForceMigrate,
  type LokeeForceMigratePlan,
  type LokeeVersion,
} from '../api/lokeeApi';
import { useSyncStore } from '@/features/compare';
import { getSessionPassword } from '@/shared/lib/sessionPasswords';
import { toast } from '@/app/store/toastStore';
import { riskStyle } from '@/features/lokee-weave/lib/lokeeColors';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { versionDisplayName } from './graphTypes';

export interface ForceMigrateModalProps {
  /** History the version is taken from. */
  databaseId: string;
  onClose: () => void;
  /** Called after a successful apply so the caller can refresh its graph. */
  onApplied?: () => void;
}

export function ForceMigrateModal({
  databaseId,
  onClose,
  onApplied,
}: ForceMigrateModalProps): React.ReactElement {
  const connections = useSyncStore((s) => s.connections);
  const [versions, setVersions] = useState<LokeeVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [plan, setPlan] = useState<LokeeForceMigratePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [confirmLossy, setConfirmLossy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listLokeeVersions(databaseId)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        setVersionId((current) => current || rows[0]?.id || '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load versions');
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId]);

  /**
   * Any change to either side throws the plan away.
   *
   * A plan computed against one target says nothing about another, and a stale
   * one on screen would let the reader confirm statements that were never
   * generated for the database now selected.
   */
  useEffect(() => {
    setPlan(null);
    setConfirmForce(false);
    setConfirmLossy(false);
    setError(null);
  }, [versionId, connectionId]);

  const preview = useCallback(async () => {
    if (!versionId || !connectionId) return;
    setPlanning(true);
    setError(null);
    try {
      const next = await planLokeeForceMigrate(databaseId, {
        versionId,
        connectionId,
        password: getSessionPassword(connectionId) || undefined,
      });
      setPlan(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not plan the force migrate');
    } finally {
      setPlanning(false);
    }
  }, [databaseId, versionId, connectionId]);

  const apply = useCallback(async () => {
    if (!plan || !versionId || !connectionId) return;
    setRunning(true);
    setError(null);
    try {
      await executeLokeeForceMigrate(databaseId, {
        versionId,
        connectionId,
        password: getSessionPassword(connectionId) || undefined,
        confirmForce,
        confirmLossy,
      });
      toast({
        tone: 'success',
        title: 'Version applied',
        body: 'The target now holds this version, and its history records where it came from.',
      });
      onApplied?.();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Force migrate failed';
      setError(message);
      toast({ tone: 'warning', title: 'Force migrate failed', body: message });
    } finally {
      setRunning(false);
    }
  }, [databaseId, versionId, connectionId, plan, confirmForce, confirmLossy, onApplied, onClose]);

  const lossy = plan?.reversal.risk === 'lossy';
  const blocked = plan?.reversal.risk === 'blocked';
  const target = connections.find((c) => c.id === connectionId);
  // Whether the *preconditions* are met. Being mid-request is a separate
  // concern and belongs on the button, not in here.
  const ready =
    !!plan && !blocked && !plan.alreadyMatches && confirmForce && (!lossy || confirmLossy);

  return (
    <div
      data-testid="force-migrate-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2">
          <h2 className="text-sm font-bold text-slate-100">Force-migrate a version</h2>
          <button
            type="button"
            data-testid="force-migrate-close"
            onClick={onClose}
            title="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" strokeWidth={SQL_ICON_STROKE} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
          <p className="flex items-start gap-2 rounded border border-amber-700/50 bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-100">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={SQL_ICON_STROKE} />
            <span>
              This writes a stored schema onto a database that did not produce it. The identity
              check that keeps a revert on its own database is skipped on purpose here.
            </span>
          </p>

          <label className="block text-[11px] font-semibold text-slate-400">
            Version to apply
            <select
              data-testid="force-migrate-version"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 accent-focus focus:outline-none"
            >
              {versions.length === 0 && <option value="">No versions</option>}
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionDisplayName(v)}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] font-semibold text-slate-400">
            Target database
            <select
              data-testid="force-migrate-target"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 accent-focus focus:outline-none"
            >
              <option value="">Choose a credential…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} [{c.dialect}]
                  {c.database ? ` · ${c.database}` : ''}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            data-testid="force-migrate-preview"
            disabled={!versionId || !connectionId || planning}
            onClick={() => void preview()}
            className="inline-flex items-center gap-1.5 rounded border border-cyan-500/40 bg-cyan-950/40 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {planning ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            ) : null}
            Preview plan
          </button>

          {error && (
            <p data-testid="force-migrate-error" className="text-[11px] font-semibold text-rose-300">
              {error}
            </p>
          )}

          {plan && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  data-testid="force-migrate-risk"
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${riskStyle(plan.reversal.risk).badge}`}
                >
                  {riskStyle(plan.reversal.risk).label}
                </span>
                <span className="text-[11px] text-slate-400">
                  {plan.alreadyMatches
                    ? 'The target already holds this version — nothing to apply.'
                    : `${plan.statements.length} statement(s) against ${target?.database ?? 'the target'}`}
                </span>
              </div>

              {plan.statements.length > 0 && (
                <pre className="max-h-48 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-300">
                  {plan.statements.join('\n')}
                </pre>
              )}

              {blocked && (
                <p className="text-[11px] text-rose-300">
                  Blocked — this cannot be applied without losing data the schema cannot restore.
                </p>
              )}

              {!plan.alreadyMatches && !blocked && (
                <>
                  {lossy && (
                    <label className="flex items-start gap-1.5 text-[11px] text-amber-200">
                      <input
                        type="checkbox"
                        data-testid="force-migrate-confirm-lossy"
                        checked={confirmLossy}
                        onChange={(e) => setConfirmLossy(e.target.checked)}
                        className="mt-0.5 h-3 w-3 accent-amber-500"
                      />
                      I understand data on the target will be lost permanently.
                    </label>
                  )}
                  {/* Always shown, even when the plan is safe: agreeing to lose
                      data is not the same as agreeing to write onto a database
                      this history never came from. */}
                  <label className="flex items-start gap-1.5 text-[11px] text-amber-200">
                    <input
                      type="checkbox"
                      data-testid="force-migrate-confirm-force"
                      checked={confirmForce}
                      onChange={(e) => setConfirmForce(e.target.checked)}
                      className="mt-0.5 h-3 w-3 accent-amber-500"
                    />
                    I understand this applies the schema to{' '}
                    <span className="font-semibold">{target?.name ?? 'the selected database'}</span>,
                    which is not the database this history was captured from.
                  </label>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800 px-4 py-2">
          <button data-testid="force-migrate-cancel"
            type="button"
            onClick={onClose}
            className="rounded px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="force-migrate-apply"
            disabled={!ready || running}
            onClick={() => void apply()}
            className="inline-flex items-center gap-1.5 rounded border border-amber-500/50 bg-amber-950/40 px-2.5 py-1 text-[11px] font-bold text-amber-100 transition hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Play className="h-3 w-3 fill-current" strokeWidth={SQL_ICON_STROKE} />
            )}
            {running ? 'Applying…' : 'Apply to target'}
          </button>
        </div>
      </div>
    </div>
  );
}
