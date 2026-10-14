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
import { Button, Input } from './controls';

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
  // Which run `events` belongs to, and the seq the live stream should follow.
  // Both are set together when that run's history arrives. Reading a ref
  // updated in an effect instead subscribed the new run at the previous one's
  // seq — and, if Live was already on, before this run's history had loaded.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [streamAfter, setStreamAfter] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
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
      setLoadedFor(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoadedFor(null);
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
        setStreamAfter(eventPage.events.at(-1)?.seq ?? 0);
        setLoadedFor(selectedId);
        setFailure(failureSummary);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, reloadTick]);

  useEffect(() => {
    if (!selectedId || !live || loadedFor !== selectedId) return;
    // Streaming from seq 0 sent every event a second time — sample payloads
    // included — and checked each against the whole list, O(n²) for a long run.
    const source = api.streamRunEvents(selectedId, streamAfter);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      // Events arrive in seq order, so one comparison drops a repeat.
      setEvents((current) => (event.seq > (current.at(-1)?.seq ?? 0) ? [...current, event] : current));
      if (event.type === 'run.status') {
        void api.getRun(selectedId).then(setDetail).catch(() => undefined);
      }
    };
    source.onerror = () => setLive(false);
    // The engine sends `end` once the run has finished and every event is out.
    // Left open, an EventSource would reconnect and replay the run from seq 0.
    source.addEventListener(RUN_STREAM_END_EVENT, () => source.close());
    return () => source.close();
  }, [selectedId, live, loadedFor, streamAfter]);

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
                  <RunSteering
                    runId={selectedId}
                    status={detail.status}
                    onChanged={() => setReloadTick((n) => n + 1)}
                  />
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

type PendingQuestion = {
  key: string;
  prompt: string;
  fields: Array<{ key: string; label: string; type: string; optional?: boolean; help?: string }>;
};

/** Cancel a live run, or answer a paused human gate and let it continue. */
function RunSteering({
  runId,
  status,
  onChanged,
}: {
  runId: string;
  status: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingQuestion[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (status !== 'paused') {
      setPending(null);
      return;
    }
    let cancel = false;
    void api
      .getRunInputs(runId)
      .then((page) => {
        if (!cancel) setPending(page.pending);
      })
      .catch((err: unknown) => {
        if (!cancel) setNote(err instanceof Error ? err.message : 'The waiting question could not be loaded.');
      });
    return () => {
      cancel = true;
    };
  }, [runId, status]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'The run could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const question = pending?.[0];
  const live = status === 'queued' || status === 'running';
  if (!live && status !== 'paused') return null;

  return (
    <div className="run-steering">
      {live && (
        <Button variant="danger" size="sm" disabled={busy} data-testid="workflow-run-cancel" onClick={() => void act(() => api.cancelRun(runId))}>
          Cancel run
        </Button>
      )}
      {status === 'paused' && question && (
        <form
          className="run-answer"
          onSubmit={(ev) => {
            ev.preventDefault();
            const parsed: Record<string, unknown> = {};
            for (const field of question.fields) {
              const raw = values[field.key] ?? '';
              if (field.type === 'boolean') parsed[field.key] = raw === 'true';
              else if (field.type === 'number' && raw !== '') parsed[field.key] = Number(raw);
              else parsed[field.key] = raw;
            }
            void act(() => api.answerRunInput(runId, { key: question.key, values: parsed }));
          }}
        >
          <p>{question.prompt}</p>
          {question.fields.map((field) => (
            <label key={field.key} className="field">
              <span>{field.label}</span>
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={values[field.key] === 'true'}
                  onChange={(ev) => setValues((current) => ({ ...current, [field.key]: ev.target.checked ? 'true' : 'false' }))}
                />
              ) : (
                <Input
                  type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  value={values[field.key] ?? ''}
                  required={!field.optional}
                  onChange={(ev) => setValues((current) => ({ ...current, [field.key]: ev.target.value }))}
                />
              )}
              {field.help && <span className="hint">{field.help}</span>}
            </label>
          ))}
          <Button type="submit" variant="primary" size="sm" disabled={busy} data-testid="workflow-run-answer">
            Send answer
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} data-testid="workflow-run-resume" onClick={() => void act(() => api.resumeRun(runId))}>
            Resume
          </Button>
        </form>
      )}
      {note && <div className="field-error">{note}</div>}
    </div>
  );
}
