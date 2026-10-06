/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (hooks/useDebugSamples.ts).
 */
import { useEffect, useState } from 'react';
import { isTerminalRunStatus, RUN_STREAM_END_EVENT } from '@foxschema/workflow-contract';
import { api, type RunEvent } from '../api/engineClient';
import { pipeKey } from '../lib/ports';

export type DebugSample = {
  pipelineId?: string;
  pipeId: string;
  direction: 'in' | 'out';
  port: string;
  batchId?: string;
  recordCount: number;
  records: Record<string, unknown>[];
  truncated: boolean;
  fromPipe?: string;
  fromPort?: string;
  at: string;
  seq: number;
};

function parseSample(event: RunEvent): DebugSample | null {
  if (event.type !== 'batch.sample' || !event.pipeId || !event.data) return null;
  const direction = event.data.direction;
  const port = event.data.port;
  if (direction !== 'in' && direction !== 'out') return null;
  if (typeof port !== 'string' || !port) return null;
  const records = Array.isArray(event.data.records)
    ? (event.data.records as Record<string, unknown>[])
    : [];
  return {
    pipelineId: event.pipelineId,
    pipeId: event.pipeId,
    direction,
    port,
    batchId:
      typeof event.data.batchId === 'string' ? event.data.batchId : undefined,
    recordCount:
      typeof event.data.recordCount === 'number'
        ? event.data.recordCount
        : records.length,
    records,
    truncated: event.data.truncated === true,
    fromPipe:
      typeof event.data.fromPipe === 'string' ? event.data.fromPipe : undefined,
    fromPort:
      typeof event.data.fromPort === 'string' ? event.data.fromPort : undefined,
    at: event.at,
    seq: event.seq,
  };
}


/** One human-readable log line per event, or null for events with no prose. */
function describeEvent(
  event: RunEvent,
): { at: string; text: string; level: DebugLogLine['level'] } | null {
  const status = typeof event.data?.status === 'string' ? event.data.status : '';
  const failed = status === 'failed' || status === 'cancelled';
  const level: DebugLogLine['level'] = failed
    ? 'error'
    : status === 'succeeded'
      ? 'success'
      : 'info';
  const where = event.pipeId
    ? `${event.pipelineId ?? '?'} / ${event.pipeId}`
    : (event.pipelineId ?? '');
  const suffix = event.message ? ` — ${event.message}` : '';

  switch (event.type) {
    case 'pipe.log':
      return {
        at: event.at,
        text: `${where} ${event.message ?? ''}`,
        level: event.data?.level === 'error' ? 'error' : 'info',
      };
    case 'run.status':
      return { at: event.at, text: `▸ run ${status}${suffix}`, level };
    case 'pipeline.status':
      return { at: event.at, text: `${where} pipeline ${status}${suffix}`, level };
    case 'pipe.status':
      return { at: event.at, text: `${where} ${status}${suffix}`, level };
    case 'batch.progress': {
      const records = Number(event.data?.records ?? 0);
      return {
        at: event.at,
        text: `${where} · ${records} record${records === 1 ? '' : 's'}`,
        level: 'info',
      };
    }
    case 'retry.attempt':
      return { at: event.at, text: `${where} retry${suffix}`, level: 'error' };
    case 'reject':
      return { at: event.at, text: `${where} rejected${suffix}`, level: 'error' };
    default:
      // batch.sample and anything new: carried in the Input/Output tabs, not
      // the log — one line per sampled port would drown the real events.
      return null;
  }
}

function sampleKey(sample: DebugSample): string {
  return sample.direction === 'in' && sample.fromPipe
    ? `${sample.pipeId}\0in\0${sample.fromPipe}\0${sample.port}`
    : `${sample.pipeId}\0${sample.direction}\0${sample.port}`;
}

/** Live per-pipe execution state, keyed by `pipeKey(pipelineId, pipeId)`. */
export interface DebugPipeState {
  status: string;
  processedBatches: number;
  processedRecords: number;
  error?: string;
}

/** One line for the execution log, newest last. */
export interface DebugLogLine {
  seq: number;
  at: string;
  text: string;
  level: 'info' | 'success' | 'error';
}

/**
 * Fold one run event into the live per-pipe state. Sources announce each
 * status with `pipe.status`; transforms and sinks report their finished batch
 * as `batch.progress` carrying `status: 'success'` and send no separate
 * `pipe.status` for it, so both have to be read for status.
 */
export function applyPipeEvent(
  current: Record<string, DebugPipeState>,
  key: string,
  event: RunEvent,
): Record<string, DebugPipeState> {
  const status = event.data?.status;
  const previous = current[key];
  if (event.type === 'pipe.status' && typeof status === 'string') {
    return {
      ...current,
      [key]: {
        ...previous,
        processedBatches: previous?.processedBatches ?? 0,
        processedRecords: previous?.processedRecords ?? 0,
        status,
        ...(event.message ? { error: event.message } : {}),
      },
    };
  }
  if (event.type === 'batch.progress') {
    const records = Number(event.data?.records ?? 0);
    return {
      ...current,
      [key]: {
        status: typeof status === 'string' ? status : (previous?.status ?? 'running'),
        processedBatches: (previous?.processedBatches ?? 0) + 1,
        processedRecords: (previous?.processedRecords ?? 0) + records,
        ...(previous?.error ? { error: previous.error } : {}),
      },
    };
  }
  return current;
}

/**
 * Live `batch.sample` events for a debug run. Latest sample wins per
 * (pipe, direction, port[, fromPipe]).
 */
