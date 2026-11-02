/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Tracer sessions: what one person is watching on one saved connection.
 *
 * Two modes:
 *
 * - `live` reads the engine's own session list (the Server Insights sessions
 *   probe) whenever the watcher asks for new events, at most once a second.
 *   A statement becomes an event the first time it is seen on a session, and
 *   again only after it has gone and come back.
 * - `fox` listens to the statements Fox itself runs on that connection, from
 *   the SQL editor, as they finish.
 *
 * Every trace stops itself after TRACE_MAX_MS or TRACE_MAX_EVENTS, and text is
 * redacted before it is kept. Nothing here logs statement text: a trace shows
 * other people's SQL, and the log is not the place for it.
 */
import { randomUUID } from 'node:crypto';
import {
  buildDbaUtilityQuery,
  traceText,
  TRACE_MAX_EVENTS,
  TRACE_MAX_MS,
  type TraceEvent,
  type TraceMode,
  type UserSessionRow,
} from '@foxschema/sql';
import { ServiceError } from '../../platform/contracts/actor';
import type { SqlActivity, SqlActivityFeed } from '../../platform/sql-activity/sql-activity';

/** Why a trace ended. */
export type TraceStopReason = 'stopped' | 'time' | 'events' | 'replaced' | 'error';

export interface TraceStatus {
  id: string;
  connectionId: string;
  mode: TraceMode;
  startedAt: string;
  endsAt: string;
  running: boolean;
  stopReason: TraceStopReason | null;
  /** The probe's last error (live), so the screen can say why nothing arrives. */
  error: string | null;
  eventCount: number;
}

export interface TraceEventsPage {
  status: TraceStatus;
  events: TraceEvent[];
}

/** The resolved connection a live trace polls: held in memory for the trace only. */
export interface LiveTarget {
  dialect: string;
  option: Record<string, unknown>;
}

export type ProbeSessions = (
  target: LiveTarget
) => Promise<{ ok: true; sessions: UserSessionRow[] } | { ok: false; error: string }>;

export interface SqlTraceDeps {
  activity: SqlActivityFeed;
  probeSessions: ProbeSessions;
  now?: () => number;
}

/** No more often than this, however often the screen asks. */
export const LIVE_POLL_MIN_MS = 1000;
/** A stopped trace can still be read for this long, then it is gone. */
export const STOPPED_TRACE_KEEP_MS = 10 * 60 * 1000;
/** Open traces per person, across connections. */
export const MAX_TRACES_PER_OWNER = 3;

const ACTIVE_STATE = /active|running|executing|query/i;

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();

class TraceSession {
  readonly events: TraceEvent[] = [];
  running = true;
  stopReason: TraceStopReason | null = null;
  stoppedAt: number | null = null;
  error: string | null = null;
  lastPollAt = 0;
  polling: Promise<void> | null = null;
  /** Statements on screen at the last poll, `sessionId \0 text`. */
  previous: Set<string> | null = null;
  unlisten: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly ownerId: string,
    readonly workspaceId: string,
    readonly connectionId: string,
    readonly mode: TraceMode,
    readonly startedAt: number,
    /** Live only; dropped when the trace stops so the credentials go with it. */
    public target: LiveTarget | null,
    readonly probeText: string | null
  ) {}

  get endsAt(): number {
    return this.startedAt + TRACE_MAX_MS;
  }
}

export class SqlTraceService {
  private readonly traces = new Map<string, TraceSession>();
  private readonly now: () => number;

