/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine runs: a sortable list, and the selected run's timeline, failure
 * summary and events (optionally followed live).
 */
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RUN_STREAM_END_EVENT } from '@foxschema/workflow-contract';
import {
  api,
  type RunEvent,
  type RunDetail,
  type RunFailureSummary,
  type RunRecord,
} from '../api/engineClient';
import { Button } from './controls';

type SortKey = 'workflowId' | 'workflowVersion' | 'status' | 'trigger' | 'startedAt';

const COLUMNS: Array<{ header: string; sortKey?: SortKey; cell: (run: RunRecord) => ReactNode }> = [
  { header: 'Run', cell: (run) => <span className="mono">{run.id.slice(0, 8)}</span> },
  { header: 'Workflow', sortKey: 'workflowId', cell: (run) => run.workflowId },
  { header: 'Version', sortKey: 'workflowVersion', cell: (run) => `v${run.workflowVersion}` },
  {
    header: 'Status',
    sortKey: 'status',
    cell: (run) => <span className={`status-pill ${run.status}`}>{run.status}</span>,
  },
  { header: 'Trigger', sortKey: 'trigger', cell: (run) => run.trigger },
  { header: 'Started', sortKey: 'startedAt', cell: (run) => new Date(run.startedAt).toLocaleString() },
];

/** Newest events are what a reader is after; older ones stay a count. */
const EVENT_LOG_LIMIT = 1_000;

function EventLog({ events }: { events: RunEvent[] }) {
  const shown = events.length > EVENT_LOG_LIMIT ? events.slice(-EVENT_LOG_LIMIT) : events;
  return (
    <div className="event-log">
      {shown.length < events.length && (
        <div className="event-row">
          Showing the last {shown.length} of {events.length} events.
        </div>
      )}
      {shown.map((event) => {
        const failover =
          event.type === 'retry.attempt' && (event.data as { kind?: string } | undefined)?.kind === 'ai.failover';
        return (
          <div key={event.seq} className="event-row">
            <span className="mono">#{event.seq}</span> {failover ? 'ai.failover' : event.type}
            {event.pipelineId ? ` · ${event.pipelineId}` : ''}
            {event.pipeId ? `/${event.pipeId}` : ''}
            {event.message ? ` — ${event.message}` : ''}
          </div>
        );
      })}
    </div>
  );
}

function FailureSummaryCard({ summary }: { summary: RunFailureSummary }) {
  return (
    <div className="run-failure-summary">
      <h4>Failure summary</h4>
      {summary.workflowPurpose && (
        <p>
          Purpose: <strong>{summary.workflowPurpose}</strong>
        </p>
      )}
      {summary.error && <p className="field-error">{summary.error}</p>}
      {summary.failedPipeline && (
        <p>
          Pipeline <code>{summary.failedPipeline.pipelineId}</code>
          {summary.failedPipeline.task ? ` (${summary.failedPipeline.task})` : ''}
          {summary.failedPipeline.error ? ` — ${summary.failedPipeline.error}` : ''}
        </p>
      )}
      {summary.failedPipe && (
        <p>
          Pipe <code>{summary.failedPipe.pipeId}</code>
          {summary.failedPipe.intent ? ` — ${summary.failedPipe.intent}` : ''}
          {summary.failedPipe.type ? ` [${summary.failedPipe.type}]` : ''}
          {summary.failedPipe.error ? `: ${summary.failedPipe.error}` : ''}
        </p>
      )}
      {summary.gateSkipped.length > 0 && (
        <p>
          Gate skipped:{' '}
          {summary.gateSkipped.map((item) => `${item.pipelineId}${item.error ? ` (${item.error})` : ''}`).join(', ')}
        </p>
      )}
      {summary.aiFailovers.length > 0 && (
        <p>
          AI failovers:{' '}
          {summary.aiFailovers
            .map((item) => `${item.from ?? '?'} → ${item.to ?? '?'}${item.reason ? ` (${item.reason})` : ''}`)
            .join('; ')}
        </p>
      )}
      {summary.aiUsage && (
        <p>
          AI tokens: {summary.aiUsage.inputTokens} in / {summary.aiUsage.outputTokens} out
        </p>
      )}
    </div>
  );
}

