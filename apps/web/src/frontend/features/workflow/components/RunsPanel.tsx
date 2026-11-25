/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine runs: a sortable, filterable list, and the selected run's timeline,
 * failure summary and event log (optionally followed live), which a user can
 * narrow to problems and download.
 */
import { ArrowDown, ArrowUp, Download, FolderOpen, Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RUN_STREAM_END_EVENT } from '@foxschema/shared';
import { useAuthStore } from '@/platform/authStore';
import {
  api,
  type RunEvent,
  type RunDetail,
  type RunFailureSummary,
  type RunRecord,
} from '../api/engineClient';
import { downloadFile, formatDuration, runDuration, runLogText } from '../lib/runLog';
import { Button, Input, Select } from './controls';
import { EventLog } from './EventLog';

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
  { header: 'Duration', cell: (run) => <span className="mono">{formatDuration(runDuration(run))}</span> },
  {
    header: 'Error',
    cell: (run) =>
      run.error ? (
        <span className="run-error-cell" title={run.error}>
          {run.error}
        </span>
      ) : null,
  },
];

/** Matches the stylesheet's breakpoint where the run detail drops under the list. */
const STACKED_LAYOUT = '(max-width: 960px)';

const STATUS_FILTERS = ['all', 'failed', 'succeeded', 'running', 'queued', 'paused', 'cancelled', 'interrupted'] as const;

