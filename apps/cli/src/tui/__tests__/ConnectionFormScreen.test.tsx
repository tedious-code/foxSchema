import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as store from '../../runtime/store';
import { ConnectionFormScreen } from '../screens/ConnectionFormScreen';

// A real (not setTimeout(0)) delay: ink-text-input needs a render tick to commit each
// character to its controlled `value` before Enter fires, or `onSubmit` receives ''
// (confirmed by tracing the actual value ink-text-input delivers). 40ms was
// intermittently too short under full-suite parallel load.
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Types a value then presses Enter, with a tick between so ink-text-input commits it first. */
async function type(stdin: { write: (s: string) => void }, value: string) {
  stdin.write(value);
  await wait();
  stdin.write('\r');
  await wait();
}

describe('ConnectionFormScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('walks all fields, then the password, then a save choice, and submits without saving', async () => {
    const ctx = { userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' }, connections: { create: vi.fn() }, history: {} };
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
    const onSubmit = vi.fn();

    const { stdin, lastFrame } = render(<ConnectionFormScreen role="source" onSubmit={onSubmit} />);
    await wait();

    await type(stdin, 'demo_c');       // name
    await type(stdin, 'postgres');     // dialect
    await type(stdin, 'localhost');    // host
    await type(stdin, '5432');         // port
    await type(stdin, 'foxdb');        // database
    await type(stdin, 'foxuser');      // user
    await type(stdin, 'demo_c');       // schema
    await vi.waitFor(() => expect(lastFrame()).toContain('Password'), { timeout: 10_000 });

    await type(stdin, 's3cret');       // password
    await vi.waitFor(() => expect(lastFrame()).toContain('Save this connection'), { timeout: 10_000 });

    stdin.write('\r'); // first item ("Yes, save it") is pre-selected — enter accepts it
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled(), { timeout: 10_000 });

    expect(ctx.connections.create).toHaveBeenCalledWith(
      { userId: 'u1', workspaceId: 'w1' },
      expect.objectContaining({ name: 'demo_c', dialect: 'postgres', schema: 'demo_c' })
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ dialect: 'postgres', schema: 'demo_c', label: 'demo_c' })
    );
  }, 30_000);

  it('does not persist the connection when "No" is chosen', async () => {
    const ctx = { userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' }, connections: { create: vi.fn() }, history: {} };
    vi.spyOn(store, 'getContext').mockResolvedValue(ctx as any);
    const onSubmit = vi.fn();

    const { stdin } = render(<ConnectionFormScreen role="target" onSubmit={onSubmit} />);
    await wait();
    for (const v of ['t', 'mysql', 'h', '', 'db', 'u', '']) await type(stdin, v);
    await type(stdin, 'pw');

    stdin.write('\x1b[B'); // down arrow to "No, use it just for this session"
    await wait();
    stdin.write('\r');
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled(), { timeout: 10_000 });

    expect(ctx.connections.create).not.toHaveBeenCalled();
  }, 30_000);
});
