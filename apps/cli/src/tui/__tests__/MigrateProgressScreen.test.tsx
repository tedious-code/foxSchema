import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import * as engine from '../../runtime/engine';
import * as store from '../../runtime/store';
import { MigrateProgressScreen } from '../screens/MigrateProgressScreen';
import type { ConnRef } from '../types';

// A real (not setTimeout(0)) delay for the one wait that isn't checkable via vi.waitFor:
// after the terminal outcome is already rendered, SelectInput still needs a tick to
// attach its own input listener before it can receive a keypress.
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

const source: ConnRef = { dialect: 'postgres', option: {}, schema: 'demo_c', label: 'demo_c' };
const target: ConnRef = { dialect: 'postgres', option: {}, schema: 'demo_d', label: 'demo_d' };

const ONE_ADDED = {
  summary: { added: 1, removed: 0, modified: 0, unchanged: 0 },
  tables: [{ tableName: 'WAREHOUSES', objectType: 'TABLE', status: 'ADDED', columnDiffs: [], indexDiffs: [], foreignKeyDiffs: [] }],
};

function stubCommon() {
  vi.spyOn(engine, 'loadScopedTables').mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  vi.spyOn(engine.compareModule, 'compare').mockResolvedValueOnce(ONE_ADDED as any);
  vi.spyOn(engine.sqlGenerator, 'generateMigrationPlan').mockReturnValue([{ objectName: 'WAREHOUSES', objectType: 'TABLE', action: 'CREATE', statements: [] }] as any);
  vi.spyOn(engine.sqlGenerator, 'generateMigrationSql').mockReturnValue('CREATE TABLE WAREHOUSES (id INT);');
  vi.spyOn(engine.connectionModule, 'getProvider').mockReturnValue({ getTables: vi.fn().mockResolvedValue([]) } as any);
  vi.spyOn(store, 'getContext').mockResolvedValue({
    userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
    history: { start: vi.fn().mockResolvedValue('run1'), finish: vi.fn().mockResolvedValue(undefined) },
  } as any);
}

describe('MigrateProgressScreen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a clean success outcome and offers to view history', async () => {
    stubCommon();
    vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'object', objectName: 'WAREHOUSES', objectType: 'TABLE', action: 'CREATE', status: 'SUCCESS' });
      send({ type: 'done', success: true, rolledBack: false });
    });

    const { lastFrame } = render(
      <MigrateProgressScreen source={source} target={target} continueOnError={false} onViewHistory={() => {}} onDone={() => {}} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('Migration applied'));

    expect(lastFrame()).toContain('View in history');
  });

  it('shows a partial-success outcome with the failure count', async () => {
    stubCommon();
    vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'object', objectName: 'WAREHOUSES', objectType: 'TABLE', action: 'CREATE', status: 'FAILED', error: 'boom' });
      send({ type: 'done', success: true, rolledBack: false });
    });

    const { lastFrame } = render(
      <MigrateProgressScreen source={source} target={target} continueOnError={true} onViewHistory={() => {}} onDone={() => {}} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('1 failure(s)'), { timeout: 10_000 });

    expect(lastFrame()).toContain('boom');
  });

  it('shows a failed outcome without a "view history" option when history.start never returned a run id', async () => {
    stubCommon();
    vi.spyOn(store, 'getContext').mockResolvedValue({
      userId: 'u1', scope: { userId: 'u1', workspaceId: 'w1' },
      history: { start: vi.fn().mockRejectedValue(new Error('history unavailable')), finish: vi.fn() },
    } as any);
    vi.spyOn(engine.migrationModule, 'execute').mockRejectedValue(new Error('connection lost'));

    const { lastFrame } = render(
      <MigrateProgressScreen source={source} target={target} continueOnError={false} onViewHistory={() => {}} onDone={() => {}} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('Migration failed'));

    expect(lastFrame()).toContain('connection lost');
    expect(lastFrame()).not.toContain('View in history');
  });

  it('calls onDone when "Back to start" is chosen', async () => {
    stubCommon();
    vi.spyOn(engine.migrationModule, 'execute').mockImplementation(async (_d, _o, _s, _steps, send: any) => {
      send({ type: 'done', success: true, rolledBack: false });
    });
    const onDone = vi.fn();

    const { stdin, lastFrame } = render(
      <MigrateProgressScreen source={source} target={target} continueOnError={false} onViewHistory={() => {}} onDone={onDone} />
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('Back to start'));
    await wait();

    stdin.write('\x1b[B'); // down to "Back to start"
    await wait();
    stdin.write('\r');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
