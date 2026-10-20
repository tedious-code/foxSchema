/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data migrate's Transaction checkbox on a destination that cannot roll back.
 *
 * It defaulted on everywhere, under a tooltip promising that Stop rolls back
 * the whole batch. Redis, MongoDB and ClickHouse open no transaction — their
 * adapters' ROLLBACK does nothing — so a Redis → Redis migrate ran "in a
 * transaction" and a mid-batch failure would have left the earlier rows
 * written. The box is off and disabled there now, and Apply does not ask the
 * server for what it would refuse.
 */
import React, { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TableSchema } from '@/shared/lib/types';

const apiExecuteDataMigrate = vi.fn();

vi.mock('@/features/sql-editor/api/dataMigrateApi', () => ({
  apiExecuteDataMigrate: (...args: unknown[]) => apiExecuteDataMigrate(...args),
  apiStartDataMigrate: vi.fn(async () => ({ id: 'run-1', snapshotStored: true })),
  apiFinishDataMigrate: vi.fn(async () => undefined),
  apiListDataMigrations: vi.fn(async () => []),
  apiGetDataMigration: vi.fn(async () => null),
}));

vi.mock('@/platform/toastStore', () => ({ toast: vi.fn() }));

vi.mock('@/platform/authStore', () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ can: () => true }),
}));

const users: TableSchema = {
  name: 'users',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'name', type: 'text', nullable: true, primaryKey: false },
  ],
  indices: [],
  foreignKeys: [],
  primaryKey: { columns: ['id'] },
};

const editorState = {
  sessionPasswords: {},
  safeMode: false,
  schemaCache: { dest: { status: 'ready', tables: [users] } },
  ensureSchema: vi.fn(),
};

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => {
  const useSqlEditorStore = (sel: (s: typeof editorState) => unknown) => sel(editorState);
  useSqlEditorStore.getState = () => editorState;
  return { useSqlEditorStore };
});

vi.mock('@/features/compare', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      connections: [
        { id: 'src', name: 'src', dialect: 'redis', host: 'a' },
        { id: 'dest', name: 'dest', dialect: 'redis', host: 'b' },
      ],
    }),
}));

import { DataMigrateBar, type DataMigrateGrid } from './DataMigrateBar';

const grid = (connectionId: string, dialect: string, rows: unknown[][]): DataMigrateGrid => ({
  connectionId,
  dialect,
  label: connectionId,
  columns: ['id', 'name'],
  rows,
  statementSql: 'SELECT id, name FROM users',
});

/** Holds the Sync selection the way ResultsPanel does, so Apply has rows to send. */
function Harness({ destDialect }: { destDialect: string }) {
  const [keyNames, setKeyNames] = useState(['id']);
  const [synced, setSynced] = useState<Set<string>>(new Set());
  return (
    <DataMigrateBar
      statementIndex={0}
      source={grid('src', destDialect, [
        [1, 'a'],
        [2, 'b'],
      ])}
      dest={grid('dest', destDialect, [[1, 'a']])}
      keyNames={keyNames}
      onKeyNamesChange={setKeyNames}
      selectedSyncKeys={synced}
      onSelectedSyncKeysChange={setSynced}
    />
  );
}

const txBox = () => screen.getByTestId('sql-data-migrate-tx-0') as HTMLInputElement;

