/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Comparing an engine that has no schema must not reach the generator.
 *
 * The first version of this feature disabled the Schema Sync *tab* and stopped
 * there. That guarded nothing: `activeView` already defaults to `sync`, so
 * nobody has to press the tab to get to Compare, and `runSchemaComparison`
 * itself had no check. A Redis connection still reached
 * `generateMigrationSql`, where `resolveDialect` answers Db2 for a name it does
 * not know — so the run produced Db2 DDL and nothing said so.
 *
 * The button is disabled now, but a selection can outlive the check that
 * produced it, so this pins the store as the last line.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const compareSchemas = vi.fn();
vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, compareSchemas: (...a: unknown[]) => compareSchemas(...a) };
});
vi.mock('@/app/store/useUiStore', () => ({
  useUiStore: { getState: () => ({ setSyncPane: vi.fn(), bumpLokeeEpoch: vi.fn() }) },
}));
vi.mock('@/shared/components/toast', () => ({ toast: vi.fn() }));

import { useSyncStore } from './useSyncStore';
import { loadSqlGenerator } from './sync-helpers';

const config = (dialect: string) =>
  ({ dialect, schema: 'public', option: {}, connectionId: '' }) as never;

function setup(source: string, target: string) {
  useSyncStore.setState({
    sourceConfig: config(source),
    targetConfig: config(target),
    sourceConnected: true,
    targetConnected: true,
    selectedObjectTypes: ['TABLE'] as never,
    errorMsg: null,
    isComparing: false,
    compareResult: null,
  });
}

beforeEach(() => {
  compareSchemas.mockReset();
  compareSchemas.mockResolvedValue({ tables: [], warnings: [] });
});

describe('the compare action refuses an engine with no schema', () => {
  it('never calls the API for a Redis source', async () => {
    setup('redis', 'postgres');
    await useSyncStore.getState().runSchemaComparison();
    expect(compareSchemas).not.toHaveBeenCalled();
    expect(useSyncStore.getState().errorMsg).toMatch(/Redis has no schema/i);
  });

  it('checks the target too, not only the source', async () => {
    // The source is comparable; the target is what would receive the DDL.
    setup('postgres', 'mongodb');
    await useSyncStore.getState().runSchemaComparison();
    expect(compareSchemas).not.toHaveBeenCalled();
    expect(useSyncStore.getState().errorMsg).toMatch(/Target: MongoDB has no schema/i);
  });

  it('refuses an engine nobody registered rather than falling back to Db2', async () => {
    setup('dynamodb', 'postgres');
    await useSyncStore.getState().runSchemaComparison();
    expect(compareSchemas).not.toHaveBeenCalled();
    // Asserting the message, not just the absent call: without the guard the
    // run still dies later in loadSchemaList, so "no call" alone passes for
    // the wrong reason. Only the guard names the engine.
    expect(useSyncStore.getState().errorMsg).toMatch(/does not know dynamodb/i);
  });

  it('leaves isComparing false so the button is not stuck', async () => {
    setup('redis', 'postgres');
    await useSyncStore.getState().runSchemaComparison();
    expect(useSyncStore.getState().isComparing).toBe(false);
    expect(useSyncStore.getState().errorMsg).toMatch(/Redis/);
  });

  it('still runs for two engines that can be compared', async () => {
    setup('postgres', 'mysql');
    await useSyncStore.getState().runSchemaComparison();
    expect(compareSchemas).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().errorMsg).toBeNull();
  });
});

describe('the migration generator loads with the comparison', () => {
  it('is ready by the time a comparison is shown', async () => {
    // (That it is absent from the first page is the first-load budget's job.)
    setup('postgres', 'postgres');
    const added = {
      tableName: 'ORDERS',
      status: 'ADDED',
      objectType: 'TABLE',
      columnDiffs: [{ name: 'ID', status: 'ADDED', source: { name: 'id', type: 'integer', nullable: false } }],
      indexDiffs: [],
      foreignKeyDiffs: [],
      triggerDiffs: [],
      sourceTable: { name: 'orders', columns: [{ name: 'id', type: 'integer', nullable: false }], indices: [], foreignKeys: [] },
    };
    compareSchemas.mockResolvedValue({ tables: [added], warnings: [] });
    await useSyncStore.getState().runSchemaComparison();
    const state = useSyncStore.getState();
    expect(state.errorMsg).toBeNull();
    expect(state.compareResult?.tables).toHaveLength(1);
    expect(typeof state.generatedSql).toBe('string');
    // A toggle right after regenerates synchronously, which needs the generator.
    useSyncStore.getState().toggleSyncSelection('ORDERS');
    expect(useSyncStore.getState().generatedSql).toMatch(/CREATE TABLE/i);
    expect(loadSqlGenerator.peek()).toBeDefined();
  });
});

