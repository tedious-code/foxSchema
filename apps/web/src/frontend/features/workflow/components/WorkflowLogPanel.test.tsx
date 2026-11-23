/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A workflow's log: its run health at a glance, and the newest failure
 * opened with what failed, what to check, and the error trail.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const failed = {
  id: 'run-failed',
  workflowId: 'wf',
  workflowVersion: 2,
  status: 'failed',
  trigger: 'cron',
  startedAt: '2026-11-22T10:00:00.000Z',
  finishedAt: '2026-11-22T10:00:00.250Z',
  error: 'no such table: no_such_table',
};
const ok = (n: number) => ({
  id: `run-ok-${n}`,
  workflowId: 'wf',
  workflowVersion: 2,
  status: 'succeeded',
  trigger: 'cron',
  startedAt: `2026-11-22T0${n}:00:00.000Z`,
  finishedAt: `2026-11-22T0${n}:00:00.100Z`,
});

const getRunFailure = vi.hoisted(() => vi.fn());
const listWorkflowRuns = vi.hoisted(() => vi.fn());
const listRunEvents = vi.hoisted(() => vi.fn());
vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    listWorkflows: vi.fn(async () => [{ id: 'wf', name: 'Nightly load', triggers: [], pipelines: 1, pipes: 2, version: 2 }]),
    listWorkflowRuns,
    getRunFailure,
    listRunEvents,
  },
}));

function resetApiMocks() {
  listWorkflowRuns.mockImplementation(async () => [ok(1), failed, ok(2)]);
  listRunEvents.mockImplementation(async (runId: string) => ({
    events: [
      { seq: 1, workflowRunId: runId, at: failed.startedAt, type: 'run.status', data: { status: 'running' } },
      {
        seq: 8,
        workflowRunId: runId,
        at: failed.finishedAt,
        type: 'pipe.status',
        pipelineId: 'main',
        pipeId: 'write',
        data: { status: 'failed' },
        message: 'no such table: no_such_table',
      },
    ],
  }));
  getRunFailure.mockImplementation(async (runId: string) => ({
    runId,
    workflowId: 'wf',
    workflowVersion: 2,
    status: runId === failed.id ? 'failed' : 'succeeded',
    gateSkipped: [],
    aiFailovers: [],
    ...(runId === failed.id
      ? {
          error: failed.error,
          failedPipe: { id: 'x', pipelineId: 'main', pipeId: 'write', type: 'sink.db.sql', error: failed.error },
        }
      : {}),
  }));
}

import { WorkflowLogPanel } from './WorkflowLogPanel';

describe('Workflow log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetApiMocks();
  });
  it('sums up the runs and opens the newest failure with what to check', async () => {
    render(<WorkflowLogPanel workflowId="wf" onBack={() => undefined} onOpenInDesigner={() => undefined} />);

    const stats = await screen.findByTestId('workflow-logs-stats');
    expect(stats.textContent).toContain('3runs');
    expect(stats.textContent).toContain('1failed');
    expect(stats.textContent).toContain('67%success rate');

    const hints = await screen.findByTestId('workflow-logs-hints-run-failed');
    expect(hints.textContent).toContain('A table the step uses does not exist');
    expect(screen.getByText('write')).toBeTruthy();
    expect(screen.getByText(/sink\.db\.sql/)).toBeTruthy();

    // The trail of a failure starts narrowed to errors and warnings.
    const trail = await screen.findByTestId('workflow-logs-events-run-failed');
    expect(trail.querySelectorAll('.event-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('workflow-logs-all-events-run-failed'));
    expect(screen.getByTestId('workflow-logs-events-run-failed').querySelectorAll('.event-row')).toHaveLength(2);
  });

  it('filters the log to failed runs', async () => {
    render(<WorkflowLogPanel workflowId="wf" onBack={() => undefined} onOpenInDesigner={() => undefined} />);
    await screen.findByTestId('workflow-logs-stats');
    const list = () => document.querySelectorAll('.log-run');
    expect(list()).toHaveLength(3);

    fireEvent.click(screen.getByTestId('workflow-logs-filter-failed'));
    expect(list()).toHaveLength(1);
    expect(within(list()[0] as HTMLElement).getByText('failed')).toBeTruthy();
  });

  it('reloads open run details on Refresh and averages even-count medians', async () => {
    listWorkflowRuns.mockResolvedValueOnce([
      ok(1),
      {
        ...ok(2),
        startedAt: '2026-11-22T02:00:00.000Z',
        finishedAt: '2026-11-22T02:00:00.300Z',
      },
      failed,
      // Keep an even number of finished durations: 100, 250, 300, 400 -> median 275 ms.
      {
        ...ok(3),
        startedAt: '2026-11-22T03:00:00.000Z',
        finishedAt: '2026-11-22T03:00:00.400Z',
      },
    ]);
    render(<WorkflowLogPanel workflowId="wf" onBack={() => undefined} onOpenInDesigner={() => undefined} />);

    const stats = await screen.findByTestId('workflow-logs-stats');
    expect(stats.textContent).toContain('275 msmedian time');
    await screen.findByTestId('workflow-logs-events-run-failed');
    expect(listRunEvents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('workflow-logs-refresh'));
    await waitFor(() => expect(listRunEvents).toHaveBeenCalledTimes(2));
  });
});