describe('Data migrate Transaction checkbox', () => {
  beforeEach(() => {
    apiExecuteDataMigrate.mockReset();
    apiExecuteDataMigrate.mockResolvedValue({
      results: [{ op: 'insert', key: 'id=2', status: 'SUCCESS' }],
      rolledBack: false,
      failCount: 0,
    });
  });

  it.each(['redis', 'mongodb', 'clickhouse'])(
    'is off and disabled on %s, and says why',
    (dialect) => {
      render(<Harness destDialect={dialect} />);

      expect(txBox().checked).toBe(false);
      expect(txBox().disabled).toBe(true);
      // The reason replaces the tooltip that promised a rollback.
      const title = txBox().closest('label')!.getAttribute('title') ?? '';
      expect(title).toMatch(/rows written before it in place/);
      expect(title).not.toMatch(/rolls back/);
    }
  );

  it('stays on, and can be turned off, where the destination rolls back', () => {
    render(<Harness destDialect="postgres" />);

    expect(txBox().checked).toBe(true);
    expect(txBox().disabled).toBe(false);
    fireEvent.click(txBox());
    expect(txBox().checked).toBe(false);
  });

  it('gives the choice back when the destination changes to one that rolls back', () => {
    // Shown as off on Redis, not stored as off: the user never chose that.
    const { rerender } = render(<Harness destDialect="redis" />);
    expect(txBox().checked).toBe(false);

    rerender(<Harness destDialect="postgres" />);
    expect(txBox().checked).toBe(true);
  });

  it('does not ask the server for a transaction on Redis', async () => {
    // The server refuses useTransaction: true there. Sending it was the bug's
    // other half: with nothing refusing it, the run "succeeded in a
    // transaction" that would not have rolled anything back.
    render(<Harness destDialect="redis" />);
    fireEvent.click(screen.getByTestId('sql-data-migrate-apply-0'));

    await waitFor(() => expect(apiExecuteDataMigrate).toHaveBeenCalledTimes(1));
    expect(apiExecuteDataMigrate.mock.calls[0]![2]).toMatchObject({ useTransaction: false });
  });

  it('still asks for one where the destination rolls back', async () => {
    render(<Harness destDialect="postgres" />);
    fireEvent.click(screen.getByTestId('sql-data-migrate-apply-0'));

    await waitFor(() => expect(apiExecuteDataMigrate).toHaveBeenCalledTimes(1));
    expect(apiExecuteDataMigrate.mock.calls[0]![2]).toMatchObject({ useTransaction: true });
  });
});

describe('Restore backup on a destination that cannot roll back', () => {
  type Op = { op: string; key: string };
  /** The first op succeeds and the rest fail, without a rollback. */
  const firstSucceeds = async (_target: unknown, ops: Op[]) => ({
    results: ops.map((o, i) => ({
      op: o.op,
      key: o.key,
      status: i === 0 ? 'SUCCESS' : 'FAILED',
      error: i === 0 ? undefined : 'boom',
    })),
    rolledBack: false,
    failCount: ops.length - 1,
  });

  /** Two edits, so Restore can put the first one back from the snapshot. */
  function TwoEditHarness() {
    const [keyNames, setKeyNames] = useState(['id']);
    const [synced, setSynced] = useState<Set<string>>(new Set());
    return (
      <DataMigrateBar
        statementIndex={0}
        source={grid('src', 'redis', [
          [1, 'a2'],
          [2, 'b2'],
        ])}
        dest={grid('dest', 'redis', [
          [1, 'a'],
          [2, 'b'],
        ])}
        keyNames={keyNames}
        onKeyNamesChange={setKeyNames}
        selectedSyncKeys={synced}
        onSelectedSyncKeysChange={setSynced}
      />
    );
  }

  beforeEach(() => {
    apiExecuteDataMigrate.mockReset();
  });

  it('runs without a transaction, and does not call a part-restore a restore', async () => {
    // Restore always asked for a transaction. On Redis that was the same
    // empty promise as the migrate's, and the server now refuses it, so the
    // one recovery path left after a failed Redis migrate would have 400'd.
    apiExecuteDataMigrate.mockImplementation(firstSucceeds);
    const { toast } = await import('@/platform/toastStore');

    render(<TwoEditHarness />);
    fireEvent.click(screen.getByTestId('sql-data-migrate-apply-0'));
    await screen.findByTestId('sql-data-migrate-restore-0');

    // One edit went in before the failure; putting it back fails too.
    apiExecuteDataMigrate.mockImplementation(async (_target: unknown, ops: Op[]) => ({
      results: ops.map((o) => ({ op: o.op, key: o.key, status: 'FAILED', error: 'boom' })),
      rolledBack: false,
      failCount: ops.length,
    }));
    fireEvent.click(screen.getByTestId('sql-data-migrate-restore-0'));

    await waitFor(() => expect(apiExecuteDataMigrate).toHaveBeenCalledTimes(2));
    expect(apiExecuteDataMigrate.mock.calls[1]![2]).toMatchObject({ useTransaction: false });

    await waitFor(() =>
      expect(vi.mocked(toast).mock.calls.at(-1)?.[0].title).toMatch(/Restore finished with 1 failure/)
    );
    const body = vi.mocked(toast).mock.calls.at(-1)![0].body as string;
    expect(body).toMatch(/Reversed 0 of 1 ops before stopping/);
    expect(body).not.toMatch(/rolled back|Reversed successful/i);
  });
});
