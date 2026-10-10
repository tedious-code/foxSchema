/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Linking a saved connection from the SQL pipe editor, and building a query or
 * an insert from one of its tables.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConnectionSummary } from '@foxschema/workflow-contract';
import { loadSchema } from '@/shared/api/schemaApi';
import { workflowConnections } from '../api/workflowApi';
import { SqlPipeEditor } from './SqlPipeEditor';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="SQL text" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('@/features/sql-editor/lib/monacoSetup', () => ({ monacoLanguage: (dialect: string) => dialect }));
vi.mock('../lib/jsonEditorOptions', () => ({ JSON_EDITOR_OPTIONS: {}, useJsonEditorTheme: () => 'vs' }));
vi.mock('../api/engineQueries', () => ({ invalidateEngineQueries: vi.fn() }));
vi.mock('@/shared/api/schemaApi', () => ({ loadSchema: vi.fn() }));
vi.mock('@/app/store/authStore', () => ({
  useAuthStore: (select: (state: { can: () => boolean }) => unknown) => select({ can: () => true }),
}));
vi.mock('../api/workflowApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/workflowApi')>()),
  workflowConnections: { list: vi.fn(), grant: vi.fn(), revoke: vi.fn() },
}));

const WAREHOUSE: WorkflowConnectionSummary = {
  id: 'conn-1',
  name: 'Warehouse',
  dialect: 'postgres',
  schema: 'public',
  database: 'dw',
  hasPassword: true,
  granted: false,
};

const ORDERS = {
  name: 'orders',
  objectType: 'TABLE',
  columns: [{ name: 'id' }, { name: 'total' }],
  indices: [],
  foreignKeys: [],
};

beforeEach(() => {
  vi.mocked(workflowConnections.list).mockResolvedValue([WAREHOUSE]);
  vi.mocked(workflowConnections.grant).mockResolvedValue({ ok: true, credentialId: 'foxschema-conn-1' });
  vi.mocked(loadSchema).mockResolvedValue({ tables: [ORDERS] } as never);
});

function renderEditor(type: 'source.db.sql' | 'sink.db.sql', credentialId = '', config: Record<string, unknown> = {}) {
  const onConfigChange = vi.fn();
  const onCredentialChange = vi.fn();
  render(
    <SqlPipeEditor
      type={type}
      config={config}
      credentialId={credentialId}
      onConfigChange={onConfigChange}
      onCredentialChange={onCredentialChange}
    />,
  );
  return { onConfigChange, onCredentialChange };
}

describe('SqlPipeEditor', () => {
  it('links a saved connection when it is picked, and points the pipe at its credential', async () => {
    const { onCredentialChange } = renderEditor('source.db.sql');
    const picker = (await screen.findByLabelText('Database')) as HTMLButtonElement;
    await waitFor(() => expect(picker.disabled).toBe(false));

    fireEvent.click(picker);
    fireEvent.click(screen.getByTestId('sql-pipe-connection-option-conn-1'));

    await waitFor(() => expect(onCredentialChange).toHaveBeenCalledWith('foxschema-conn-1'));
    expect(workflowConnections.grant).toHaveBeenCalledWith('conn-1');
  });

  it('adds a quoted SELECT of a picked table’s columns to the query', async () => {
    const { onConfigChange } = renderEditor('source.db.sql', 'foxschema-conn-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Browse tables' }));

    expect(loadSchema).toHaveBeenCalledWith({ connectionId: 'conn-1', schema: 'public' }, ['TABLE', 'VIEW']);
    fireEvent.click(await screen.findByRole('button', { name: 'orders' }));

    expect(onConfigChange).toHaveBeenCalledWith({ sql: 'SELECT "id", "total"\nFROM "public"."orders"' });
  });

  it('sets the table and its columns for an insert, which has no statement to edit', async () => {
    const { onConfigChange } = renderEditor('sink.db.sql', 'foxschema-conn-1');
    expect(screen.queryByLabelText('SQL text')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Browse tables' }));
    fireEvent.click(await screen.findByRole('button', { name: 'orders' }));

    expect(onConfigChange).toHaveBeenCalledWith({ mode: 'insert', table: 'public.orders', columns: ['id', 'total'] });
  });

  it('warns when the linked connection was saved without its password', async () => {
    vi.mocked(workflowConnections.list).mockResolvedValue([{ ...WAREHOUSE, granted: true, hasPassword: false }]);
    renderEditor('source.db.sql', 'foxschema-conn-1');
    expect(await screen.findByText(/saved without its password/)).toBeTruthy();
  });
});
