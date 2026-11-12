import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableSchema } from '@/shared/lib/types';

const executeSql = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));

vi.mock('@/features/compare', () => {
  const state = {
    connections: [
      { id: 'pg', name: 'Shop', dialect: 'postgres', schema: 'shop', hasPassword: true },
      { id: 'my', name: 'Store', dialect: 'mysql', schema: 'shop', hasPassword: true },
      { id: 'ora', name: 'Ledger', dialect: 'oracle', schema: 'LEDGER', hasPassword: true },
    ],
  };
  const useSyncStore = (sel: (s: typeof state) => unknown) => sel(state);
  useSyncStore.getState = () => state;
  return { useSyncStore };
});

import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/platform/uiStore';
import { TypeDropPanel, typeDropScript } from './TypeDropPanel';

const base = (name: string, extra: Partial<TableSchema>): TableSchema => ({
  name,
  objectType: 'TABLE',
  columns: [],
  indices: [],
  foreignKeys: [],
  ...extra,
});

const status = base('order_status', {
  objectType: 'TYPE',
  userType: { metaType: 'E', attributes: ['new', 'paid'].map((v) => ({ name: v, type: '' })) },
});
const mood = base('mood', {
  objectType: 'TYPE',
  userType: { metaType: 'E', attributes: [{ name: 'ok', type: '' }] },
});
const orders = base('orders', {
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'status', type: 'shop.order_status', nullable: false, primaryKey: false, defaultValue: "'new'::shop.order_status" },
  ],
  primaryKey: { columns: ['id'] },
});
const label = base('order_label', {
  objectType: 'FUNCTION',
  definition: 'CREATE FUNCTION order_label(p order_status)\nRETURNS text AS $$ SELECT p::text $$',
});
const address = base('address_t', { objectType: 'TYPE', userType: { metaType: 'O' } });
const customers = base('CUSTOMERS', {
  columns: [{ name: 'ADDR', type: 'LEDGER.ADDRESS_T', nullable: true, primaryKey: false }],
});

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const okResult = { results: [{ ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }] };

