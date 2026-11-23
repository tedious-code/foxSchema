/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One workflow's log: how its runs have gone, newest first, and for each
 * failure what failed, the trail of errors that led there, and what to check.
 * Opened from the Workflows list.
 */
import { ArrowLeft, Download, PlayCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type RunEvent, type RunFailureSummary, type RunRecord } from '../api/engineClient';
import { useWorkflows } from '../api/engineQueries';
import { downloadFile, formatDuration, runDuration, runLogText } from '../lib/runLog';
import { troubleshoot } from '../lib/troubleshoot';
import { Button } from './controls';
import { EventLog } from './EventLog';

const RUNS_LIMIT = 200;

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failed' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'other', label: 'Other' },
] as const;
type Filter = (typeof FILTERS)[number]['id'];

function matches(filter: Filter, run: RunRecord): boolean {
  if (filter === 'all') return true;
  if (filter === 'other') return run.status !== 'failed' && run.status !== 'succeeded';
  return run.status === filter;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function WorkflowLogPanel({
  workflowId,
  onBack,
  onOpenInDesigner,
}: {
  workflowId: string;
  onBack: () => void;
  onOpenInDesigner: (id: string) => void;
}) {
  const { workflows } = useWorkflows();
  const workflow = workflows.find((item) => item.id === workflowId);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listWorkflowRuns(workflowId)
      .then((list) => {
        if (!cancelled) setRuns([...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The runs could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, reloadTick]);

  const stats = useMemo(() => {
    const list = runs ?? [];
    const failed = list.filter((run) => run.status === 'failed');
    const succeeded = list.filter((run) => run.status === 'succeeded');
    const finished = failed.length + succeeded.length;
    const durations = list.map(runDuration).filter((ms): ms is number => ms !== undefined);
    return {
      total: list.length,
      failed: failed.length,
      succeeded: succeeded.length,
      other: list.length - failed.length - succeeded.length,
      successRate: finished > 0 ? Math.round((succeeded.length / finished) * 100) : undefined,
      medianMs: median(durations),
      lastFailure: failed[0],
      lastSuccess: succeeded[0],
    };
  }, [runs]);

  const shown = (runs ?? []).filter((run) => matches(filter, run));
  // The newest failure opens on its own: it is what someone came here to read.
  const openFirst = stats.lastFailure?.id;

  return (
    <div className="runs workflow-log" data-testid="workflow-logs">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Button size="sm" variant="ghost" data-testid="workflow-logs-back" onClick={onBack}>
          <ArrowLeft />
          Workflows
        </Button>
        <h3 className="m-0">
          Log · {workflow?.name ?? workflowId}
        </h3>
        <small className="workflow-row-id">{workflowId}</small>
        <span className="ml-auto flex gap-2">
          <Button size="sm" data-testid="workflow-logs-refresh" onClick={() => setReloadTick((n) => n + 1)}>
            <RefreshCw />
            Refresh
          </Button>
          <Button size="sm" data-testid="workflow-logs-open-in-designer" onClick={() => onOpenInDesigner(workflowId)}>
            <PlayCircle />
            Open in designer
          </Button>
        </span>
      </div>

      {error && <div className="field-error">{error}</div>}
      {runs === null && !error && <div className="empty">Loading runs…</div>}

      {runs !== null && (
        <>
          <div className="log-stats" data-testid="workflow-logs-stats">
            <div>
              <strong>{stats.total}</strong>
              <span>{stats.total >= RUNS_LIMIT ? `runs (latest ${RUNS_LIMIT})` : stats.total === 1 ? 'run' : 'runs'}</span>
            </div>
            <div className={stats.failed > 0 ? 'bad' : undefined}>
              <strong>{stats.failed}</strong>
              <span>failed</span>
            </div>
            <div>
              <strong>{stats.succeeded}</strong>
              <span>succeeded</span>
            </div>
            <div>
              <strong>{stats.successRate === undefined ? '—' : `${stats.successRate}%`}</strong>
              <span>success rate</span>
            </div>
            <div>
              <strong>{formatDuration(stats.medianMs) || '—'}</strong>
              <span>median time</span>
            </div>
            <div>
              <strong>{stats.lastFailure ? new Date(stats.lastFailure.startedAt).toLocaleString() : 'never'}</strong>
              <span>last failure</span>
            </div>
          </div>

          <div className="log-filters" role="group" aria-label="Show runs">
            {FILTERS.map((item) => {
              const count =
                item.id === 'all' ? stats.total : item.id === 'other' ? stats.other : stats[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`workflow-logs-filter-${item.id}`}
                  aria-pressed={filter === item.id}
                  className={filter === item.id ? 'active' : undefined}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label} <span>{count}</span>
                </button>
              );
            })}
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              {runs.length === 0 ? 'This workflow has not run yet.' : 'No runs match this filter.'}
            </div>
          ) : (
            <ol className="log-runs">
              {shown.map((run) => (
                <RunLogEntry key={run.id} run={run} defaultOpen={run.id === openFirst} reloadTick={reloadTick} />
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

/** One run in the log; loads its failure and events when opened. */
function RunLogEntry({ run, defaultOpen, reloadTick }: { run: RunRecord; defaultOpen: boolean; reloadTick: number }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? defaultOpen;
  const loadedTickRef = useRef<number | null>(null);
  const [failure, setFailure] = useState<RunFailureSummary | null>(null);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allEvents, setAllEvents] = useState(run.status !== 'failed');

  useEffect(() => {
    if (!open) return;
    if (events !== null && loadedTickRef.current === reloadTick) return;
    let cancelled = false;
    Promise.all([api.getRunFailure(run.id), api.listRunEvents(run.id)])
      .then(([summary, page]) => {
        if (cancelled) return;
        loadedTickRef.current = reloadTick;
        setError(null);
        setFailure(summary);
        setEvents(page.events);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'This run could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, events, reloadTick, run.id]);

  // The step's own error says the most; the run's error is the fallback.
  const cause = failure?.failedPipe?.error ?? failure?.failedPipeline?.error ?? run.error;
  const hints = run.status === 'failed' ? troubleshoot(cause) : [];
  const failedStep = failure?.failedPipe;
  const extraFailedSteps = (failure?.failedPipes ?? []).slice(1);

  return (
    <li className={`log-run ${run.status}`}>
      <details
        open={open}
        onToggle={(ev) => {
          const next = (ev.currentTarget as HTMLDetailsElement).open;
          if (next !== open) setManualOpen(next);
        }}
      >
        <summary data-testid={`workflow-logs-run-${run.id}`}>
          <span className={`status-pill ${run.status}`}>{run.status}</span>
          <span className="log-run-time">{new Date(run.startedAt).toLocaleString()}</span>
          <span className="log-run-meta">
            {run.trigger} · v{run.workflowVersion}
            {runDuration(run) !== undefined ? ` · ${formatDuration(runDuration(run))}` : ''}
          </span>
          {run.error && <span className="log-run-error">{run.error}</span>}
        </summary>

        <div className="log-run-body">
          {error && <div className="field-error">{error}</div>}
          {open && events === null && !error && <div className="empty">Loading…</div>}

          {run.status === 'failed' && (
            <div className="log-diagnosis">
              <p>
                <strong>What failed: </strong>
                {failedStep ? (
                  <>
                    step <code>{failedStep.name || failedStep.pipeId}</code>
                    {failedStep.type ? ` (${failedStep.type})` : ''} in pipeline <code>{failedStep.pipelineId}</code>
                  </>
                ) : failure?.failedPipeline ? (
                  <>
                    pipeline <code>{failure.failedPipeline.pipelineId}</code>
                  </>
                ) : (
                  'the run'
                )}
                {cause ? <span className="field-error"> — {cause}</span> : null}
              </p>
              {extraFailedSteps.length > 0 && (
                <p className="hint">
                  Also failed: {extraFailedSteps.map((step) => `${step.name || step.pipeId}${step.error ? ` (${step.error})` : ''}`).join('; ')}
                </p>
              )}
              {failure && failure.gateSkipped.length > 0 && (
                <p className="hint">
                  Not run because of it: {failure.gateSkipped.map((item) => item.pipelineId).join(', ')}
                </p>
              )}
              {hints.length > 0 && (
                <div className="log-hints" data-testid={`workflow-logs-hints-${run.id}`}>
                  {hints.map((hint) => (
                    <div key={hint.id} className="log-hint">
                      <strong>What to check: {hint.title}</strong>
                      <ul>
                        {hint.steps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {events !== null && (
            <>
              <div className="run-events-header">
                <h4>{allEvents ? 'Events' : 'Error trail'}</h4>
                <label className="checkbox-row">
                  <input
                    data-testid={`workflow-logs-all-events-${run.id}`}
                    type="checkbox"
                    checked={allEvents}
                    onChange={(ev) => setAllEvents(ev.target.checked)}
                  />
                  All events
                </label>
                <Button
                  size="sm"
                  data-testid={`workflow-logs-download-${run.id}`}
                  onClick={() => downloadFile(`${run.workflowId}-run-${run.id.slice(0, 8)}.log`, runLogText(run, events), 'text/plain')}
                >
                  <Download />
                  .log
                </Button>
              </div>
              <EventLog events={events} problemsOnly={!allEvents} testId={`workflow-logs-events-${run.id}`} />
            </>
          )}
        </div>
      </details>
    </li>
  );
}
