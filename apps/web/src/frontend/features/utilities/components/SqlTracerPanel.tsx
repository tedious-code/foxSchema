/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → SQL Tracer: watch the statements on the workspace credential,
 * either as the engine lists them (Live) or as Fox runs them (Fox activity).
 *
 * A trace is time-boxed and capped on the server; this screen asks for new
 * events about once a second while it runs, and stops the trace when it
 * closes. Text arrives already redacted.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, FileCode2, Loader2, Play, Square } from 'lucide-react';
import { dialectSupportsDbaUtility, TRACE_MAX_EVENTS, type TraceEvent, type TraceMode } from '@foxschema/ui-shared';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { needsSessionPassword } from '@/shared/lib/provider-settings';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { startTrace, stopTrace, traceEvents, type TraceStatus } from '../api/sqlTraceApi';

interface Props {
  /** The Utilities workspace credential. */
  lockedConnectionId?: string;
}

const POLL_MS = 1000;

const STOP_REASON: Record<string, string> = {
  stopped: 'Stopped.',
  time: 'Stopped: a trace runs for at most 15 minutes.',
  events: `Stopped: a trace keeps at most ${TRACE_MAX_EVENTS.toLocaleString()} statements.`,
  replaced: 'Stopped: a newer trace on this connection replaced it.',
  error: 'Stopped after an error.',
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

function minutesLeft(endsAt: string, now: number): string {
  const ms = new Date(endsAt).getTime() - now;
  if (!(ms > 0)) return '0:00';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whether `event` matches the filter box: any of its text fields, case-blind. */
export function traceEventMatches(event: TraceEvent, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [event.text, event.user, event.database, event.client, event.sessionId, event.error]
    .some((field) => field?.toLowerCase().includes(needle));
}

export const SqlTracerPanel: React.FC<Props> = ({ lockedConnectionId }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const connectionId = lockedConnectionId || '';
  const conn = connections.find((c) => c.id === connectionId) || null;
  const liveSupport = useMemo(() => dialectSupportsDbaUtility(conn?.dialect || '', 'sessions'), [conn?.dialect]);

  const [mode, setMode] = useState<TraceMode>('fox');
  const [status, setStatus] = useState<TraceStatus | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());

  /** The trace this screen is reading; a reply about any other is dropped. */
  const traceId = useRef<string | null>(null);
  const lastSeq = useRef(0);

  const needsPassword = Boolean(conn && needsSessionPassword(conn, sessionPasswords[connectionId]));
  const running = Boolean(status?.running);

  // Live is not on offer where the engine has no session list.
  useEffect(() => {
    if (!liveSupport.query && mode === 'live') setMode('fox');
  }, [liveSupport.query, mode]);

  // A new credential is a new subject: drop what the old trace showed.
  useEffect(() => {
    const id = traceId.current;
    traceId.current = null;
    if (id) void stopTrace(id).catch(() => undefined);
    setStatus(null);
    setEvents([]);
    setSelected(null);
    setError(null);
    lastSeq.current = 0;
  }, [connectionId]);

  // Leaving the screen ends the trace: nobody is watching it any more.
  useEffect(
    () => () => {
      const id = traceId.current;
      traceId.current = null;
      if (id) void stopTrace(id).catch(() => undefined);
    },
    []
  );

  // Poll while the trace runs. One request at a time; the next is scheduled
  // only after the last answered, so a slow engine is never asked twice.
  useEffect(() => {
    const id = status?.id;
    if (!id || !status?.running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const page = await traceEvents(id, lastSeq.current, controller.signal);
        if (traceId.current !== id) return;
        if (page.events.length > 0) {
          lastSeq.current = page.events[page.events.length - 1]!.seq;
          setEvents((cur) => [...cur, ...page.events].slice(-TRACE_MAX_EVENTS));
        }
        setStatus(page.status);
        setNow(Date.now());
        if (page.status.running) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (err) {
        if (controller.signal.aborted || traceId.current !== id) return;
        setError(errorText(err));
        timer = setTimeout(() => void tick(), POLL_MS * 3);
      }
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // Restart only for a different trace, or when one stops: the status object changes every tick.
  }, [status?.id, status?.running]);

  const start = useCallback(async () => {
    if (!connectionId) return;
    setStarting(true);
    setError(null);
    try {
      const next = await startTrace(connectionId, mode, sessionPasswords[connectionId] || undefined);
      traceId.current = next.id;
      lastSeq.current = 0;
      setEvents([]);
      setSelected(null);
      setStatus(next);
      setNow(Date.now());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  }, [connectionId, mode, sessionPasswords]);

  const stop = useCallback(async () => {
    const id = traceId.current;
    if (!id) return;
    try {
      const next = await stopTrace(id);
      if (traceId.current === id) setStatus(next);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const unlock = () => {
    if (!connectionId || !passwordDraft.trim()) return;
    ensureConnectionSelected(connectionId);
    submitSessionPassword(passwordDraft.trim());
    setPasswordDraft('');
  };

  const shown = useMemo(() => events.filter((e) => traceEventMatches(e, filter)), [events, filter]);
  const detail = selected === null ? null : events.find((e) => e.seq === selected) ?? null;

  const openInEditor = (text: string) => {
    if (!connectionId) return;
    setSql(text);
    ensureConnectionSelected(connectionId);
    setActiveView('sqlEditor');
  };

  const statusLine = !status
    ? mode === 'live'
      ? 'Live reads the engine’s session list once a second: statements show while they run.'
      : 'Fox activity shows each statement anyone runs on this connection from Fox, as it finishes.'
    : status.running
      ? `Tracing · ${status.eventCount.toLocaleString()} statements · ${minutesLeft(status.endsAt, now)} left`
      : STOP_REASON[status.stopReason ?? 'stopped'] ?? 'Stopped.';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-900" data-testid="sql-tracer-panel">
      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-slate-800 bg-slate-950/30 px-5 py-3">
        <label className="flex flex-col gap-1">
          <span className={sectionLabelCls}>Mode</span>
          <select
            data-testid="sql-tracer-mode"
            value={mode}
            disabled={running}
            onChange={(e) => setMode(e.target.value as TraceMode)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus disabled:opacity-60"
          >
            <option value="fox">Fox activity</option>
            <option value="live" disabled={!liveSupport.query}>
              Live (engine sessions){liveSupport.query ? '' : ' — not on this engine'}
            </option>
          </select>
        </label>
        {needsPassword && (
          <label className="flex flex-col gap-1">
            <span className={sectionLabelCls}>Session password</span>
            <div className="flex gap-1">
              <input
                data-testid="sql-tracer-password-draft"
                type="password"
                value={passwordDraft}
                onChange={(e) => setPasswordDraft(e.target.value)}
                placeholder="••••••••"
                className="w-36 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-sm text-slate-100 outline-none accent-focus"
              />
              <button
                data-testid="sql-tracer-unlock"
                type="button"
                onClick={unlock}
                className="rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-xs font-bold text-amber-100"
              >
                Unlock
              </button>
            </div>
          </label>
        )}
        {running ? (
          <button
            type="button"
            data-testid="sql-tracer-stop"
            onClick={() => void stop()}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-100 hover:bg-rose-500/25"
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        ) : (
          <button
            type="button"
            data-testid="sql-tracer-start"
            disabled={starting || !connectionId || (mode === 'live' && needsPassword)}
            onClick={() => void start()}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Start
          </button>
        )}
        <label className="ml-auto flex min-w-[12rem] flex-col gap-1">
          <span className={sectionLabelCls}>Filter</span>
          <input
            data-testid="sql-tracer-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Text, user, client…"
            className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus"
          />
        </label>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-5 py-1.5 text-[11px] text-slate-400" data-testid="sql-tracer-status">
        {running && <Circle className="h-2.5 w-2.5 animate-pulse fill-rose-400 text-rose-400" aria-hidden />}
        <span>{statusLine}</span>
        {filter.trim() && events.length > 0 && (
          <span className="text-slate-500">· showing {shown.length.toLocaleString()} of {events.length.toLocaleString()}</span>
        )}
      </div>
      {mode === 'live' && !liveSupport.query && liveSupport.hint && (
        <p className="px-5 py-1.5 text-[11px] text-slate-500">{liveSupport.hint}</p>
      )}
      {(error || status?.error) && (
        <p data-testid="sql-tracer-error" className="border-b border-slate-800 bg-rose-500/10 px-5 py-1.5 text-[11px] text-rose-200">
          {error || status?.error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {shown.length === 0 ? (
            <p data-testid="sql-tracer-empty" className="px-5 py-6 text-[12px] text-slate-500">
              {status ? (filter.trim() && events.length ? 'No statement matches the filter.' : 'No statements yet.') : 'Start a trace to see statements here.'}
            </p>
          ) : (
            <table className="w-full border-collapse text-left text-[12px]">
              <thead className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 font-bold">Time</th>
                  <th className="px-3 py-1.5 font-bold">ms</th>
                  <th className="px-3 py-1.5 font-bold">User</th>
                  <th className="px-3 py-1.5 font-bold">Client</th>
                  <th className="px-3 py-1.5 font-bold">Rows</th>
                  <th className="w-full px-3 py-1.5 font-bold">Statement</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr
                    key={e.seq}
                    data-testid={`sql-tracer-row-${e.seq}`}
                    aria-selected={e.seq === selected}
                    onClick={() => setSelected(e.seq)}
                    className={`cursor-pointer border-b border-slate-800/70 ${
                      e.seq === selected ? 'bg-slate-800' : 'hover:bg-slate-800/50'
                    } ${e.error ? 'text-rose-200' : 'text-slate-200'}`}
                  >
                    <td className="whitespace-nowrap px-3 py-1 font-mono text-slate-400">{clock(e.at)}</td>
                    <td className="whitespace-nowrap px-3 py-1 text-right font-mono tabular-nums">{e.durationMs ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1">{e.user ?? '—'}</td>
                    <td className="max-w-[10rem] truncate whitespace-nowrap px-3 py-1" title={e.client ?? ''}>{e.client ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1 text-right font-mono tabular-nums">{e.rows ?? '—'}</td>
                    <td className="max-w-0 truncate px-3 py-1 font-mono" title={e.text}>{e.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {detail && (
          <aside data-testid="sql-tracer-detail" className="flex w-96 shrink-0 flex-col gap-2 overflow-auto border-l border-slate-800 bg-slate-950 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className={sectionLabelCls}>
                {detail.source === 'live' ? `Session ${detail.sessionId ?? '—'}` : 'Fox'} · {clock(detail.at)}
              </span>
              <button
                type="button"
                data-testid="sql-tracer-open-editor"
                onClick={() => openInEditor(detail.text)}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-bold text-amber-100 hover:bg-amber-500/25"
              >
                <FileCode2 className="h-3.5 w-3.5" /> Open in editor
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
              <dt className="text-slate-500">User</dt><dd className="text-slate-200">{detail.user ?? '—'}</dd>
              <dt className="text-slate-500">Database</dt><dd className="text-slate-200">{detail.database ?? '—'}</dd>
              <dt className="text-slate-500">Client</dt><dd className="text-slate-200">{detail.client ?? '—'}</dd>
              {detail.state && (<><dt className="text-slate-500">State</dt><dd className="text-slate-200">{detail.state}</dd></>)}
            </dl>
            <pre data-testid="sql-tracer-detail-text" className="whitespace-pre-wrap break-words rounded-md border border-slate-800 bg-slate-900 p-2 font-mono text-[12px] text-slate-100">
              {detail.text}
            </pre>
            {detail.error && (
              <p className="rounded-md bg-rose-500/10 p-2 text-[11px] text-rose-200">{detail.error}</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};
