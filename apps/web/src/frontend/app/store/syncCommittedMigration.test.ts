/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A committed plan runs from its commit — but only while it is still the plan
 * on screen. Change the selection after committing and the commit no longer
 * describes what would run, so Execute stops sending it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const executeMigration = vi.fn();
vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeMigration: (...args: unknown[]) => executeMigration(...args) };
});
vi.mock('@/app/store/useUiStore', () => ({
  useUiStore: { getState: () => ({ bumpLokeeEpoch: vi.fn() }) },
}));

import { useSyncStore } from './useSyncStore';
import type { TableDiff } from '@/shared/lib/types';

const col = (name: string) =>
  ({ name, status: 'ADDED', source: { name: name.toLowerCase(), type: 'text', nullable: true } }) as TableDiff['columnDiffs'][number];

const ordersDiff = {
  tableName: 'ORDERS',
  status: 'MODIFIED',
  objectType: 'TABLE',
  columnDiffs: [col('KEEP_ME'), col('DROP_ME')],
  indexDiffs: [],
  foreignKeyDiffs: [],
  triggerDiffs: [],
  sourceTable: { name: 'orders', columns: [] },
} as unknown as TableDiff;

const COMMIT = 'a'.repeat(40);
const ref = { repoId: 'r1', branch: 'main', commit: COMMIT, path: 'migrations/x.sql' };

/** The `git` argument of the last executeMigration call. */
const sentGit = () => executeMigration.mock.calls.at(-1)?.[4];

beforeEach(() => {
  executeMigration.mockReset();
  // Report success, so the store treats the run as done.
  executeMigration.mockImplementation(async (_ref, _plan, onEvent: (e: unknown) => void) => {
    onEvent({ type: 'done', success: true, rolledBack: false });
  });
  useSyncStore.setState({
    compareResult: { tables: [ordersDiff] } as never,
    syncSelection: { ORDERS: true },
    memberSelection: {},
    indexSelection: {},
    columnSelection: {},
    triggerSelection: {},
    sourceConfig: { dialect: 'postgres', schema: 'public' } as never,
    targetConfig: { dialect: 'postgres', schema: 'public' } as never,
    nonDestructive: false,
    committedMigration: null,
    runSchemaComparison: vi.fn(async () => undefined),
  });
});

describe('committed migrations', () => {
  it('runs a committed, unchanged plan from its commit, then forgets the commit', async () => {
    useSyncStore.getState().setCommittedMigration(ref);
    expect(useSyncStore.getState().commitMatchesPlan()).toBe(true);
    await useSyncStore.getState().applyMigration();
    expect(sentGit()).toEqual(ref);
    expect(useSyncStore.getState().committedMigration).toBeNull();
  });

  it('stops using the commit once the plan changes', async () => {
    useSyncStore.getState().setCommittedMigration(ref);
    useSyncStore.getState().toggleColumnSelection('ORDERS', 'DROP_ME');
    expect(useSyncStore.getState().commitMatchesPlan()).toBe(false);
    await useSyncStore.getState().applyMigration();
    expect(sentGit()).toBeUndefined();
  });

  it("runs a teammate's committed migration with its own steps and commit", async () => {
    const steps = [{ action: 'CREATE' as const, objectType: 'TABLE' as const, objectName: 'invoices', statements: ['CREATE TABLE invoices (id int)'] }];
    const ok = await useSyncStore.getState().runCommittedMigration(ref, steps);
    expect(ok).toBe(true);
    const [, plan, , , git] = executeMigration.mock.calls.at(-1)!;
    expect(plan).toEqual(steps);
    expect(git).toEqual(ref);
  });

  it('reports a refused run as not applied', async () => {
    executeMigration.mockRejectedValueOnce(new Error('Migrations must be committed to Git before they run on this install.'));
    const ok = await useSyncStore.getState().runCommittedMigration(ref, []);
    expect(ok).toBe(false);
    expect(useSyncStore.getState().migrationError).toMatch(/must be committed/);
  });
});
