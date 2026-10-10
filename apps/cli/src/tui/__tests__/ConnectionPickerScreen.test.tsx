import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as store from '../../runtime/store';
import { ConnectionPickerScreen } from '../screens/ConnectionPickerScreen';

function fakeCtx(rows: any[] = []) {
  return {
    userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
    connections: {
      list: vi.fn().mockResolvedValue(rows),
      resolve: vi.fn(),
    },
    history: {},
  };
}

describe('ConnectionPickerScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading spinner, then the saved connection names', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(
      fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_c' }]) as any
    );

    const { lastFrame } = render(<ConnectionPickerScreen role="source" onPicked={() => {}} onAddNew={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));

    expect(lastFrame()).toContain('postgres');
    expect(lastFrame()).toContain('Add a new connection');
  });

  it('shows the role in the header', async () => {
    vi.spyOn(store, 'getContext').mockResolvedValue(fakeCtx([]) as any);
    const { lastFrame } = render(<ConnectionPickerScreen role="target" onPicked={() => {}} onAddNew={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('target'));
  });

  it('shows an error state when the store throws', async () => {
    vi.spyOn(store, 'getContext').mockRejectedValue(new Error('Not set up yet — run `fox setup` first.'));
    const { lastFrame } = render(<ConnectionPickerScreen role="source" onPicked={() => {}} onAddNew={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('Not set up yet'));
  });

  it('resolves the selected connection and calls onPicked with a ConnRef', async () => {
    const ctx = fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres', host: 'localhost', database: 'foxdb', schema: 'demo_c' }]);
    ctx.connections.resolve.mockResolvedValue({ dialect: 'postgres', schema: 'demo_c', option: { host: 'localhost', password: 's3cret' } });
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
    const onPicked = vi.fn();

    const { stdin, lastFrame } = render(<ConnectionPickerScreen role="source" onPicked={onPicked} onAddNew={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));
    await new Promise((r) => setTimeout(r, 40)); // SelectInput's input listener attaches a tick after mount

    stdin.write('\r');
    await vi.waitFor(() => expect(onPicked).toHaveBeenCalled());

    expect(ctx.connections.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, '1');
    expect(onPicked).toHaveBeenCalledWith({
      dialect: 'postgres',
      schema: 'demo_c',
      option: { host: 'localhost', password: 's3cret' },
      label: 'demo_c',
    });
  });

  it('shows an error when the saved connection no longer exists', async () => {
    const ctx = fakeCtx([{ id: '1', name: 'demo_c', dialect: 'postgres' }]);
    ctx.connections.resolve.mockResolvedValue(null);
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);

    const { stdin, lastFrame } = render(<ConnectionPickerScreen role="source" onPicked={() => {}} onAddNew={() => {}} />);
    await vi.waitFor(() => expect(lastFrame()).toContain('demo_c'));
    await new Promise((r) => setTimeout(r, 40));

    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('no longer exists'));
  });
});