export function useDebugSamples(runId: string | null): {
  samples: DebugSample[];
  status: string | null;
  error: string | null;
  /** Latest pipe error message keyed by `pipelineId::pipeId`. */
  pipeErrors: Record<string, string>;
  /** Live per-pipe status/counters, keyed by `pipelineId::pipeId`. */
  pipeStates: Record<string, DebugPipeState>;
  /** Chronological run log built from the event stream. */
  log: DebugLogLine[];
} {
  const [samples, setSamples] = useState<DebugSample[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipeErrors, setPipeErrors] = useState<Record<string, string>>({});
  const [pipeStates, setPipeStates] = useState<Record<string, DebugPipeState>>({});
  const [log, setLog] = useState<DebugLogLine[]>([]);

  useEffect(() => {
    if (!runId) {
      setSamples([]);
      setStatus(null);
      setError(null);
      setPipeErrors({});
      setPipeStates({});
      setLog([]);
      return;
    }
    // A new run starts from a clean slate — stale rows from the previous run
    // must not linger in the panel while this one is still starting.
    setPipeStates({});
    setLog([]);
    setSamples([]);

    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const byKey = new Map<string, DebugSample>();

    const seenLog = new Set<number>();

    const upsert = (event: RunEvent) => {
      if (event.type === 'run.status' && typeof event.data?.status === 'string') {
        setStatus(event.data.status);
      }
      // Live per-pipe state, so the execution panel tracks the run as it goes
      // rather than waiting for a detail refresh at the end.
      if (event.pipeId && event.pipelineId) {
        const key = pipeKey(event.pipelineId, event.pipeId);
        setPipeStates((current) => applyPipeEvent(current, key, event));
        if (
          event.type === 'pipe.status' &&
          event.data?.status === 'failed' &&
          event.message
        ) {
          setPipeErrors((current) => ({ ...current, [key]: event.message! }));
        }
      }

      if (!seenLog.has(event.seq)) {
        seenLog.add(event.seq);
        const line = describeEvent(event);
        if (line) setLog((current) => [...current, { ...line, seq: event.seq }]);
      }
      const sample = parseSample(event);
      if (!sample) return;
      const key = sampleKey(sample);
      const existing = byKey.get(key);
      if (!existing || sample.seq >= existing.seq) {
        byKey.set(key, sample);
        setSamples([...byKey.values()]);
      }
    };

    const refreshDetail = async () => {
      const detail = await api.getRun(runId);
      if (cancelled) return;
      setStatus(detail.status);
      setError(detail.error ?? null);
      const next: Record<string, string> = {};
      for (const pipe of detail.pipes) {
        if (pipe.error) {
          next[pipeKey(pipe.pipelineId, pipe.pipeId)] = pipe.error;
        }
      }
      setPipeErrors((current) => ({ ...current, ...next }));
      // The detail is authoritative for counters — reconcile the
      // event-derived state against it so totals always settle correctly.
      setPipeStates((current) => {
        const merged = { ...current };
        for (const pipe of detail.pipes) {
          merged[pipeKey(pipe.pipelineId, pipe.pipeId)] = {
            status: pipe.status,
            processedBatches: pipe.processedBatches,
            processedRecords: pipe.processedRecords,
            ...(pipe.error ? { error: pipe.error } : {}),
          };
        }
        return merged;
      });
      return detail.status;
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    /**
     * Stream first, from seq 0. Fetching history and *then* subscribing past
     * it loses every event emitted in between — and a run that finishes in
     * tens of milliseconds lands squarely in that gap, leaving the UI to wait
     * for the fallback poll. The stream replays from `after`, so subscribing
     * at 0 is both gapless and sufficient on its own.
     */
    source = api.streamRunEvents(runId, 0);
    source.onmessage = (message) => {
      if (cancelled) return;
      try {
        const event = JSON.parse(message.data) as RunEvent;
        upsert(event);
        // A terminal run.status is the real completion signal — refresh the
        // detail once for pipe errors and stop polling, rather than waiting
        // out another poll interval.
        if (
          event.type === 'run.status' &&
          typeof event.data?.status === 'string' &&
          isTerminalRunStatus(event.data.status)
        ) {
          stopPolling();
          void refreshDetail().catch(() => undefined);
        }
      } catch {
        // ignore malformed SSE frames
      }
    };
    source.onerror = () => {
      // The stream is best-effort; the poll below remains the safety net.
    };
    // The engine sends `end` once the run has finished and every event is out.
    // Left open, an EventSource would reconnect and replay the run from seq 0.
    source.addEventListener(RUN_STREAM_END_EVENT, () => source?.close());

    // Safety net only: covers a dropped stream or a run that reached a
    // terminal state before this effect ran.
    //
    // A failed request is swallowed on purpose: the API restarting (tsx watch
    // restarts it on every save) or a proxy 502 is expected, and the next tick
    // retries. Left unhandled, every tick raised an uncaught promise rejection —
    // about one a second, for as long as the run stayed open, which for a run
    // paused at a human gate is indefinitely.
    const poll = () =>
      refreshDetail().then(
        (runStatus) => {
          if (!cancelled && runStatus && isTerminalRunStatus(runStatus)) {
            stopPolling();
          }
        },
        () => undefined,
      );
    void poll();
    pollTimer = setInterval(() => void poll(), 1000);

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [runId]);

  return { samples, status, error, pipeErrors, pipeStates, log };
}

export function samplesForPipe(
  samples: DebugSample[],
  pipelineId: string,
  pipeId: string,
  direction: 'in' | 'out',
): DebugSample[] {
  return samples
    .filter(
      (sample) =>
        sample.pipeId === pipeId &&
        sample.direction === direction &&
        (!sample.pipelineId || sample.pipelineId === pipelineId),
    )
    .sort((a, b) => a.port.localeCompare(b.port) || a.seq - b.seq);
}
