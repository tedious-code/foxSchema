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
vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    getRun: vi.fn(async () => ({ id: 'r1', workflowId: 'wf', status: 'running', pipes: [], pipelines: [] })),
    listRunEvents: vi.fn(async () => ({
      events: [1, 2, 7].map((seq) => ({ seq, workflowRunId: 'r1', at: '2026-10-12T00:00:00Z', type: 'pipeline.status', data: {} })),
    })),
    getRunFailure: vi.fn(async () => ({ runId: 'r1', status: 'running', gateSkipped: [], aiFailovers: [] })),
    streamRunEvents,
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
});