function FailureSummaryCard({ summary }: { summary: RunFailureSummary }) {
  const failedPipelines = summary.failedPipelines ?? (summary.failedPipeline ? [summary.failedPipeline] : []);
  const failedPipes = summary.failedPipes ?? (summary.failedPipe ? [summary.failedPipe] : []);
  return (
    <div className="run-failure-summary">
      <h4>{summary.status === 'failed' ? 'Failure summary' : 'Summary'}</h4>
      {summary.workflowPurpose && (
        <p>
          Purpose: <strong>{summary.workflowPurpose}</strong>
        </p>
      )}
      {summary.error && <p className="field-error">{summary.error}</p>}
      {failedPipelines.map((fp) => (
        <p key={fp.id}>
          Pipeline <code>{fp.pipelineId}</code>
          {fp.task ? ` (${fp.task})` : ''}
          {fp.error ? ` — ${fp.error}` : ''}
        </p>
      ))}
      {failedPipes.map((fp) => (
        <p key={fp.id}>
          Pipe <code>{fp.name || fp.pipeId}</code>
          {fp.intent ? ` — ${fp.intent}` : ''}
          {fp.type ? ` [${fp.type}]` : ''}
          {fp.error ? `: ${fp.error}` : ''}
        </p>
      ))}
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

export function RunsPanel({
  runs,
  onRefresh,
  onOpenWorkflow,
}: {
  runs: RunRecord[];
  onRefresh: () => void;
  onOpenWorkflow?: (workflowId: string) => void;
}) {
  const canRun = useAuthStore((s) => s.can('workflow.run'));
  const [rerunning, setRerunning] = useState(false);
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
  const [workflowFilter, setWorkflowFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const detailRef = useRef<HTMLElement>(null);

  const workflowIds = useMemo(() => [...new Set(runs.map((run) => run.workflowId))].sort(), [runs]);

  const sortedRuns = useMemo(() => {
    const direction = sort.desc ? -1 : 1;
    const filtered = runs.filter(
      (run) =>
        (workflowFilter === 'all' || run.workflowId === workflowFilter) &&
        (statusFilter === 'all' || run.status === statusFilter),
    );
    return filtered.sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      return order * direction;
    });
  }, [runs, sort, workflowFilter, statusFilter]);

  // Side by side the detail sticks in view; stacked under the table on a
  // narrow screen it was below the fold, and picking a run seemed to do nothing.
  // Only when stacked: side by side, scrolling would push the filters away.
  useEffect(() => {
    if (!selectedId || !window.matchMedia?.(STACKED_LAYOUT).matches) return;
    detailRef.current?.scrollIntoView?.({ block: 'start' });
  }, [selectedId]);

  const download = (format: 'text' | 'json') => {
    if (!detail || !selectedId) return;
    const stem = `${detail.workflowId}-run-${selectedId.slice(0, 8)}`;
    if (format === 'text') downloadFile(`${stem}.log`, runLogText(detail, events), 'text/plain');
    else downloadFile(`${stem}.json`, JSON.stringify({ run: detail, failure, events }, null, 2), 'application/json');
  };

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
        void api.getRunFailure(selectedId).then(setFailure).catch(() => undefined);
      }
    };
    source.onerror = () => setLive(false);
    // The engine sends `end` once the run has finished and every event is out.
    // Left open, an EventSource would reconnect and replay the run from seq 0.
    source.addEventListener(RUN_STREAM_END_EVENT, () => {
      source.close();
      setLive(false);
    });
    return () => source.close();
  }, [selectedId, live, loadedFor, streamAfter]);

  return (
    <div className="runs">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h3 className="m-0">Runs</h3>
        <Button
          size="sm"
          onClick={() => {
            onRefresh();
            if (selectedId) setReloadTick((n) => n + 1);
          }}
        >
          <RefreshCw />
          Refresh
        </Button>
        <label className="runs-filter">
          Workflow
          <Select
            data-testid="workflow-runs-filter-workflow"
            value={workflowFilter}
            onChange={(ev) => setWorkflowFilter(ev.target.value)}
          >
            <option value="all">All workflows</option>
            {workflowIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </label>
        <label className="runs-filter">
          Status
          <Select
            data-testid="workflow-runs-filter-status"
            value={statusFilter}
            onChange={(ev) => setStatusFilter(ev.target.value as (typeof STATUS_FILTERS)[number])}
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : status}
              </option>
            ))}
          </Select>
        </label>
        <span className="runs-count">
          {sortedRuns.length === runs.length ? `${runs.length} runs` : `${sortedRuns.length} of ${runs.length} runs`}
        </span>
      </div>
      {runs.length === 0 ? (
        <div className="empty">No runs yet — open a workflow in the designer and press Test run.</div>
      ) : (
        <div className="runs-layout">
          <div className="runs-table-wrap">
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
          </div>

          {selectedId && (
            <aside className="run-detail" ref={detailRef} data-testid="workflow-runs-detail">
              <div className="run-detail-header">
                <h3>Run {selectedId.slice(0, 8)}</h3>
                <div className="run-detail-header-actions">
                  {detail && onOpenWorkflow && (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="workflow-run-open-workflow"
                      onClick={() => onOpenWorkflow(detail.workflowId)}
                      title="Open this workflow in Designer"
                    >
                      <FolderOpen />
                      Open workflow
                    </Button>
                  )}
                  {detail && detail.status !== 'queued' && detail.status !== 'running' && detail.status !== 'paused' && (
                    <Button
                      size="sm"
                      data-testid="workflow-run-rerun"
                      disabled={!canRun || rerunning}
                      title={canRun ? 'Run this workflow again with debug capture' : 'Requires the workflow run permission'}
                      onClick={async () => {
                        setRerunning(true);
                        setError(null);
                        try {
                          const res = await api.run(detail.workflowId, { debug: detail.debug ?? true });
                          if (res.runId) {
                            onRefresh();
                            setSelectedId(res.runId);
                          } else if (res.accepted === false) {
                            setError(res.detail ?? res.reason ?? 'The engine declined to re-run this workflow.');
                          }
                        } catch (err) {
                          setError((err as Error).message);
                        } finally {
                          setRerunning(false);
                        }
                      }}
                    >
                      <Play />
                      Re-run
                    </Button>
                  )}
                  <label className="checkbox-row">
                    <input data-testid="workflow-runs-live" type="checkbox" checked={live} onChange={(ev) => setLive(ev.target.checked)} />
                    Live SSE
                  </label>
                </div>
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
                  <p className="run-meta">
                    {detail.workflowId} v{detail.workflowVersion} · {detail.trigger} · started{' '}
                    {new Date(detail.startedAt).toLocaleString()}
                    {detail.finishedAt ? ` · took ${formatDuration(runDuration(detail))}` : ''}
                  </p>
                  <h4>Timeline</h4>
                  <ul className="run-timeline">
                    {detail.pipelines.map((pipeline) => (
                      <li key={pipeline.id} className={`timeline-${pipeline.status}`}>
                        pipeline/{pipeline.pipelineId}: {pipeline.status}
                        {pipeline.error ? ` (${pipeline.error})` : ''}
                      </li>
                    ))}
                    {detail.pipes.map((pipe) => (
                      <li key={pipe.id} className={`timeline-${pipe.status}`}>
                        pipe/{pipe.pipelineId}/{pipe.pipeId}: {pipe.status}
                        {pipe.processedBatches ? ` · ${pipe.processedBatches} batches` : ''}
                        {pipe.processedRecords ? ` · ${pipe.processedRecords} rows` : ''}
                        {pipe.error ? ` (${pipe.error})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="run-events-header">
                <h4>Events</h4>
                <label className="checkbox-row">
                  <input
                    data-testid="workflow-runs-problems-only"
                    type="checkbox"
                    checked={problemsOnly}
                    onChange={(ev) => setProblemsOnly(ev.target.checked)}
                  />
                  Errors and warnings only
                </label>
                <Button size="sm" data-testid="workflow-runs-download-log" disabled={!detail} onClick={() => download('text')}>
                  <Download />
                  .log
                </Button>
                <Button size="sm" data-testid="workflow-runs-download-json" disabled={!detail} onClick={() => download('json')}>
                  <Download />
                  .json
                </Button>
              </div>
              <EventLog events={events} problemsOnly={problemsOnly} />
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
  const canRun = useAuthStore((s) => s.can('workflow.run'));
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
        <Button
          variant="danger"
          size="sm"
          disabled={busy || !canRun}
          title={canRun ? undefined : 'Requires the workflow run permission'}
          data-testid="workflow-run-cancel"
          onClick={() => void act(() => api.cancelRun(runId))}
        >
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
                  data-testid={`workflow-run-answer-${field.key}`}
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
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy || !canRun}
            title={canRun ? undefined : 'Requires the workflow run permission'}
            data-testid="workflow-run-answer"
          >
            Send answer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !canRun}
            title={canRun ? undefined : 'Requires the workflow run permission'}
            data-testid="workflow-run-resume"
            onClick={() => void act(() => api.resumeRun(runId))}
          >
            Resume
          </Button>
        </form>
      )}
      {note && <div className="field-error">{note}</div>}
    </div>
  );
}
