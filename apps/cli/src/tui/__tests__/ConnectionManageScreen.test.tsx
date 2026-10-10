import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as store from '../../runtime/store';
import { ConnectionManageScreen } from '../screens/ConnectionManageScreen';

const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

function fakeCtx(rows: any[] = []) {
  return {
    userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
    connections: {
      list: vi.fn().mockResolvedValue(rows),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    history: {},
  };
}

describe('ConnectionManageScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists saved connections', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(
      fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_c' }]) as any
    );
    const { lastFrame } = render(<ConnectionManageScreen />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));
    expect(lastFrame()).toContain('postgres');
  });

  it('shows an empty-state message when there are none', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(fakeCtx([]) as any);
    const { lastFrame } = render(<ConnectionManageScreen />);
    await vi.waitFor(() => expect(lastFrame()).toContain('No saved connections yet'));
  });

  it('deletes the selected connection on confirm', async () => {
    const ctx = fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_c' }]);
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);

    const { stdin, lastFrame } = render(<ConnectionManageScreen />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));
    await wait();

    stdin.write('\r'); // select the connection
    await vi.waitFor(() => expect(lastFrame()).toContain('Delete "demo_c"?'));
    await wait();

    stdin.write('\r'); // "Yes, delete it" is pre-selected
    await vi.waitFor(() => expect(ctx.connections.remove).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, '1'));
  });

  it('goes back without deleting when "No" is chosen', async () => {
    const ctx = fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_c' }]);
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);

    const { stdin, lastFrame } = render(<ConnectionManageScreen />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));
    await wait();

    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Delete "demo_c"?'));
    await wait();

    stdin.write('\x1b[B'); // down to "No, go back"
    await wait();
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Saved connections'));

    expect(ctx.connections.remove).not.toHaveBeenCalled();
  });
});
