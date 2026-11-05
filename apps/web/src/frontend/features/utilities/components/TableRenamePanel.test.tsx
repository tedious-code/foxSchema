/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
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
import { TableRenamePanel } from './TableRenamePanel';

const orders: TableSchema = {
  name: 'orders',
  objectType: 'TABLE',
  columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
  primaryKey: { columns: ['id'] },
  indices: [],
  foreignKeys: [],
};

const items: TableSchema = {
  name: 'order_items',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'order_id', type: 'integer', nullable: false, primaryKey: false },
  ],
  primaryKey: { columns: ['id'] },
  indices: [],
  foreignKeys: [{ name: 'order_items_order_id_fkey', columns: ['order_id'], referencedTable: 'orders', referencedColumns: ['id'] }],
};

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('TableRenamePanel', () => {
  beforeEach(() => {
    useSqlEditorStore.setState({
      schemaCache: { pg: { status: 'ready', tables: [orders, items] } },
      ensureSchema: async () => undefined,
      ensureConnectionSelected: () => undefined,
    } as never);
  });

  it('shows the dialect rename and opens it in a new tab for this connection only', () => {
    const setActiveView = vi.spyOn(useUiStore.getState(), 'setActiveView');
    render(<TableRenamePanel lockedConnectionId="pg" />);
    pick('table-rename-table', 'orders');
    expect(screen.getByTestId('table-rename-hint')).toBeTruthy();
    pick('table-rename-new-name', 'sales_orders');

    expect(screen.getByTestId('table-rename-impact').textContent).toContain('order_items');
    expect(screen.getByTestId('table-rename-statement').textContent).toContain(
      'ALTER TABLE shop.orders RENAME TO sales_orders;'
    );

    const tabsBefore = useSqlEditorStore.getState().tabs.length;
    fireEvent.click(screen.getByTestId('table-rename-open-editor'));
    const editor = useSqlEditorStore.getState();
    const tab = editor.activeTab();
    expect(editor.tabs).toHaveLength(tabsBefore + 1);
    expect(tab.title).toBe('Rename orders');
    expect(tab.sql).toContain('ALTER TABLE shop.orders RENAME TO sales_orders;');
    expect(editor.activeConnectionIds()).toEqual(['pg']);
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
  });

  it('refuses a name that is already taken', () => {
    render(<TableRenamePanel lockedConnectionId="pg" />);
    pick('table-rename-table', 'orders');
    pick('table-rename-new-name', 'order_items');
    expect(screen.getByTestId('table-rename-refused').textContent).toMatch(/already exists/);
    expect(screen.queryByTestId('table-rename-sql')).toBeNull();
  });

  it('starts a new rename when another table is picked', () => {
    render(<TableRenamePanel lockedConnectionId="pg" />);
    pick('table-rename-table', 'orders');
    pick('table-rename-new-name', 'sales_orders');
    pick('table-rename-table', 'order_items');
    expect((screen.getByTestId('table-rename-new-name') as HTMLInputElement).value).toBe('');
  });
});
