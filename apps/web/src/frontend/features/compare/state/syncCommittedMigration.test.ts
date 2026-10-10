/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A committed plan runs from its commit — but only while it is still the plan
 * on screen. Change the selection after committing and the commit no longer
 * describes what would run, so Execute stops sending it.
 */
import { beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';

const executeMigration = vi.fn();
vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeMigration: (...args: unknown[]) => executeMigration(...args) };
});
vi.mock('@/app/store/useUiStore', () => ({
  useUiStore: { getState: () => ({ bumpLokeeEpoch: vi.fn() }) },
}));

import { useSyncStore } from './useSyncStore';
import { loadSqlGenerator } from './syncHelpers';
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

/** A second table, so skipping ORDERS still leaves a plan to run. */
const itemsDiff = { ...ordersDiff, tableName: 'ITEMS', sourceTable: { name: 'items', columns: [] } } as unknown as TableDiff;

const COMMIT = 'a'.repeat(40);
const ref = { repoId: 'r1', branch: 'main', commit: COMMIT, path: 'migrations/x.sql' };

/** The `git` argument of the last executeMigration call. */
const sentGit = () => executeMigration.mock.calls.at(-1)?.[4];

// These tests set a comparison by hand; the app loads the generator with the
// browse or compare that sets one.
beforeAll(async () => {
  await loadSqlGenerator();
});

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

  it("leaves the plan the user committed alone when a teammate's migration runs", async () => {
    useSyncStore.getState().setCommittedMigration(ref);
    await useSyncStore.getState().runCommittedMigration({ ...ref, path: 'migrations/theirs.sql' }, []);
    expect(useSyncStore.getState().committedMigration).toMatchObject(ref);
    expect(useSyncStore.getState().commitMatchesPlan()).toBe(true);
  });

  it('skip & retry after a commit does not run a plan nobody committed', async () => {
    useSyncStore.setState({ compareResult: { tables: [ordersDiff, itemsDiff] } as never, syncSelection: { ORDERS: true, ITEMS: true } });
    useSyncStore.getState().setCommittedMigration(ref);
    await useSyncStore.getState().skipObjectAndRetry('ORDERS');
    expect(executeMigration).not.toHaveBeenCalled();
    expect(useSyncStore.getState().syncSelection.ORDERS).toBe(false);
    // The commit is kept; it just no longer matches, so Execute asks for a new one.
    expect(useSyncStore.getState().committedMigration).toMatchObject(ref);
    expect(useSyncStore.getState().commitMatchesPlan()).toBe(false);
  });

  it('skip & retry without a commit re-runs at once', async () => {
    useSyncStore.setState({ compareResult: { tables: [ordersDiff, itemsDiff] } as never, syncSelection: { ORDERS: true, ITEMS: true } });
    await useSyncStore.getState().skipObjectAndRetry('ORDERS');
    expect(executeMigration).toHaveBeenCalledTimes(1);
    expect(sentGit()).toBeUndefined();
  });

  it('reports a refused run as not applied', async () => {
    executeMigration.mockRejectedValueOnce(new Error('Migrations must be committed to Git before they run on this install.'));
    const ok = await useSyncStore.getState().runCommittedMigration(ref, []);
    expect(ok).toBe(false);
    expect(useSyncStore.getState().migrationError).toMatch(/must be committed/);
  });
});

describe('the plan is built once per change', () => {
  it('is reused until a selection changes, and the commit check does not rebuild it', () => {
    const build = vi.spyOn(loadSqlGenerator.peek()!, 'generateMigrationPlan');
    try {
      const first = useSyncStore.getState().currentMigrationPlan();
      useSyncStore.getState().setCommittedMigration(ref);
      // The detail panel asks this on every render.
      for (let i = 0; i < 5; i++) expect(useSyncStore.getState().commitMatchesPlan()).toBe(true);
      expect(useSyncStore.getState().currentMigrationPlan()).toBe(first);
      expect(build).toHaveBeenCalledTimes(1);

      useSyncStore.getState().toggleColumnSelection('ORDERS', 'DROP_ME');
      expect(useSyncStore.getState().currentMigrationPlan()).not.toBe(first);
      expect(useSyncStore.getState().commitMatchesPlan()).toBe(false);
    } finally {
      build.mockRestore();
    }
  });
});

