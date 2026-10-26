/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TraceEvent } from '@foxschema/ui-shared';
import { useSyncStore } from '@/features/compare';
import { SqlTracerPanel, traceEventMatches } from './SqlTracerPanel';

const startTrace = vi.fn();
const traceEvents = vi.fn();
const stopTrace = vi.fn();
vi.mock('../api/sqlTraceApi', () => ({
  startTrace: (...a: unknown[]) => startTrace(...a),
  traceEvents: (...a: unknown[]) => traceEvents(...a),
  stopTrace: (...a: unknown[]) => stopTrace(...a),
}));

const status = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  connectionId: 'c1',
  mode: 'fox',
  startedAt: '2026-10-25T00:00:00Z',
  endsAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  running: true,
  stopReason: null,
  error: null,
  eventCount: 0,
  ...over,
});

const event = (seq: number, text: string, over: Partial<TraceEvent> = {}): TraceEvent => ({
  seq,
  at: '2026-10-25T00:00:01Z',
  durationMs: 2,
  user: 'app',
  database: 'shop',
  client: 'Fox',
  sessionId: null,
  rows: 1,
  text,
  error: null,
  state: null,
  source: 'fox',
  ...over,
});

beforeEach(() => {
  startTrace.mockReset().mockResolvedValue(status());
  stopTrace.mockReset().mockResolvedValue(status({ running: false, stopReason: 'stopped' }));
  traceEvents.mockReset();
  useSyncStore.setState({
    connections: [{ id: 'c1', name: 'shop', dialect: 'sqlite', database: '/tmp/shop.db' }],
  } as never);
});
afterEach(cleanup);

describe('SqlTracerPanel', () => {
  it('starts a Fox activity trace, shows what arrives, and asks only for newer events', async () => {
    traceEvents
      .mockResolvedValueOnce({ status: status({ eventCount: 2 }), events: [event(1, 'SELECT 1'), event(2, 'SELECT 2')] })
      .mockResolvedValue({ status: status({ running: false, stopReason: 'time', eventCount: 2 }), events: [] });
    render(<SqlTracerPanel lockedConnectionId="c1" />);
    fireEvent.click(screen.getByTestId('sql-tracer-start'));

    await screen.findByTestId('sql-tracer-row-2');
    expect(startTrace).toHaveBeenCalledWith('c1', 'fox', undefined);
    await waitFor(() => expect(screen.getByTestId('sql-tracer-status').textContent).toMatch(/15 minutes/), { timeout: 3000 });
    expect(traceEvents.mock.calls.map((c) => c[1])).toEqual([0, 2]);
  });

  it('offers Live only where the engine lists its sessions', () => {
    render(<SqlTracerPanel lockedConnectionId="c1" />);
    const live = screen.getByTestId('sql-tracer-mode').querySelector('option[value="live"]') as HTMLOptionElement;
    expect(live.disabled).toBe(true);
  });

  it('shows the full statement for the row picked', async () => {
    traceEvents.mockResolvedValue({ status: status({ running: false, stopReason: 'stopped' }), events: [event(1, 'SELECT *\nFROM orders')] });
    render(<SqlTracerPanel lockedConnectionId="c1" />);
    fireEvent.click(screen.getByTestId('sql-tracer-start'));
    fireEvent.click(await screen.findByTestId('sql-tracer-row-1'));
    expect(screen.getByTestId('sql-tracer-detail-text').textContent).toBe('SELECT *\nFROM orders');
  });

  it('stops the trace when the screen closes', async () => {
    traceEvents.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<SqlTracerPanel lockedConnectionId="c1" />);
    fireEvent.click(screen.getByTestId('sql-tracer-start'));
    await screen.findByTestId('sql-tracer-stop');
    unmount();
    expect(stopTrace).toHaveBeenCalledWith('t1');
  });
});

describe('traceEventMatches', () => {
  it('matches any text field, case-blind', () => {
    const e = event(1, 'SELECT 1', { user: 'Alice', client: 'psql' });
    expect(traceEventMatches(e, 'alice')).toBe(true);
    expect(traceEventMatches(e, 'PSQL')).toBe(true);
    expect(traceEventMatches(e, 'orders')).toBe(false);
    expect(traceEventMatches(e, '  ')).toBe(true);
  });
});
