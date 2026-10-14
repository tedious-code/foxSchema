/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turning on the live stream picks up after the events already shown, rather
 * than replaying the whole run (sample payloads included) a second time.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const streamRunEvents = vi.hoisted(() =>
  vi.fn(() => ({ close: vi.fn(), addEventListener: vi.fn() }) as unknown as EventSource),
);
const getRun = vi.hoisted(() => vi.fn(async () => ({ id: 'r1', workflowId: 'wf', status: 'running', pipes: [], pipelines: [] })));
const cancelRun = vi.hoisted(() => vi.fn(async () => ({ runId: 'r1', status: 'cancelled' })));
const resumeRun = vi.hoisted(() => vi.fn(async () => ({ runId: 'r1', status: 'queued' })));
const getRunInputs = vi.hoisted(() => vi.fn(async () => ({ runId: 'r1', status: 'paused', pending: [] as unknown[] })));
const answerRunInput = vi.hoisted(() => vi.fn(async () => ({ runId: 'r1', status: 'queued' })));
vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    getRun,
    listRunEvents: vi.fn(async () => ({
      events: [1, 2, 7].map((seq) => ({ seq, workflowRunId: 'r1', at: '2026-10-12T00:00:00Z', type: 'pipeline.status', data: {} })),
    })),
    getRunFailure: vi.fn(async () => ({ runId: 'r1', status: 'running', gateSkipped: [], aiFailovers: [] })),
    streamRunEvents,
    cancelRun,
    resumeRun,
    getRunInputs,
    answerRunInput,
  },
}));

import { RunsPanel } from './RunsPanel';

describe('Runs panel live stream', () => {
  it('subscribes after the last event already loaded', async () => {
    const run = { id: 'r1', workflowId: 'wf', status: 'running', trigger: 'manual', startedAt: '2026-10-12T00:00:00Z' };
    const { container } = render(<RunsPanel runs={[run as never]} onRefresh={() => undefined} />);
    fireEvent.click(container.querySelector('tbody tr')!);
    // Live can be turned on before the history arrives. The stream still has
    // to start after that history, not at seq 0 and not at some other run's seq.
    fireEvent.click(await screen.findByTestId('workflow-runs-live'));
    await waitFor(() => expect(streamRunEvents).toHaveBeenCalledTimes(1));
    expect(streamRunEvents).toHaveBeenCalledWith('r1', 7);
  });

  it('cancels a running run and reloads it', async () => {
    const run = { id: 'r1', workflowId: 'wf', status: 'running', trigger: 'manual', startedAt: '2026-10-12T00:00:00Z' };
    const { container } = render(<RunsPanel runs={[run as never]} onRefresh={() => undefined} />);
    fireEvent.click(container.querySelector('tbody tr')!);
    fireEvent.click(await screen.findByTestId('workflow-run-cancel'));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(getRun.mock.calls.length).toBeGreaterThan(1));
  });

  it('sends a human-gate answer with numbers and booleans, and can resume', async () => {
    getRun.mockResolvedValue({ id: 'r1', workflowId: 'wf', status: 'paused', pipes: [], pipelines: [] });
    getRunInputs.mockResolvedValue({
      runId: 'r1',
      status: 'paused',
      pending: [{
        key: 'gate',
        prompt: 'Approve the batch',
        fields: [
          { key: 'n', label: 'Count', type: 'number' },
          { key: 'ok', label: 'Approve', type: 'boolean' },
        ],
      }],
    });
    const run = { id: 'r1', workflowId: 'wf', status: 'paused', trigger: 'manual', startedAt: '2026-10-12T00:00:00Z' };
    const { container } = render(<RunsPanel runs={[run as never]} onRefresh={() => undefined} />);
    fireEvent.click(container.querySelector('tbody tr')!);
    fireEvent.change(await screen.findByLabelText('Count'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('Approve'));
    fireEvent.click(screen.getByTestId('workflow-run-answer'));
    await waitFor(() =>
      expect(answerRunInput).toHaveBeenCalledWith('r1', { key: 'gate', values: { n: 4, ok: true } }),
    );
    fireEvent.click(screen.getByTestId('workflow-run-resume'));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('r1'));
  });
});
