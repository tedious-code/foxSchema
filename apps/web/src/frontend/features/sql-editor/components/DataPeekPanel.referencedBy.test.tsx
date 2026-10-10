/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Referenced by": the reverse of the FK drill. The query itself is covered in
 * tablePreview.inbound.test.ts; what matters here is that the panel only offers
 * the affordance when it can actually build a correct query — a child whose
 * parent columns are missing from the grid must not get a button, because the
 * WHERE would then be built from a partial key.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { DataPeekPanel } from './DataPeekPanel';

vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/schemaApi')>();
  return { ...actual, fetchTableInsight: vi.fn().mockResolvedValue({}) };
});

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ connections: [{ id: 'c1', name: 'pg', dialect: 'postgres', schema: 'public' }] }),
}));

const baseEntry = {
  id: 'e1',
  title: 'public.customers',
  tableName: 'public.customers',
  baseSql: 'SELECT * FROM public.customers',
  baseParams: [] as unknown[],
  whereClause: '',
  orderByClause: '',
  limit: 50,
  pageIndex: 0,
  sql: 'SELECT * FROM public.customers',
  params: [] as unknown[],
  status: 'ready' as const,
  result: {
    ok: true as const,
    columns: ['id', 'name'],
    rows: [[1, 'Ada']],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
  },
};

/** `orders` and `invoices` both point at `customers`; `products` does not. */
const cache = {
  c1: {
    status: 'ready' as const,
    tables: [
      { name: 'customers', objectType: 'TABLE', columns: [], indices: [], foreignKeys: [] },
      {
        name: 'orders',
        objectType: 'TABLE',
        columns: [],
        indices: [],
        foreignKeys: [
          {
            name: 'fk_orders_customer',
            columns: ['customer_id'],
            referencedTable: 'customers',
            referencedSchema: 'public',
            referencedColumns: ['id'],
          },
        ],
      },
      {
        name: 'products',
        objectType: 'TABLE',
        columns: [],
        indices: [],
        foreignKeys: [
          {
            name: 'fk_prod_cat',
            columns: ['category_id'],
            referencedTable: 'categories',
            referencedSchema: 'public',
            referencedColumns: ['id'],
          },
        ],
      },
    ],
  },
};

const setPeek = (entry: typeof baseEntry, tables: unknown = cache) =>
  useSqlEditorStore.setState({
    dataPeek: { connectionId: 'c1', dialect: 'postgres', entries: [entry] },
    schemaCache: tables as never,
  });

describe('Data Peek · Referenced by', () => {
  beforeEach(() => setPeek(baseEntry));
  afterEach(() => useSqlEditorStore.setState({ dataPeek: null, schemaCache: {} }));

  it('offers the child that references this table', () => {
    render(<DataPeekPanel />);
    expect(screen.getByTestId('data-peek-refby-orders-fk_orders_customer')).toBeTruthy();
  });

  it('does not offer a table that references something else', () => {
    render(<DataPeekPanel />);
    // `products` → `categories`. Listing it would open a panel of rows that
    // have nothing to do with the customer row on screen.
    expect(screen.queryByTestId('data-peek-refby-products-fk_prod_cat')).toBeNull();
  });

  it('does not offer a same-named parent from another schema for a bare cache name', () => {
    setPeek(
      {
        ...baseEntry,
        title: 'products',
        tableName: 'products',
        baseSql: 'SELECT * FROM products',
        sql: 'SELECT * FROM products',
      },
      {
        c1: {
          status: 'ready',
          tables: [
            {
              name: 'products',
              objectType: 'TABLE',
              columns: [],
              indices: [],
              foreignKeys: [],
            },
            {
              name: 'orders',
              objectType: 'TABLE',
              columns: [],
              indices: [],
              foreignKeys: [
                {
                  name: 'fk_orders_inventory_product',
                  columns: ['product_id'],
                  referencedTable: 'products',
                  referencedSchema: 'inventory',
                  referencedColumns: ['id'],
                },
              ],
            },
          ],
        },
      }
    );

    render(<DataPeekPanel />);
    expect(screen.queryByTestId('data-peek-refby-orders-fk_orders_inventory_product')).toBeNull();
  });

  it('stays disabled until a row is selected', () => {
    render(<DataPeekPanel />);
    const btn = screen.getByTestId(
      'data-peek-refby-orders-fk_orders_customer'
    ) as HTMLButtonElement;
    // Without a selected row there is no value to match on; enabling it would
    // drill on `undefined`.
    expect(btn.disabled).toBe(true);
  });

  it('offers nothing when the grid lacks the referenced column', () => {
    // The FK matches on `customers.id`, but this projection selected only
    // `name` — a WHERE built from a missing value would match wrong rows.
    setPeek({
      ...baseEntry,
      result: { ...baseEntry.result, columns: ['name'], rows: [['Ada']] },
    });
    render(<DataPeekPanel />);
    expect(screen.queryByTestId('data-peek-refby-orders-fk_orders_customer')).toBeNull();
  });
});
