/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Finding a failed run and reading why: the list filters, the Error column,
 * and the event log narrowed to errors and warnings.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/platform/authStore';

const failedRun = {
  id: '653bc269-run',
  workflowId: 'overnight-multi-db-join',
  workflowVersion: 1,
  status: 'failed',
  trigger: 'manual',
  startedAt: '2026-11-22T05:17:59.007Z',
  finishedAt: '2026-11-22T05:17:59.255Z',
  error: 'cannot start a transaction within a transaction',
};
const okRun = {
  id: '722815fa-run',
  workflowId: 'overnight-api-etl',
  workflowVersion: 1,
  status: 'succeeded',
  trigger: 'cron',
  startedAt: '2026-11-22T05:25:18.409Z',
  finishedAt: '2026-11-22T05:25:19.471Z',
};

const getRunMock = vi.hoisted(() => vi.fn());
const getRunFailureMock = vi.hoisted(() => vi.fn());
const streamRunEventsMock = vi.hoisted(() => vi.fn());
const runWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    getRun: getRunMock,
    listRunEvents: vi.fn(async () => ({
      events: [
        { seq: 1, workflowRunId: failedRun.id, at: failedRun.startedAt, type: 'run.status', data: { status: 'running' } },
        {
          seq: 20,
          workflowRunId: failedRun.id,
          at: failedRun.finishedAt,
          type: 'pipe.status',
          pipelineId: 'fetch',
          pipeId: 'stage',
          data: { status: 'failed' },
          message: 'cannot start a transaction within a transaction',
        },
      ],
    })),
    getRunFailure: getRunFailureMock,
    streamRunEvents: streamRunEventsMock,
    getRunInputs: vi.fn(),
    run: runWorkflowMock,
  },
}));

import { RunsPanel } from './RunsPanel';

describe('Runs panel log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRunMock.mockImplementation(async () => ({ ...failedRun, pipes: [], pipelines: [] }));
    getRunFailureMock.mockImplementation(async () => ({ runId: failedRun.id, status: 'failed', gateSkipped: [], aiFailovers: [] }));
    useAuthStore.setState({
      user: { id: 'u1', email: 'u1@x.test', role: 'admin', permissions: ['workflow.access', 'workflow.run'] } as never,
    });
  });

  it('narrows the list to failed runs and shows each one’s error', () => {
    const { container } = render(<RunsPanel runs={[failedRun, okRun]} onRefresh={() => undefined} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

    fireEvent.change(screen.getByTestId('workflow-runs-filter-status'), { target: { value: 'failed' } });
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('cannot start a transaction within a transaction');
    expect(rows[0]!.textContent).toContain('248 ms');
    expect(screen.getByText('1 of 2 runs')).toBeTruthy();

    fireEvent.change(screen.getByTestId('workflow-runs-filter-status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('workflow-runs-filter-workflow'), { target: { value: 'overnight-api-etl' } });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.querySelector('tbody tr')!.textContent).toContain('overnight-api-etl');
  });

  it('shows the failing pipe’s error and can hide everything else', async () => {
    const { container } = render(<RunsPanel runs={[failedRun]} onRefresh={() => undefined} />);
    fireEvent.click(container.querySelector('tbody tr')!);
    const log = await screen.findByTestId('workflow-runs-event-log');
    expect(log.textContent).toContain('fetch/stage');
    expect(log.textContent).toContain('failed — cannot start a transaction within a transaction');
    expect(within(log).getByText('running')).toBeTruthy();

    fireEvent.click(screen.getByTestId('workflow-runs-problems-only'));
    const narrowed = screen.getByTestId('workflow-runs-event-log');
    expect(narrowed.querySelectorAll('.event-row')).toHaveLength(1);
    expect(narrowed.textContent).toContain('cannot start a transaction within a transaction');
  });

  it('reloads selected run details on Refresh and updates failure summary on live run.status', async () => {
    const fakeSource = {
      onmessage: null as ((msg: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    streamRunEventsMock.mockReturnValue(fakeSource);
    const onRefresh = vi.fn();
    const { container } = render(<RunsPanel runs={[failedRun]} onRefresh={onRefresh} />);

    fireEvent.click(container.querySelector('tbody tr')!);
    await screen.findByTestId('workflow-runs-event-log');
    expect(getRunFailureMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getRunFailureMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('workflow-runs-live'));
    expect(streamRunEventsMock).toHaveBeenCalledTimes(1);
    fakeSource.onmessage?.({
      data: JSON.stringify({
        seq: 21,
        workflowRunId: failedRun.id,
        at: failedRun.finishedAt,
        type: 'run.status',
        data: { status: 'failed' },
      }),
    });
    await waitFor(() => expect(getRunFailureMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(getRunMock).toHaveBeenCalledTimes(3));
  });

  it('supports opening workflow in designer and re-running a finished run', async () => {
    runWorkflowMock.mockResolvedValue({ runId: 'rerun-1234', status: 'queued', accepted: true });
    const onRefresh = vi.fn();
    const onOpenWorkflow = vi.fn();
    const { container } = render(
      <RunsPanel runs={[failedRun]} onRefresh={onRefresh} onOpenWorkflow={onOpenWorkflow} />,
    );

    fireEvent.click(container.querySelector('tbody tr')!);
    const openBtn = await screen.findByTestId('workflow-run-open-workflow');
    fireEvent.click(openBtn);
    expect(onOpenWorkflow).toHaveBeenCalledWith(failedRun.workflowId);

    fireEvent.click(screen.getByTestId('workflow-run-rerun'));
    await waitFor(() => expect(runWorkflowMock).toHaveBeenCalledWith(failedRun.workflowId, { debug: true }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
