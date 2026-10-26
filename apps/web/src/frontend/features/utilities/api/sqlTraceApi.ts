/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL Tracer API: start a trace on a saved connection, read its events
 * since the last one seen, stop it.
 */
import type { TraceEvent, TraceMode } from '@foxschema/ui-shared';
import { api } from '@/shared/api/client';

export type TraceStopReason = 'stopped' | 'time' | 'events' | 'replaced' | 'error';

export interface TraceStatus {
  id: string;
  connectionId: string;
  mode: TraceMode;
  startedAt: string;
  endsAt: string;
  running: boolean;
  stopReason: TraceStopReason | null;
  error: string | null;
  eventCount: number;
}

export async function startTrace(connectionId: string, mode: TraceMode, password?: string): Promise<TraceStatus> {
  const { status } = await api.post<{ status: TraceStatus }>('/sql-trace/start', { connectionId, mode, password });
  return status;
}

export function traceEvents(id: string, after: number, signal?: AbortSignal) {
  return api.get<{ status: TraceStatus; events: TraceEvent[] }>(`/sql-trace/${encodeURIComponent(id)}/events`, {
    query: { after },
    signal,
    noStore: true,
  });
}

export async function stopTrace(id: string): Promise<TraceStatus> {
  const { status } = await api.post<{ status: TraceStatus }>(`/sql-trace/${encodeURIComponent(id)}/stop`);
  return status;
}
