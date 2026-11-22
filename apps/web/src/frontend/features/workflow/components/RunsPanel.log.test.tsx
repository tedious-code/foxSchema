/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Finding a failed run and reading why: the list filters, the Error column,
 * and the event log narrowed to errors and warnings.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
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

vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    getRun: vi.fn(async () => ({ ...failedRun, pipes: [], pipelines: [] })),
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
    getRunFailure: vi.fn(async () => ({ runId: failedRun.id, status: 'failed', gateSkipped: [], aiFailovers: [] })),
    streamRunEvents: vi.fn(),
    getRunInputs: vi.fn(),
  },
}));

import { RunsPanel } from './RunsPanel';

describe('Runs panel log', () => {
  beforeEach(() => {
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
});
