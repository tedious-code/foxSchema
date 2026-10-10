/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * History toolbar — same Original → Target cards as Compare, but the sides
 * are versions of one captured database instead of two live connections.
 */
import React, { useMemo } from 'react';
import { ArrowLeftRight, ArrowRight, Camera, GitCompareArrows, Loader2, RefreshCw } from 'lucide-react';
import { useLokeeHistoryStore } from '@/features/lokee-weave/store/lokeeHistoryStore';
import { useSyncStore } from '@/features/compare';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import {
  historyVersionLabel,
  lokeeDatabaseLabel,
  resolveHistoryCompare,
  sortVersionsNewestFirst,
} from '@/features/lokee-weave/lib/historyCompare';

export function HistoryCompareBar(): React.ReactElement {
  const databases = useLokeeHistoryStore((s) => s.databases);
  const versions = useLokeeHistoryStore((s) => s.versions);
  const databaseId = useLokeeHistoryStore((s) => s.databaseId);
  const originalVersionId = useLokeeHistoryStore((s) => s.originalVersionId);
  const targetVersionId = useLokeeHistoryStore((s) => s.targetVersionId);
  const setDatabaseId = useLokeeHistoryStore((s) => s.setDatabaseId);
  const setOriginalVersionId = useLokeeHistoryStore((s) => s.setOriginalVersionId);
  const setTargetVersionId = useLokeeHistoryStore((s) => s.setTargetVersionId);
  const swapSides = useLokeeHistoryStore((s) => s.swapSides);
  const connections = useSyncStore((s) => s.connections);
  const captureConnectionId = useLokeeHistoryStore((s) => s.captureConnectionId);
  const setCaptureConnectionId = useLokeeHistoryStore((s) => s.setCaptureConnectionId);
  const capturing = useLokeeHistoryStore((s) => s.capturing);
  const requestCapture = useLokeeHistoryStore((s) => s.requestCapture);
  const requestRefresh = useLokeeHistoryStore((s) => s.requestRefresh);
  const requestCompare = useLokeeHistoryStore((s) => s.requestCompare);

  const newestFirst = useMemo(() => sortVersionsNewestFirst(versions), [versions]);
  const resolved = useMemo(
    () => resolveHistoryCompare(versions, { originalVersionId, targetVersionId }),
    [versions, originalVersionId, targetVersionId]
  );
  const olderTargets = newestFirst.filter((v) => v.id !== resolved.latest?.id);
  const sameSides =
    Boolean(resolved.original && resolved.target && resolved.original.id === resolved.target.id);

  return (
    <div className="flex min-w-0 flex-wrap items-stretch gap-1.5" data-testid="lokee-history-compare-bar">
      <div className="flex min-w-[16rem] flex-1 flex-col gap-1 rounded-full border border-slate-800/80 bg-slate-950/60 px-2 py-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-500/80">
            Original
          </div>
          <div className="text-[10px] text-slate-500">Select a version</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            data-testid="lokee-database-select"
            value={databaseId ?? ''}
            disabled={databases.length === 0}
            onChange={(e) => setDatabaseId(e.target.value || null)}
            title="History database"
            className="min-w-0 flex-1 text-xs bg-slate-900 border border-slate-700/60 rounded px-2 py-1 text-slate-200 focus:outline-none accent-focus truncate disabled:opacity-50"
          >
            {databases.length === 0 && <option value="">No captures yet</option>}
            {databases.map((d) => (
              <option key={d.id} value={d.id}>
                {lokeeDatabaseLabel(d)}
              </option>
            ))}
          </select>
          <select
            data-testid="lokee-original-version"
            value={resolved.original?.id ?? ''}
            disabled={newestFirst.length === 0}
            onChange={(e) => setOriginalVersionId(e.target.value || null)}
            title="Baseline version (like Compare's Original Server)"
            className="min-w-0 w-44 max-w-full text-xs bg-slate-900 border border-cyan-500/30 rounded px-2 py-1 text-cyan-100 focus:outline-none accent-focus truncate disabled:opacity-50"
          >
            {newestFirst.length === 0 && <option value="">No versions</option>}
            {newestFirst.map((v) => (
              <option key={v.id} value={v.id}>
                {/* The newest version stays selectable — it is a perfectly good
                    baseline to compare against — but it says outright that a
                    revert onto it has nothing to do. */}
                {historyVersionLabel(
                  v,
                  v.id === resolved.latest?.id ? { compareOnly: 'is-current' } : undefined
                )}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex xl:col-span-1 justify-center items-center">
        <button
          type="button"
          data-testid="lokee-history-swap-btn"
          onClick={swapSides}
          disabled={sameSides || newestFirst.length < 2}
          title="Swap Original and Target"
          className="group flex flex-col items-center gap-0.5 transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-500/70 group-hover:text-cyan-400">
            Original
          </span>
          <ArrowRight className="w-5 h-5 text-indigo-500/80 group-hover:hidden transition" />
          <ArrowLeftRight className="w-5 h-5 text-cyan-400 hidden group-hover:block" />
          <span className="text-[9px] font-bold uppercase tracking-wider text-purple-400/70 group-hover:text-cyan-400">
            Target
          </span>
        </button>
      </div>

      <div className="flex min-w-[16rem] flex-1 flex-col gap-1 rounded-full border border-slate-800/80 bg-slate-950/60 px-2 py-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-purple-400/80">
            Target
          </div>
          <div className="text-[10px] text-slate-500">Current database or older version</div>
        </div>
        <div className="flex items-center gap-1.5">
        <select
          data-testid="lokee-target-version"
          value={resolved.targetIsCurrent ? '' : (resolved.target?.id ?? '')}
          disabled={newestFirst.length === 0}
          onChange={(e) => setTargetVersionId(e.target.value || null)}
          title="Current live snapshot, or an older version"
          className="min-w-0 flex-1 text-xs bg-slate-900 border border-purple-500/30 rounded px-2 py-1 text-purple-100 focus:outline-none focus:border-purple-500 truncate disabled:opacity-50"
        >
          {resolved.latest ? (
            <option value="">{historyVersionLabel(resolved.latest, { current: true })}</option>
          ) : (
            <option value="">Current database</option>
          )}
          {/* A revert restores the live database, so anything other than
              "Current database" here is a comparison only — the diff would not
              be the DDL that runs. Said in the option rather than discovered at
              a greyed-out Execute button. */}
          {olderTargets.map((v) => (
            <option key={v.id} value={v.id}>
              {historyVersionLabel(v, { compareOnly: 'not-current' })}
            </option>
          ))}
        </select>
        {/* The diff belongs to the pair, and the pair is finished being chosen
            here — so the button that opens it sits with the second side rather
            than on a strip of its own below the bar.
            
            Absent rather than disabled when the two sides resolve to the same
            version: with a single-version history there is no pair and never
            will be until another capture lands, so a permanently dead control
            is just clutter. */}
        {!sameSides && newestFirst.length >= 2 && (
        <button
          type="button"
          data-testid="lokee-compare-versions-btn"
          onClick={requestCompare}
          title="Diff Original against Target"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/30 px-2 py-1 text-[11px] font-bold text-cyan-100 transition hover:bg-cyan-900/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GitCompareArrows className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
          Compare
        </button>
        )}
        </div>
      </div>

      {/* Capture lives on this row too. It used to sit on a second bar with its
          own credential picker, which read as a *third* connection control next
          to the two above it — three pickers for two ideas. */}
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1 rounded-full border border-slate-800/80 bg-slate-950/60 px-2 py-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Capture
          </div>
          <button
            type="button"
            data-testid="lokee-refresh-btn"
            onClick={requestRefresh}
            title="Reload databases and graph"
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-slate-200"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
            Refresh
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            data-testid="lokee-capture-connection"
            value={captureConnectionId}
            onChange={(e) => setCaptureConnectionId(e.target.value)}
            title="Live credential to snapshot into this history"
            className="min-w-0 flex-1 text-xs bg-slate-900 border border-slate-700/60 rounded px-2 py-1 text-slate-200 focus:outline-none accent-focus truncate"
          >
            <option value="">Credential…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} [{c.dialect}]
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="lokee-capture-btn"
            disabled={!captureConnectionId || capturing}
            onClick={requestCapture}
            title="Read the live schema and record it as a new version"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/40 px-2 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {capturing ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Camera className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
            )}
            {capturing ? 'Capturing…' : 'Capture'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the Snapshots view adds to the top toolbar. */
export function HistoryToolbar(): React.ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <HistoryCompareBar />
    </div>
  );
}
