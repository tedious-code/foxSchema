import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as store from '../../runtime/store';
import { HistoryListScreen } from '../screens/HistoryListScreen';

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function fakeCtx(runs: any[] = []) {
  return { userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' }, connections: {}, history: { list: vi.fn().mockResolvedValue(runs) } };
}

describe('HistoryListScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the recorded runs', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(
      fakeCtx([
        { id: 'r1', status: 'SUCCESS', dialect: 'postgres', database: 'foxdb', schema: 'demo_d', objectCount: 5, startedAt: '2026-07-05T10:00:00Z' },
        { id: 'r2', status: 'PARTIAL_SUCCESS', dialect: 'mysql', database: 'demo_d', schema: undefined, objectCount: 2, startedAt: '2026-07-04T10:00:00Z' },
      ]) as any
    );

    const { lastFrame } = render(<HistoryListScreen onSelectRun={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('SUCCESS'));

    expect(lastFrame()).toContain('foxdb');
    expect(lastFrame()).toContain('PARTIAL_SUCCESS');
  });

  it('shows an empty-state message when there are no runs', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(fakeCtx([]) as any);
    const { lastFrame } = render(<HistoryListScreen onSelectRun={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('No migration runs recorded'));
  });

  it('shows an error state when the store throws', async () => {
    vi.spyOn(store, 'getContext').mockRejectedValue(new Error('boom'));
    const { lastFrame } = render(<HistoryListScreen onSelectRun={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('boom'));
  });

  it('calls onSelectRun with the picked run id on enter', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(
      fakeCtx([{ id: 'r1', status: 'SUCCESS', dialect: 'postgres', database: 'foxdb', schema: 'demo_d', objectCount: 5, startedAt: '2026-07-05T10:00:00Z' }]) as any
    );
    const onSelectRun = vi.fn();

    const { stdin, lastFrame } = render(<HistoryListScreen onSelectRun={onSelectRun} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('foxdb'));
    await wait();

    stdin.write('\r');
    await vi.waitFor(() => expect(onSelectRun).toHaveBeenCalled());

    expect(onSelectRun).toHaveBeenCalledWith('r1');
  });
});