describe('TypeDropPanel', () => {
  beforeEach(() => {
    executeSql.mockReset();
    useSqlEditorStore.setState({
      schemaCache: {
        pg: { status: 'ready', tables: [orders, label, status, mood] },
        ora: { status: 'ready', tables: [customers, address] },
      },
      ensureSchema: async () => undefined,
      ensureConnectionSelected: () => undefined,
      safeMode: false,
    } as never);
  });

  it('lists the types, shows what uses one and the steps, and opens them for this connection only', async () => {
    const setActiveView = vi.spyOn(useUiStore.getState(), 'setActiveView');
    render(<TypeDropPanel lockedConnectionId="pg" />);
    // Shown once the schema has loaded.
    expect(await screen.findByTestId('type-drop-hint')).toBeTruthy();
    const options = Array.from((screen.getByTestId('type-drop-type') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'mood', 'order_status']);

    pick('type-drop-type', 'order_status');
    const impact = screen.getByTestId('type-drop-impact').textContent ?? '';
    expect(impact).toContain('orders.status');
    expect(impact).toContain('order_label');
    expect(screen.getByTestId('type-drop-values').textContent).toBe('new · paid');
    expect((screen.getByTestId('type-drop-replacement') as HTMLInputElement).placeholder).toBe('text');
    expect(screen.getAllByTestId(/^type-drop-step-\d+$/)).toHaveLength(2);
    const change = screen.getByTestId('type-drop-step-1').textContent ?? '';
    expect(change).toContain('ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE text USING "status"::text;');
    expect(change).toContain(`SET DEFAULT 'new';`);
    expect(change).toContain(`CHECK ("status" IN ('new', 'paid'))`);
    expect(screen.getByTestId('type-drop-step-2').textContent).toContain('DROP TYPE "shop"."order_status";');
    const sql = Array.from(screen.getByTestId('type-drop-steps').querySelectorAll('pre')).map((p) => p.textContent);
    expect(sql.join('\n')).not.toMatch(/CASCADE/i);

    const tabsBefore = useSqlEditorStore.getState().tabs.length;
    fireEvent.click(screen.getByTestId('type-drop-open-editor'));
    const editor = useSqlEditorStore.getState();
    const tab = editor.activeTab();
    expect(editor.tabs).toHaveLength(tabsBefore + 1);
    expect(tab.title).toBe('Drop order_status');
    expect(tab.sql.startsWith('-- Step 1: Change orders.status to text\n')).toBe(true);
    expect(tab.sql).toContain('-- Step 2: Drop order_status');
    expect(editor.activeConnectionIds()).toEqual(['pg']);
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
  });

  it('leaves the check constraint out when unticked, and takes another replacement', () => {
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'order_status');
    fireEvent.click(screen.getByTestId('type-drop-keep-check'));
    pick('type-drop-replacement', 'varchar(20)');
    const change = screen.getByTestId('type-drop-step-1').textContent ?? '';
    expect(change).toContain('TYPE varchar(20) USING "status"::text::varchar(20);');
    expect(change).not.toContain('CHECK');
  });

  it('drops an unused type in one step', () => {
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'mood');
    expect(screen.getByTestId('type-drop-impact').textContent).toContain('No column, type, view or routine uses it.');
    expect(screen.queryByTestId('type-drop-replacement')).toBeNull();
    expect(screen.getAllByTestId(/^type-drop-step-\d+$/)).toHaveLength(1);
    expect(screen.getByTestId('type-drop-step-1').textContent).toContain('DROP TYPE "shop"."mood";');
  });

  it('refuses a too-short replacement for the enum values', () => {
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'order_status');
    pick('type-drop-replacement', 'varchar(2)');
    expect(screen.getByTestId('type-drop-refused')).toBeTruthy();
    expect(screen.queryByTestId('type-drop-steps')).toBeNull();
  });

  it('says why when a column cannot be moved off the type (Oracle object type)', () => {
    render(<TypeDropPanel lockedConnectionId="ora" />);
    pick('type-drop-type', 'address_t');
    expect(screen.getByTestId('type-drop-impact').textContent).toContain('CUSTOMERS.ADDR');
    expect(screen.getByTestId('type-drop-refused').textContent).toMatch(/CUSTOMERS\.ADDR/);
    expect(screen.queryByTestId('type-drop-run-all')).toBeNull();
  });

  it('says so on an engine without user-defined types', () => {
    render(<TypeDropPanel lockedConnectionId="my" />);
    expect(screen.getByTestId('type-drop-unsupported').textContent).toMatch(/no user-defined types/);
    expect(screen.queryByTestId('type-drop-type')).toBeNull();
  });

  it('executes every step in order against this connection, then reloads', async () => {
    executeSql.mockResolvedValue(okResult);
    const ensureSchema = vi.fn(async () => undefined);
    useSqlEditorStore.setState({ ensureSchema } as never);
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'order_status');
    fireEvent.click(screen.getByTestId('type-drop-run-all'));
    await waitFor(() => expect(screen.getByTestId('type-drop-run-status').textContent).toBe('Dropped order_status.'));
    expect(executeSql).toHaveBeenCalledTimes(2);
    expect(executeSql.mock.calls[0]![0]).toMatchObject({ connectionId: 'pg', schema: 'shop' });
    // BEGIN … COMMIT runs as the server's transaction: a failure rolls back and
    // leaves no pooled connection inside an aborted transaction.
    const first = executeSql.mock.calls[0]![1] as string[];
    expect(first[0]).toMatch(/^ALTER TABLE "shop"\."orders" ALTER COLUMN "status" DROP DEFAULT;/);
    expect(first).not.toContain('BEGIN;');
    expect(first).not.toContain('COMMIT;');
    expect(executeSql.mock.calls[0]![5]).toEqual({ stopOnError: true, transaction: true });
    expect(executeSql.mock.calls[1]![1]).toEqual(['DROP TYPE "shop"."order_status";']);
    expect(executeSql.mock.calls[1]![5]).toEqual({ stopOnError: true, transaction: false });
    expect(ensureSchema).toHaveBeenLastCalledWith('pg', expect.objectContaining({ force: true }));
  });

  it('stops at the first refused step and does not drop the type', async () => {
    executeSql.mockResolvedValueOnce({
      results: [{ ok: false, error: 'cannot alter type of a column used by a view' }],
    });
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'order_status');
    fireEvent.click(screen.getByTestId('type-drop-run-all'));
    await waitFor(() =>
      expect(screen.getByTestId('type-drop-run-error').textContent).toBe(
        'Change orders.status to text: cannot alter type of a column used by a view'
      )
    );
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('asks before executing in Safe mode, and cancel runs nothing', async () => {
    useSqlEditorStore.setState({ safeMode: true } as never);
    executeSql.mockResolvedValue(okResult);
    render(<TypeDropPanel lockedConnectionId="pg" />);
    pick('type-drop-type', 'mood');
    fireEvent.click(screen.getByTestId('type-drop-run-all'));
    expect(executeSql).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('type-drop-confirm-all-cancel'));
    expect(screen.queryByTestId('type-drop-confirm-all')).toBeNull();
    fireEvent.click(screen.getByTestId('type-drop-run-all'));
    fireEvent.click(screen.getByTestId('type-drop-confirm-all'));
    await waitFor(() => expect(executeSql).toHaveBeenCalledTimes(1));
  });
});

describe('typeDropScript', () => {
  it('puts each step under a comment naming it', () => {
    expect(
      typeDropScript([
        { title: 'Change t.c to text', sql: 'ALTER …;' },
        { title: 'Drop x', sql: 'DROP TYPE x;' },
      ])
    ).toBe('-- Step 1: Change t.c to text\nALTER …;\n\n-- Step 2: Drop x\nDROP TYPE x;\n');
  });
});
