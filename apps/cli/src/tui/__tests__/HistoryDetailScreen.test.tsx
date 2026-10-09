import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as store from '../../runtime/store';
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen';

function fakeCtx(run: any) {
  return { userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' }, connections: {}, history: { get: vi.fn().mockResolvedValue(run) } };
}

describe('HistoryDetailScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the run status, target, and per-object results', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(
      fakeCtx({
        id: 'r1',
        status: 'PARTIAL_SUCCESS',
        dialect: 'postgres',
        host: 'localhost',
        database: 'foxdb',
        schema: 'demo_d',
        objectCount: 2,
        startedAt: '2026-07-05T10:00:00Z',
        finishedAt: '2026-07-05T10:00:05Z',
        results: [
          { name: 'WAREHOUSES', type: 'TABLE', action: 'CREATE', status: 'SUCCESS' },
          { name: 'INVENTORY', type: 'TABLE', action: 'ALTER', status: 'FAILED', error: 'boom' },
        ],
      }) as any
    );

    const { lastFrame } = render(<HistoryDetailScreen runId="r1" />);
    await vi.waitFor(() => expect(lastFrame()).toContain('Run r1'));

    expect(lastFrame()).toContain('PARTIAL_SUCCESS');
    expect(lastFrame()).toContain('foxdb');
    expect(lastFrame()).toContain('WAREHOUSES');
    expect(lastFrame()).toContain('INVENTORY');
    expect(lastFrame()).toContain('boom');
  });

  it('shows a not-found message when the run does not exist', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(fakeCtx(null) as any);
    const { lastFrame } = render(<HistoryDetailScreen runId="missing" />);
    await vi.waitFor(() => expect(lastFrame()).toContain('No migration run'));
  });

  it('shows an error state when the store throws', async () => {
    vi.spyOn(store, 'getContext').mockRejectedValue(new Error('connection lost'));
    const { lastFrame } = render(<HistoryDetailScreen runId="r1" />);
    await vi.waitFor(() => expect(lastFrame()).toContain('connection lost'));
  });
});
