/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A debug run reads its detail once, then relies on the event stream. The
 * once-a-second poll is for when that stream is down: running it all along
 * re-rendered the designer every second, indefinitely at a human gate.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => ({
  current: undefined as undefined | { onmessage?: (m: { data: string }) => void; onerror?: () => void },
}));
const getRun = vi.hoisted(() => vi.fn());
vi.mock('../api/engineClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/engineClient')>()),
  api: {
    getRun,
    streamRunEvents: () => {
      const source = { close: vi.fn(), addEventListener: vi.fn() } as Record<string, unknown>;
      stream.current = source;
      return source;
    },
  },
}));

import { useDebugSamples } from './useDebugSamples';

describe('debug run polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getRun.mockReset();
    getRun.mockResolvedValue({ id: 'r1', status: 'running', pipes: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the run once and then leaves it to a healthy stream', async () => {
    renderHook(() => useDebugSamples('r1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it('polls while the stream is down, and stops once it delivers again', async () => {
    renderHook(() => useDebugSamples('r1'));
    await act(async () => {
      stream.current!.onerror!();
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const whileDown = getRun.mock.calls.length;
    expect(whileDown).toBeGreaterThanOrEqual(3);

    await act(async () => {
      stream.current!.onmessage!({
        data: JSON.stringify({ seq: 1, workflowRunId: 'r1', at: '', type: 'pipeline.status', data: {} }),
      });
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getRun.mock.calls.length).toBe(whileDown);
  });
});