export function RunsPanel({ runs, onRefresh }: { runs: RunRecord[]; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [failure, setFailure] = useState<RunFailureSummary | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'startedAt', desc: true });

  const sortedRuns = useMemo(() => {
    const direction = sort.desc ? -1 : 1;
    return [...runs].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      return order * direction;
    });
  }, [runs, sort]);

  // Clicking the sorted column flips it; another column starts ascending.
  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, desc: !current.desc } : { key, desc: false }));

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setFailure(null);
      setEvents([]);
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const [run, eventPage, failureSummary] = await Promise.all([
          api.getRun(selectedId),
          api.listRunEvents(selectedId),
          api.getRunFailure(selectedId),
        ]);
        if (cancelled) return;
        setDetail(run);
        setEvents(eventPage.events);
        setFailure(failureSummary);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !live) return;
    const source = api.streamRunEvents(selectedId, 0);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => (current.some((row) => row.seq === event.seq) ? current : [...current, event]));
      if (event.type === 'run.status') {
        void api.getRun(selectedId).then(setDetail).catch(() => undefined);
      }
    };
    source.onerror = () => setLive(false);
    // The engine sends `end` once the run has finished and every event is out.
    // Left open, an EventSource would reconnect and replay the run from seq 0.
    source.addEventListener(RUN_STREAM_END_EVENT, () => source.close());
    return () => source.close();
  }, [selectedId, live]);

  return (
    <div className="runs">
      <div className="mb-3 flex items-center gap-2.5">
        <h3 className="m-0">Runs</h3>
        <Button size="sm" onClick={onRefresh}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {runs.length === 0 ? (
        <div className="empty">No runs yet — open a workflow in the designer and press Test run.</div>
      ) : (
        <div className="runs-layout">
          <table>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.header}
                    onClick={column.sortKey ? () => toggleSort(column.sortKey!) : undefined}
                    className={column.sortKey ? 'cursor-pointer select-none' : ''}
                    aria-sort={
                      column.sortKey && sort.key === column.sortKey ? (sort.desc ? 'descending' : 'ascending') : undefined
                    }
                  >
                    <span className="inline-flex items-center gap-1">
                      {column.header}
                      {column.sortKey === sort.key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRuns.map((run) => (
                <tr
                  key={run.id}
                  className={selectedId === run.id ? 'selected' : undefined}
                  onClick={() => setSelectedId(run.id)}
                >
                  {COLUMNS.map((column) => (
                    <td key={column.header}>{column.cell(run)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {selectedId && (
            <aside className="run-detail">
              <div className="run-detail-header">
                <h3>Run {selectedId.slice(0, 8)}</h3>
                <label className="checkbox-row">
                  <input data-testid="workflow-runs-live" type="checkbox" checked={live} onChange={(ev) => setLive(ev.target.checked)} />
                  Live SSE
                </label>
              </div>
              {error && <div className="field-error">{error}</div>}
              {failure && <FailureSummaryCard summary={failure} />}
              {detail && (
                <>
                  <p>
                    Status <span className={`status-pill ${detail.status}`}>{detail.status}</span>
                    {detail.error ? ` — ${detail.error}` : ''}
                  </p>
                  <h4>Timeline</h4>
                  <ul>
                    {detail.pipelines.map((pipeline) => (
                      <li key={pipeline.id}>
                        pipeline/{pipeline.pipelineId}: {pipeline.status}
                        {pipeline.error ? ` (${pipeline.error})` : ''}
                      </li>
                    ))}
                    {detail.pipes.map((pipe) => (
                      <li key={pipe.id}>
                        pipe/{pipe.pipelineId}/{pipe.pipeId}: {pipe.status}
                        {pipe.processedBatches ? ` · ${pipe.processedBatches} batches` : ''}
                        {pipe.error ? ` (${pipe.error})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h4>Events</h4>
              {events.length === 0 ? <div className="empty">No events yet.</div> : <EventLog events={events} />}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
