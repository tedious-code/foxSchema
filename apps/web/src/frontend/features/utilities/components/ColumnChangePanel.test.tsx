import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableSchema } from '@/shared/lib/types';

const executeSql = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));

vi.mock('@/features/compare', () => {
  const state = { connections: [{ id: 'pg', name: 'Shop', dialect: 'postgres', schema: 'shop', hasPassword: true }] };
  const useSyncStore = (sel: (s: typeof state) => unknown) => sel(state);
  useSyncStore.getState = () => state;
  return { useSyncStore };
});

import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { ColumnChangePanel } from './ColumnChangePanel';

const orders: TableSchema = {
  name: 'orders',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false },
  ],
  primaryKey: { columns: ['id'] },
  indices: [{ name: 'orders_status_idx', columns: ['status'], unique: false }],
  foreignKeys: [],
};

const statusFn: TableSchema = {
  name: 'orders_status_label',
  objectType: 'FUNCTION',
  definition: 'SELECT status FROM orders WHERE id = $1',
  columns: [],
  indices: [],
  foreignKeys: [],
};

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('ColumnChangePanel', () => {
  beforeEach(() => {
    executeSql.mockReset();
    useSqlEditorStore.setState({
      schemaCache: { pg: { status: 'ready', tables: [orders, statusFn] } },
      ensureSchema: async () => undefined,
      ensureConnectionSelected: () => undefined,
    } as never);
  });

  it('shows what a type change touches and its steps, and opens them in a new tab for this connection only', () => {
    const setActiveView = vi.spyOn(useUiStore.getState(), 'setActiveView');
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    expect(screen.getByTestId('column-change-hint')).toBeTruthy();
    pick('column-change-new-type', 'varchar(40)');

    expect(screen.getByTestId('column-change-impact').textContent).toContain('orders_status_idx');
    expect(screen.getByTestId('column-change-impact').textContent).toContain('orders_status_label');
    expect(screen.getByTestId('column-change-part-add')).toBeTruthy();
    expect(screen.getByTestId('column-change-part-copy')).toBeTruthy();
    expect(screen.getByTestId('column-change-part-finish')).toBeTruthy();
    expect(screen.getAllByTestId(/^column-change-step-\d+$/)).toHaveLength(7);
    expect(screen.getByTestId('column-change-step-1').textContent).toContain(
      'ALTER TABLE "shop"."orders" ADD COLUMN IF NOT EXISTS "status__new" varchar(40);'
    );

    const tabsBefore = useSqlEditorStore.getState().tabs.length;
    fireEvent.click(screen.getByTestId('column-change-open-editor'));
    const editor = useSqlEditorStore.getState();
    const tab = editor.activeTab();
    expect(editor.tabs).toHaveLength(tabsBefore + 1);
    expect(tab.title).toBe('Change orders.status');
    expect(tab.sql.startsWith('-- Step 1: Add the new column status__new (varchar(40))\n')).toBe(true);
    expect(tab.sql).toContain('-- Step 7: Drop the old column status__old');
    // Only this connection: the steps belong to one database.
    expect(editor.activeConnectionIds()).toEqual(['pg']);
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
  });

  it('gives a rename alone as one step', () => {
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-name', 'state');
    expect(screen.getAllByTestId(/^column-change-step-\d+$/)).toHaveLength(1);
    expect(screen.getByTestId('column-change-step-1').textContent).toContain(
      'ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";'
    );
  });

  it('says why when the change is refused', () => {
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'id');
    pick('column-change-new-type', 'bigint');
    expect(screen.getByTestId('column-change-refused').textContent).toMatch(/primary key column/);
    expect(screen.queryByTestId('column-change-steps')).toBeNull();
  });

  it('runs the add-column part against this connection', async () => {
    useSqlEditorStore.setState({ safeMode: false } as never);
    executeSql.mockResolvedValue({ results: [{ ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }] });
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-type', 'varchar(40)');
    fireEvent.click(screen.getByTestId('column-change-run-add'));
    await waitFor(() => expect(executeSql).toHaveBeenCalled());
    expect(executeSql.mock.calls[0]![0]).toMatchObject({ connectionId: 'pg' });
    expect((executeSql.mock.calls[0]![1] as string[])[0]).toContain('ADD COLUMN IF NOT EXISTS "status__new"');
  });

  it('runs the copy part as a loop of one-batch patches and shows progress', async () => {
    useSqlEditorStore.setState({ safeMode: false } as never);
    const count = (n: number) => ({
      results: [{ ok: true, columns: ['n'], rows: [[n]], rowCount: 1, truncated: false, durationMs: 1 }],
    });
    const ok = { results: [{ ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }] };
    executeSql
      .mockResolvedValueOnce(ok) // sync trigger
      .mockResolvedValueOnce(count(10)) // total
      .mockResolvedValueOnce(count(10)) // remaining before
      .mockResolvedValueOnce(ok) // patch
      .mockResolvedValueOnce(count(0)) // remaining after
      .mockResolvedValueOnce(count(0)); // mismatch check
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-type', 'varchar(40)');
    expect(screen.getByTestId('column-change-step-3').textContent).toContain('DO $fox_copy$');
    fireEvent.click(screen.getByTestId('column-change-run-copy'));
    await waitFor(() => expect(screen.getByTestId('column-change-progress').textContent).toMatch(/10/));
    const sqlBatches = executeSql.mock.calls.map((c) => (c[1] as string[]).join('\n'));
    expect(sqlBatches.some((s) => s.includes('UPDATE "shop"."orders" SET "status__new"') && !s.includes('DO $fox_copy$'))).toBe(
      true
    );
    expect(sqlBatches.some((s) => s.includes('DO $fox_copy$'))).toBe(false);
  });

  it('starts a new change when another column is picked', () => {
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-name', 'state');
    pick('column-change-column', 'id');
    expect((screen.getByTestId('column-change-new-name') as HTMLInputElement).value).toBe('');
  });

  it('warns on a narrowing or incompatible type and requires acknowledgement before run', () => {
    useSqlEditorStore.setState({ safeMode: false } as never);
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-type', 'integer');
    expect(screen.getByTestId('column-change-conversion').textContent).toMatch(/text \(varchar\(20\)\) to a number \(integer\)/);
    expect((screen.getByTestId('column-change-run-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('column-change-run-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('column-change-confirm-lossy'));
    expect((screen.getByTestId('column-change-run-all') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('column-change-run-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns when shrinking a string and when converting text to boolean', () => {
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-type', 'varchar(5)');
    expect(screen.getByTestId('column-change-conversion').textContent).toMatch(/Narrowing varchar\(20\) to varchar\(5\)/);
    pick('column-change-new-type', 'boolean');
    expect(screen.getByTestId('column-change-conversion').textContent).toMatch(/text \(varchar\(20\)\) to boolean/);
  });

  it('executes all parts in order against this connection', async () => {
    useSqlEditorStore.setState({ safeMode: false } as never);
    const ok = { results: [{ ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }] };
    const count = (n: number) => ({
      results: [{ ok: true, columns: ['n'], rows: [[n]], rowCount: 1, truncated: false, durationMs: 1 }],
    });
    let remaining = 10;
    executeSql.mockImplementation((_opts: unknown, statements: string[]) => {
      const sql = statements.join('\n');
      if (/COUNT\(\*\) AS n/i.test(sql) && sql.includes('IS NULL')) return Promise.resolve(count(remaining));
      if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve(count(remaining > 0 ? 10 : 0));
      if (sql.includes('SET "status__new"')) remaining = 0;
      return Promise.resolve(ok);
    });
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-type', 'varchar(40)');
    fireEvent.click(screen.getByTestId('column-change-run-all'));
    await waitFor(() => expect(screen.getByTestId('column-change-run-status').textContent).toMatch(/All parts finished/));
    const batches = executeSql.mock.calls.map((c) => (c[1] as string[]).join('\n'));
    expect(batches.some((s) => s.includes('ADD COLUMN IF NOT EXISTS "status__new"'))).toBe(true);
    expect(batches.some((s) => s.includes('UPDATE "shop"."orders" SET "status__new"') && !s.includes('DO $fox_copy$'))).toBe(
      true
    );
    expect(batches.some((s) => s.includes('DROP COLUMN "status__old"'))).toBe(true);
    const addAt = batches.findIndex((s) => s.includes('ADD COLUMN IF NOT EXISTS "status__new"'));
    const dropAt = batches.findIndex((s) => s.includes('DROP COLUMN "status__old"'));
    expect(addAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(addAt);
  });
});