  constructor(private readonly deps: SqlTraceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start watching `connectionId`. A trace the same person already has on that
   * connection is stopped first: one trace per person per connection.
   */
  start(ownerId: string, workspaceId: string, connectionId: string, mode: TraceMode, target: LiveTarget | null): TraceStatus {
    this.sweep();
    for (const trace of this.traces.values()) {
      if (
        trace.ownerId === ownerId &&
        trace.workspaceId === workspaceId &&
        trace.connectionId === connectionId &&
        trace.running
      ) {
        this.stopTrace(trace, 'replaced');
      }
    }
    const open = [...this.traces.values()].filter((t) => t.ownerId === ownerId && t.running).length;
    if (open >= MAX_TRACES_PER_OWNER) {
      throw new ServiceError('conflict', `At most ${MAX_TRACES_PER_OWNER} traces can run at once. Stop one first.`);
    }

    let probeText: string | null = null;
    if (mode === 'live') {
      if (!target) throw new ServiceError('invalid_input', 'A live trace needs the connection.');
      const built = buildDbaUtilityQuery({ dialect: target.dialect, kind: 'sessions' });
      if ('error' in built) throw new ServiceError('invalid_input', built.error);
      probeText = normalize(built.sql);
    }

    const trace = new TraceSession(
      randomUUID(),
      ownerId,
      workspaceId,
      connectionId,
      mode,
      this.now(),
      mode === 'live' ? target : null,
      probeText
    );
    if (mode === 'fox') {
      trace.unlisten = this.deps.activity.listen(connectionId, (activity) => this.recordFox(trace, activity));
    }
    this.traces.set(trace.id, trace);
    return this.status(trace);
  }

  /** Events after `after`, polling the engine first on a live trace. */
  async events(ownerId: string, workspaceId: string, id: string, after: number): Promise<TraceEventsPage> {
    const trace = this.owned(ownerId, workspaceId, id);
    this.expire(trace);
    if (trace.running && trace.mode === 'live') await this.poll(trace);
    const events = trace.events.filter((event) => event.seq > after);
    return { status: this.status(trace), events };
  }

  stop(ownerId: string, workspaceId: string, id: string): TraceStatus {
    const trace = this.owned(ownerId, workspaceId, id);
    if (trace.running) this.stopTrace(trace, 'stopped');
    return this.status(trace);
  }

  /** Stop every trace — at shutdown, or in a test. */
  stopAll(): void {
    for (const trace of this.traces.values()) if (trace.running) this.stopTrace(trace, 'stopped');
  }

  private owned(ownerId: string, workspaceId: string, id: string): TraceSession {
    this.sweep();
    const trace = this.traces.get(id);
    // Someone else's trace answers as missing: its id says nothing.
    if (!trace || trace.ownerId !== ownerId || trace.workspaceId !== workspaceId) {
      throw new ServiceError('not_found', 'Trace not found');
    }
    return trace;
  }

  private status(trace: TraceSession): TraceStatus {
    return {
      id: trace.id,
      connectionId: trace.connectionId,
      mode: trace.mode,
      startedAt: new Date(trace.startedAt).toISOString(),
      endsAt: new Date(trace.endsAt).toISOString(),
      running: trace.running,
      stopReason: trace.stopReason,
      error: trace.error,
      eventCount: trace.events.length,
    };
  }

  private stopTrace(trace: TraceSession, reason: TraceStopReason): void {
    trace.running = false;
    trace.stopReason = reason;
    trace.stoppedAt = this.now();
    trace.unlisten?.();
    trace.unlisten = null;
    trace.target = null;
    trace.previous = null;
  }

  /** Stop a trace past its time box. Checked on every touch, so no timer runs. */
  private expire(trace: TraceSession): boolean {
    if (trace.running && this.now() >= trace.endsAt) this.stopTrace(trace, 'time');
    return !trace.running;
  }

  /** Expire running traces and forget stopped ones past STOPPED_TRACE_KEEP_MS. */
  private sweep(): void {
    const now = this.now();
    for (const [id, trace] of this.traces) {
      this.expire(trace);
      if (!trace.running && trace.stoppedAt !== null && now - trace.stoppedAt >= STOPPED_TRACE_KEEP_MS) {
        this.traces.delete(id);
      }
    }
  }

  /** Add an event; a trace that reaches TRACE_MAX_EVENTS stops itself. */
  private push(trace: TraceSession, event: Omit<TraceEvent, 'seq'>): void {
    trace.events.push({ seq: trace.events.length + 1, ...event });
    if (trace.events.length >= TRACE_MAX_EVENTS) this.stopTrace(trace, 'events');
  }

  private recordFox(trace: TraceSession, activity: SqlActivity): void {
    if (this.expire(trace)) return;
    this.push(trace, {
      at: activity.at.toISOString(),
      durationMs: activity.durationMs,
      user: activity.user,
      database: activity.database,
      client: 'Fox',
      sessionId: null,
      rows: activity.rows,
      text: traceText(activity.text),
      // An error can quote the statement back ("syntax error at or near …").
      error: activity.error === null ? null : traceText(activity.error),
      state: null,
      source: 'fox',
    });
  }

  /** One read of the engine's sessions, shared by callers that arrive while it runs. */
  private poll(trace: TraceSession): Promise<void> {
    if (trace.polling) return trace.polling;
    if (this.now() - trace.lastPollAt < LIVE_POLL_MIN_MS) return Promise.resolve();
    trace.polling = this.pollOnce(trace).finally(() => {
      trace.polling = null;
    });
    return trace.polling;
  }

  private async pollOnce(trace: TraceSession): Promise<void> {
    const target = trace.target;
    if (!target) return;
    trace.lastPollAt = this.now();
    let probed: Awaited<ReturnType<ProbeSessions>>;
    try {
      probed = await this.deps.probeSessions(target);
    } catch (error: unknown) {
      probed = { ok: false, error: error instanceof Error ? error.message : 'Session probe failed' };
    }
    if (!trace.running) return;
    if (!probed.ok) {
      trace.error = probed.error;
      return;
    }
    trace.error = null;

    const seenAt = new Date(this.now()).toISOString();
    const baseline = trace.previous === null;
    const current = new Set<string>();
    for (const row of probed.sessions) {
      const text = row.queryText?.trim();
      // Fox's own probe shows up as a running session; it is not what anyone is tracing.
      if (!text || normalize(text) === trace.probeText) continue;
      const key = `${row.sessionId}\u0000${text}`;
      current.add(key);
      if (trace.previous?.has(key)) continue;
      // At the first read, a session's last statement may have run long ago:
      // only the ones running now are news.
      if (baseline && !ACTIVE_STATE.test(row.state ?? '')) continue;
      this.push(trace, {
        at: seenAt,
        durationMs: null,
        user: row.userName,
        database: row.databaseName,
        client: row.applicationName || row.clientHost,
        sessionId: row.sessionId,
        rows: null,
        text: traceText(text),
        error: null,
        state: row.state,
        source: 'live',
      });
      if (!trace.running) return;
    }
    trace.previous = current;
  }
}
