/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A run's events as a readable log: time, level, where, what happened, and
 * the data behind it on demand. Shared by Runs and a workflow's Logs.
 */
import type { RunEvent } from '../api/engineClient';
import { eventKind, eventLevel, eventScope, eventSummary, eventTime, hasDetail, isProblem } from '../lib/runLog';

/** Newest events are what a reader is after; older ones stay a count. */
const EVENT_LOG_LIMIT = 1_000;

export function EventLog({
  events,
  problemsOnly,
  testId = 'workflow-runs-event-log',
}: {
  events: RunEvent[];
  problemsOnly: boolean;
  testId?: string;
}) {
  const relevant = problemsOnly ? events.filter(isProblem) : events;
  const shown = relevant.length > EVENT_LOG_LIMIT ? relevant.slice(-EVENT_LOG_LIMIT) : relevant;
  if (shown.length === 0) {
    return <div className="empty">{problemsOnly ? 'No errors or warnings in this run.' : 'No events yet.'}</div>;
  }
  return (
    <div className="event-log" data-testid={testId}>
      {shown.length < relevant.length && (
        <div className="event-row">
          Showing the last {shown.length} of {relevant.length} events.
        </div>
      )}
      {shown.map((event) => {
        const level = eventLevel(event);
        const scope = eventScope(event);
        const summary = eventSummary(event);
        const line = (
          <>
            <span className="event-seq">#{event.seq}</span>
            <span className="event-time">{eventTime(event.at)}</span>
            <span className={`event-level ${level}`}>{level}</span>
            <span className="event-kind">{eventKind(event)}</span>
            {scope && <span className="event-scope">{scope}</span>}
            {summary && <span className="event-summary">{summary}</span>}
          </>
        );
        return hasDetail(event) ? (
          <details key={event.seq} className={`event-row ${level}`}>
            <summary>{line}</summary>
            <pre className="event-data">{JSON.stringify(event.data, null, 2)}</pre>
          </details>
        ) : (
          <div key={event.seq} className={`event-row ${level}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
