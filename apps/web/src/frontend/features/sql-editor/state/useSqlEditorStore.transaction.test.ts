/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One transaction batches plain SQL into a single execute. A code cell or an
 * @set stays on the statement loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSql = vi.hoisted(() => vi.fn());
const runCodeCell = vi.hoisted(() =>
  vi.fn(async () => ({
    result: { ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 },
    directives: [],
  })),
);

vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));
vi.mock('@/shared/api/appSecretsApi', () => ({
  resolveAppSecrets: async () => ({ secrets: {}, errors: {} }),
}));
vi.mock('@/features/sql-editor/lib/codeCellRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/sql-editor/lib/codeCellRunner')>();
  return { ...actual, runCodeCell };
});

import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from './useSqlEditorStore';
import { createTab } from './sqlEditorTabLogic';

const ok = (n: number) => ({
  ok: true as const,
  columns: ['n'],
  rows: [[n]],
  rowCount: 1,
  truncated: false,
  durationMs: 1,
});

async function arm(sql: string, checked: number[], dialect = 'sqlite') {
  await useSqlEditorStore.persist.rehydrate();
  const tab = createTab({
    id: 't1',
    title: 'Batch',
    sql,
    checkedStatements: checked,
    selectedConnectionIds: ['c1'],
  });
  useSyncStore.setState({
    // A stored password, so a server engine runs without asking for one.
    connections: [{ id: 'c1', name: 'Lite', dialect, hasPassword: true } as never],
  });
  useSqlEditorStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    oneTransaction: true,
    shareDestinations: false,
    sharedConnectionIds: [],
    safeMode: true,
    runningTabId: null,
    variables: [],
    resultsByTab: {},
  });
  return tab.id;
}

describe('SQL editor one transaction', () => {
  beforeEach(() => {
    executeSql.mockReset();
    runCodeCell.mockClear();
  });

  it('sends every plain statement in one call', async () => {
    executeSql.mockResolvedValue({ results: [ok(1), ok(2)] });
    const tabId = await arm('SELECT 1;\nSELECT 2;', [0, 1]);
    await useSqlEditorStore.getState().execute();
    expect(executeSql).toHaveBeenCalledTimes(1);
    const statements = executeSql.mock.calls[0]![1] as string[];
    expect(statements).toHaveLength(2);
    expect(statements.join('\n')).toMatch(/SELECT 1/);
    expect(statements.join('\n')).toMatch(/SELECT 2/);
    expect(executeSql.mock.calls[0]![5]).toEqual({ transaction: true, stopOnError: true });
    expect(useSqlEditorStore.getState().runningTabId).toBeNull();
    expect(useSqlEditorStore.getState().resultsByTab[tabId]?.runs[0]?.status).toBe('done');
  });

  it('does not batch a single statement', async () => {
    executeSql.mockResolvedValue({ results: [ok(1)] });
    await arm('SELECT 1;', []);
    await useSqlEditorStore.getState().execute();
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(executeSql.mock.calls[0]![5]).toBeUndefined();
  });

  it('keeps a code cell and an @set on the statement loop', async () => {
    executeSql.mockResolvedValue({ results: [ok(1)] });
    const codeTab = await arm('SELECT 1;\n-- @js\nreturn [];\n-- @end', [0, 1]);
    await useSqlEditorStore.getState().execute();
    expect(executeSql.mock.calls.every((call) => call[5] === undefined || !(call[5] as { transaction?: boolean }).transaction)).toBe(true);
    expect(runCodeCell).toHaveBeenCalled();
    expect(useSqlEditorStore.getState().resultsByTab[codeTab]?.warnings?.join('\n')).toMatch(/One transaction/);

    executeSql.mockClear();
    runCodeCell.mockClear();
    const setTab = await arm('-- @set name = table\nSELECT 1;\nSELECT 2;', [0, 1]);
    await useSqlEditorStore.getState().execute();
    expect(executeSql.mock.calls.length).toBeGreaterThan(0);
    expect(executeSql.mock.calls.every((call) => !(call[5] as { transaction?: boolean } | undefined)?.transaction)).toBe(true);
    expect(useSqlEditorStore.getState().resultsByTab[setTab]?.warnings?.join('\n')).toMatch(/One transaction/);
  });

  it('fills a row for each statement the transaction did not run', async () => {
    executeSql.mockResolvedValue({ results: [{ ok: false, error: 'nope', durationMs: 1 }] });
    const tabId = await arm('SELECT 1;\nSELECT 2;', [0, 1]);
    await useSqlEditorStore.getState().execute();
    const results = useSqlEditorStore.getState().resultsByTab[tabId]?.runs[0]?.results ?? [];
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[1] && !results[1].ok ? results[1].error : '').toMatch(/rolled back/);
  });

  it('runs a batch that steers its own transaction statement by statement, and says why', async () => {
    // Wrapped, its COMMIT would make what ran before it permanent and a later
    // failure would roll back nothing — while the panel reported a rollback.
    executeSql.mockResolvedValue({ results: [ok(1)] });
    const tabId = await arm('INSERT INTO t VALUES (1);\nCOMMIT;\nINSERT INTO t VALUES (2);', [0, 1, 2]);
    await useSqlEditorStore.getState().execute();
    expect(executeSql.mock.calls.length).toBe(3);
    expect(executeSql.mock.calls.every((call) => !(call[5] as { transaction?: boolean } | undefined)?.transaction)).toBe(true);
    expect(useSqlEditorStore.getState().resultsByTab[tabId]?.warnings?.join('\n')).toMatch(/BEGIN, COMMIT or ROLLBACK/);
  });

  it('runs statement by statement on an engine with no transactions, and says why', async () => {
    // ClickHouse commits each statement as it runs; wrapped, a failure would
    // leave the earlier ones in place while the panel reported a rollback.
    executeSql.mockResolvedValue({ results: [ok(1)] });
    const tabId = await arm('INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);', [0, 1], 'clickhouse');
    await useSqlEditorStore.getState().execute();
    expect(executeSql.mock.calls.length).toBe(2);
    expect(executeSql.mock.calls.every((call) => !(call[5] as { transaction?: boolean } | undefined)?.transaction)).toBe(true);
    expect(useSqlEditorStore.getState().resultsByTab[tabId]?.warnings?.join('\n')).toMatch(/ClickHouse transactions are experimental/);
  });

  it('puts the missing MongoDB transaction on Fox Schema, not on MongoDB', async () => {
    // MongoDB has transactions on a replica set; the adapter does not open one.
    // "MongoDB has no transactions" sent readers to the wrong place.
    executeSql.mockResolvedValue({ results: [ok(1)] });
    const tabId = await arm('INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);', [0, 1], 'mongodb');
    await useSqlEditorStore.getState().execute();
    const warnings = useSqlEditorStore.getState().resultsByTab[tabId]?.warnings?.join('\n') ?? '';
    expect(warnings).toMatch(/Fox Schema writes to MongoDB without a transaction/);
    expect(warnings).not.toMatch(/MongoDB has no transactions/);
  });

  it('still batches savepoints, which stay inside the transaction', async () => {
    executeSql.mockResolvedValue({ results: [ok(1), ok(2), ok(3)] });
    await arm('SAVEPOINT s1;\nINSERT INTO t VALUES (1);\nROLLBACK TO SAVEPOINT s1;', [0, 1, 2]);
    await useSqlEditorStore.getState().execute();
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(executeSql.mock.calls[0]![5]).toEqual({ transaction: true, stopOnError: true });
  });
});
