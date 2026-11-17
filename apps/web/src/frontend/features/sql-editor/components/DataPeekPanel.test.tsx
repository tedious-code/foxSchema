/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { useSyncStore } from '@/features/compare';
import { effectiveConnectionIds } from '@/features/sql-editor/state/sqlEditorTabLogic';
import { DataPeekPanel, inlineBoundParams } from './DataPeekPanel';

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

  it('adds a second WHERE and a second ORDER BY', async () => {
    render(<DataPeekPanel />);
    fireEvent.click(screen.getByTestId('data-peek-where-add-e1'));
    fireEvent.change(screen.getByTestId('data-peek-where-e1'), { target: { value: "status = 'gold'" } });
    fireEvent.change(screen.getByTestId('data-peek-where-e1-1'), { target: { value: 'active = 1' } });
    fireEvent.click(screen.getByTestId('data-peek-order-add-e1'));
    fireEvent.change(screen.getByTestId('data-peek-order-e1'), { target: { value: 'created_at' } });
    fireEvent.change(screen.getByTestId('data-peek-order-dir-e1'), { target: { value: 'DESC' } });
    fireEvent.change(screen.getByTestId('data-peek-order-e1-1'), { target: { value: 'id' } });
    fireEvent.change(screen.getByTestId('data-peek-order-dir-e1-1'), { target: { value: 'ASC' } });
    fireEvent.click(screen.getByTestId('data-peek-apply-e1'));
    await waitFor(() => {
      const peek = useSqlEditorStore.getState().dataPeek;
      expect(peek?.entries[0]?.whereClause).toBe("status = 'gold' AND active = 1");
      expect(peek?.entries[0]?.orderByClause).toBe('created_at DESC, id ASC');
    });
  });

  it('gives its height to the grid, so filter rows never squeeze out the rows', () => {
    // With the height on the whole panel, two WHERE rows and two ORDER BY rows
    // took all of it: the grid showed its header and none of its rows.
    render(<DataPeekPanel />);
    fireEvent.click(screen.getByTestId('data-peek-where-add-e1'));
    fireEvent.click(screen.getByTestId('data-peek-order-add-e1'));
    expect(screen.getByTestId('data-peek-grid-e1').style.height).toBe('');
    expect(screen.getByTestId('data-peek-body-e1').style.height).toBe('260px');
  });
});

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
    useSyncStore.setState({
      connections: [{ id: 'c1', name: 'pg', dialect: 'postgres', schema: 'public', hasPassword: true }] as never,
    });
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

  it('inlines bound parameters across SQL dialects without LIMIT in openInSqlEditor', () => {
    expect(
      inlineBoundParams('SELECT * FROM "orders" WHERE "id" = $1 AND "customer" = $2', [42, "O'Connor"], 'postgres')
    ).toBe('SELECT * FROM "orders" WHERE "id" = 42 AND "customer" = \'O\'\'Connor\'');

    expect(
      inlineBoundParams('SELECT * FROM `orders` WHERE `id` = ? AND `customer` = ?', [10, 'Acme'], 'mysql')
    ).toBe("SELECT * FROM `orders` WHERE `id` = 10 AND `customer` = 'Acme'");

    expect(
      inlineBoundParams('SELECT * FROM [orders] WHERE [id] = @p0', [99], 'sqlserver')
    ).toBe('SELECT * FROM [orders] WHERE [id] = 99');

    expect(
      inlineBoundParams('SELECT * FROM orders WHERE id = :1', [7], 'oracle')
    ).toBe('SELECT * FROM orders WHERE id = 7');
  });

  it('promotes to SQL editor with inlined params and targets connection', () => {
    const parameterizedEntry = {
      ...entry,
      id: 'e-param',
      baseSql: 'SELECT * FROM "public"."orders" WHERE "customer_id" = $1',
      baseParams: [100],
      sql: 'SELECT * FROM "public"."orders" WHERE "customer_id" = $1',
      params: [100],
    };
    useSqlEditorStore.setState({
      dataPeek: { connectionId: 'c1', dialect: 'postgres', entries: [parameterizedEntry] },
      activeTabId: 'tab-1',
      tabs: [{
        id: 'tab-1',
        title: 'Query 1',
        sql: '',
        selectedConnectionIds: [],
        checkedStatements: [],
        statementCount: 1,
        layout: 'byCredential',
      }],
      sessionPasswords: { c1: 'secret' },
    });

    render(<DataPeekPanel />);
    const openBtn = screen.getByTestId('data-peek-open-sql-e-param');
    fireEvent.click(openBtn);

    const state = useSqlEditorStore.getState();
    expect(state.dataPeek).toBeNull();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    expect(activeTab).toBeDefined();
    expect(activeTab?.sql).toBe('SELECT * FROM "public"."orders" WHERE "customer_id" = 100;');
    expect(activeTab?.sql).not.toContain('$1');
    expect(activeTab?.sql).not.toContain('LIMIT');
    expect(effectiveConnectionIds(activeTab!, state.shareDestinations, state.sharedConnectionIds)).toContain('c1');
  });

  it('displays error and does not create tab if filter composition fails', () => {
    const brokenEntry = {
      ...entry,
      id: 'e-broken',
      whereClause: 'status = 1; DROP TABLE users',
    };
    useSqlEditorStore.setState({
      dataPeek: { connectionId: 'c1', dialect: 'postgres', entries: [brokenEntry] },
      activeTabId: 'tab-1',
      tabs: [{
        id: 'tab-1',
        title: 'Query 1',
        sql: '',
        selectedConnectionIds: [],
        checkedStatements: [],
        statementCount: 1,
        layout: 'byCredential',
      }],
    });

    render(<DataPeekPanel />);
    const openBtn = screen.getByTestId('data-peek-open-sql-e-broken');
    fireEvent.click(openBtn);

    expect(screen.getByTestId('data-peek-open-error-e-broken')).toBeTruthy();
    expect(screen.getByText(/WHERE cannot contain ;/i)).toBeTruthy();

    const state = useSqlEditorStore.getState();
    expect(state.dataPeek).not.toBeNull();
    expect(state.tabs.length).toBe(1);
  });
});
