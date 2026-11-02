import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableSchema } from '@/shared/lib/types';

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

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('ColumnChangePanel', () => {
  beforeEach(() => {
    useSqlEditorStore.setState({
      schemaCache: { pg: { status: 'ready', tables: [orders] } },
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

  it('starts a new change when another column is picked', () => {
    render(<ColumnChangePanel lockedConnectionId="pg" />);
    pick('column-change-table', 'orders');
    pick('column-change-column', 'status');
    pick('column-change-new-name', 'state');
    pick('column-change-column', 'id');
    expect((screen.getByTestId('column-change-new-name') as HTMLInputElement).value).toBe('');
  });
});
