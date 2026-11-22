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
import type { WorkflowConnectionSummary } from '@foxschema/shared';
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
vi.mock('@/platform/authStore', () => ({
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

function renderEditor(
  type: 'source.db.sql' | 'sink.db.sql' | 'sink.db.mapped-insert',
  credentialId = '',
  config: Record<string, unknown> = {},
) {
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

  it('renders side-by-side mapping editor for sink.db.mapped-insert and adds a mapping', async () => {
    const { onConfigChange } = renderEditor('sink.db.mapped-insert', 'foxschema-conn-1', {
      table: 'dw_users',
      columnMapping: [{ targetColumn: 'user_id', sourceProperty: 'user.sub', isKey: true }],
      upsertKeys: ['user_id'],
    });

    expect(screen.getByTestId('workflow-sql-table')).toBeTruthy();
    expect(screen.getByTestId('workflow-sql-upsert-keys')).toBeTruthy();
    expect((screen.getByTestId('workflow-sql-target-col-0') as HTMLInputElement).value).toBe('user_id');

    fireEvent.click(screen.getByTestId('workflow-sql-add-column-mapping'));
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        columnMapping: [
          { targetColumn: 'user_id', sourceProperty: 'user.sub', isKey: true },
          { targetColumn: '', sourcePath: '' },
        ],
      }),
    );
  });

  it('exposes upsertKey input in insert mode and updates config with single or combination keys', async () => {
    const { onConfigChange } = renderEditor('sink.db.sql', 'foxschema-conn-1', {
      mode: 'insert',
      table: 'orders',
      columns: ['id', 'total'],
      upsertKey: 'id',
    });

    const keyInput = screen.getByTestId('workflow-sql-insert-upsert-key') as HTMLInputElement;
    expect(keyInput.value).toBe('id');

    fireEvent.change(keyInput, { target: { value: 'order_id' } });
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'insert',
        upsertKey: 'order_id',
      }),
    );

    fireEvent.change(keyInput, { target: { value: 'tenant_id, user_id' } });
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'insert',
        upsertKeys: ['tenant_id', 'user_id'],
      }),
    );
  });

  it('updates upsertKeys when a key column is renamed, even if cleared first', async () => {
    const { onConfigChange } = renderEditor('sink.db.mapped-insert', 'foxschema-conn-1', {
      table: 'users',
      upsertKeys: ['user_id'],
      columnMapping: [{ targetColumn: 'user_id', sourcePath: 'id', isKey: true }],
    });

    // Clear the column name first
    fireEvent.change(screen.getByTestId('workflow-sql-target-col-0'), { target: { value: '' } });
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertKeys: [],
        columnMapping: [{ targetColumn: '', sourcePath: 'id', isKey: true }],
      }),
    );

    // Type new column name
    fireEvent.change(screen.getByTestId('workflow-sql-target-col-0'), { target: { value: 'uid' } });
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertKeys: ['uid'],
        columnMapping: [{ targetColumn: 'uid', sourcePath: 'id', isKey: true }],
      }),
    );
  });

  it('toggles combination keys and updates upsertKeys in mapped mode', async () => {
    const { onConfigChange } = renderEditor('sink.db.sql', 'foxschema-conn-1', {
      mode: 'mapped',
      table: 'tenant_users',
      columnMapping: [
        { targetColumn: 'tenant_id', sourceProperty: 'org.id', isKey: true },
        { targetColumn: 'user_id', sourceProperty: 'user.id', isKey: false },
      ],
      upsertKeys: ['tenant_id'],
    });

    fireEvent.click(screen.getByTestId('workflow-sql-key-col-1'));
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertKeys: ['tenant_id', 'user_id'],
        columnMapping: [
          { targetColumn: 'tenant_id', sourceProperty: 'org.id', isKey: true },
          { targetColumn: 'user_id', sourceProperty: 'user.id', isKey: true },
        ],
      }),
    );
  });

  it('populates mapped columns and combination primary keys when picking table in mapped mode', async () => {
    const COMPOSITE_TABLE = {
      name: 'tenant_memberships',
      objectType: 'TABLE',
      columns: [{ name: 'tenant_id' }, { name: 'member_id' }, { name: 'role' }],
      primaryKey: { name: 'pk_tenant_members', columns: ['tenant_id', 'member_id'] },
      indices: [],
      foreignKeys: [],
    };
    vi.mocked(loadSchema).mockResolvedValue({ tables: [COMPOSITE_TABLE] } as never);

    const { onConfigChange } = renderEditor('sink.db.mapped-insert', 'foxschema-conn-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Browse tables' }));
    fireEvent.click(await screen.findByRole('button', { name: 'tenant_memberships' }));

    expect(onConfigChange).toHaveBeenCalledWith({
      mode: 'mapped',
      table: 'public.tenant_memberships',
      upsertKeys: ['tenant_id', 'member_id'],
      columnMapping: [
        { targetColumn: 'tenant_id', sourceProperty: 'tenant_id', isKey: true },
        { targetColumn: 'member_id', sourceProperty: 'member_id', isKey: true },
        { targetColumn: 'role', sourceProperty: 'role', isKey: false },
      ],
    });
  });

  it('warns when the linked connection was saved without its password', async () => {
    vi.mocked(workflowConnections.list).mockResolvedValue([{ ...WAREHOUSE, granted: true, hasPassword: false }]);
    renderEditor('source.db.sql', 'foxschema-conn-1');
    expect(await screen.findByText(/saved without its password/)).toBeTruthy();
  });

  /** Render with one linked connection saved without a password, once the list has loaded. */
  async function renderLinkedWithoutPassword(connection: Partial<WorkflowConnectionSummary>) {
    vi.mocked(workflowConnections.list).mockResolvedValue([
      { ...WAREHOUSE, ...connection, granted: true, hasPassword: false },
    ]);
    renderEditor('source.db.sql', 'foxschema-conn-1');
    const picker = (await screen.findByLabelText('Database')) as HTMLButtonElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
  }

  it.each([
    ['a SQLite file', { dialect: 'sqlite', database: '/data/app.db' }],
    ['a DuckDB file', { dialect: 'duckdb', database: '/data/lake.duckdb' }],
    ['a Redis set to No password', { dialect: 'redis', authMethod: 'none' }],
    ['a MongoDB set to No password, even naming a user', { dialect: 'mongodb', authMethod: 'none', username: 'etl' }],
    ['a Redis saved before No password existed, with no user', { dialect: 'redis' }],
    ['a MongoDB saved before No password existed, with no user', { dialect: 'mongodb' }],
  ])('does not warn about the password for %s, which signs in without one', async (_label, connection) => {
    await renderLinkedWithoutPassword(connection);
    expect(screen.queryByText(/saved without its password/)).toBeNull();
  });

  it.each([
    ['a Redis with only requirepass', { dialect: 'redis', authMethod: 'password' }],
    ['a Redis ACL user', { dialect: 'redis', username: 'etl' }],
    ['a MongoDB user', { dialect: 'mongodb', username: 'etl' }],
    ['a Windows login', { dialect: 'sqlserver', username: 'etl', authMethod: 'windows' }],
  ])('still warns for %s with no saved password', async (_label, connection) => {
    await renderLinkedWithoutPassword(connection);
    expect(screen.getByText(/saved without its password/)).toBeTruthy();
  });
});
