/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { DataPeekPanel } from './DataPeekPanel';

const fetchTableInsight = vi.fn();
vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/schemaApi')>();
  return {
    ...actual,
    fetchTableInsight: (...args: unknown[]) => fetchTableInsight(...args),
  };
});

const entry = {
  id: 'e1',
  title: 'public.orders',
  tableName: 'public.orders',
  baseSql: 'SELECT * FROM public.orders',
  baseParams: [] as unknown[],
  whereClause: '',
  orderByClause: '',
  limit: 50,
  pageIndex: 0,
  sql: 'SELECT * FROM public.orders',
  params: [] as unknown[],
  status: 'ready' as const,
  result: {
    ok: true as const,
    columns: ['id'],
    rows: [[1]],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
  },
};

describe('DataPeekPanel Insight tab', () => {
  beforeEach(() => {
    fetchTableInsight.mockReset();
    fetchTableInsight.mockResolvedValue({
      table: 'orders',
      schema: 'public',
      estimatedRows: 10,
      columns: [{ name: 'id', nDistinct: 10, nullFrac: 0 }],
      mode: 'catalog',
      support: { mode: 'catalog', query: true, hint: '' },
    });
    useSqlEditorStore.setState({
      dataPeek: {
        connectionId: 'c1',
        dialect: 'postgres',
        entries: [entry],
      },
    });
  });

  afterEach(() => {
    useSqlEditorStore.setState({ dataPeek: null });
  });

  it('does not fetch catalog insight until the Insight tab is selected', async () => {
    render(<DataPeekPanel />);
    expect(screen.getByTestId('data-peek')).toBeTruthy();
    expect(screen.queryByTestId('data-peek-insight')).toBeNull();
    expect(fetchTableInsight).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('data-peek-tab-insight-e1'));
    await waitFor(() => expect(fetchTableInsight).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('data-peek-insight')).toBeTruthy();
  });
});

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ connections: [{ id: 'c1', name: 'pg', dialect: 'postgres', schema: 'public' }] }),
}));

describe('reference keys on a qualified table name', () => {
  // An FK drill opens the next panel with `demo_a.customers`, while the schema
  // cache holds tables bare as `customers`. The panel used to give up on any
  // name containing a dot, so the second peek in a chain lost its reference
  // keys — every FK cell rendered as plain text with nothing to click.
  const withFk = {
    ...entry,
    id: 'e2',
    title: 'public.orders',
    tableName: 'public.orders',
    result: {
      ok: true as const,
      columns: ['id', 'customer_id'],
      rows: [[1, 7]],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    },
  };

  const cache = {
    c1: {
      status: 'ready' as const,
      tables: [
        {
          name: 'orders',
          objectType: 'TABLE',
          columns: [],
          indices: [],
          foreignKeys: [
            {
              name: 'orders_customer_id_fkey',
              columns: ['customer_id'],
              referencedTable: 'customers',
              referencedSchema: 'public',
              referencedColumns: ['id'],
            },
          ],
        },
      ],
    },
  };

  beforeEach(() => {
    useSqlEditorStore.setState({
      dataPeek: { connectionId: 'c1', dialect: 'postgres', entries: [withFk] },
      schemaCache: cache as never,
    });
  });

  afterEach(() => {
    useSqlEditorStore.setState({ dataPeek: null, schemaCache: {} });
  });

  it('finds the table behind a schema-qualified name', () => {
    render(<DataPeekPanel />);
    // The foreign-key hint renders only when linkColumns is non-empty, so it
    // is a direct readout of whether the panel resolved its table and found
    // the keys — unlike the cell itself, which looks similar either way.
    expect(screen.getByText(/foreign keys/i)).toBeTruthy();
  });

  it('refuses a qualifier that is not the connection schema', () => {
    // `inventory.orders` while connected to `public` is a different table.
    // Matching it on the bare name would hand row edits the wrong PK.
    useSqlEditorStore.setState({
      dataPeek: {
        connectionId: 'c1',
        dialect: 'postgres',
        entries: [{ ...withFk, tableName: 'inventory.orders' }],
      },
    });
    render(<DataPeekPanel />);
    expect(screen.queryByText(/foreign keys/i)).toBeNull();
  });
});
