/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Schedule trigger's "SQL execute" mode: picking the connection, writing
 * the script, and the rows-only gate — in the editor and as the inspector
 * shows it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConnectionSummary } from '@foxschema/shared';
import { workflowConnections } from '../api/workflowApi';
import { createCronSql, createTrigger, type WorkflowTrigger } from '../lib/triggers';
import { CronSqlEditor } from './CronSqlEditor';
import { TriggerInlineSettings } from './TriggerInlineSettings';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="SQL text" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('@/features/sql-editor/monaco', () => ({ monacoLanguage: (dialect: string) => dialect }));
vi.mock('../lib/jsonEditorOptions', () => ({ JSON_EDITOR_OPTIONS: {}, useJsonEditorTheme: () => 'vs' }));
vi.mock('../api/engineQueries', () => ({ invalidateEngineQueries: vi.fn() }));
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

beforeEach(() => {
  vi.mocked(workflowConnections.list).mockResolvedValue([WAREHOUSE]);
  vi.mocked(workflowConnections.grant).mockResolvedValue({ ok: true, credentialId: 'foxschema-conn-1' });
});

describe('CronSqlEditor', () => {
  it('links the picked saved connection and stores only its credential id', async () => {
    const onChange = vi.fn();
    render(<CronSqlEditor value={createCronSql()} onChange={onChange} />);
    const picker = (await screen.findByLabelText('Database')) as HTMLButtonElement;
    await waitFor(() => expect(picker.disabled).toBe(false));

    fireEvent.click(picker);
    fireEvent.click(screen.getByTestId('workflow-cron-sql-connection-option-conn-1'));

    await waitFor(() => expect(workflowConnections.grant).toHaveBeenCalledWith('conn-1'));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ ...createCronSql(), credentialId: 'foxschema-conn-1' }),
    );
  });

  it('asks for a connection until one is chosen', async () => {
    render(<CronSqlEditor value={createCronSql()} onChange={() => {}} />);
    expect(screen.getByText(/Choose the connection the script runs against/)).toBeTruthy();
    await screen.findByText('Choose a saved connection…');
  });

  it('names the linked connection and edits the script', async () => {
    const onChange = vi.fn();
    const value = { ...createCronSql(), credentialId: 'foxschema-conn-1', script: 'SELECT 1' };
    render(<CronSqlEditor value={value} onChange={onChange} />);
    expect(await screen.findByText('Warehouse · PostgreSQL · dw')).toBeTruthy();
    expect(screen.queryByText(/Choose the connection the script runs against/)).toBeNull();

    fireEvent.change(screen.getByLabelText('SQL text'), {
      target: { value: 'SELECT id FROM orders WHERE shipped = false' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      script: 'SELECT id FROM orders WHERE shipped = false',
    });
  });

  it('turns the rows-only gate off and caps max rows to the engine limit', async () => {
    const onChange = vi.fn();
    render(<CronSqlEditor value={createCronSql()} onChange={onChange} />);
    await screen.findByText('Choose a saved connection…');

    fireEvent.click(screen.getByTestId('workflow-cron-sql-only-when-rows'));
    expect(onChange).toHaveBeenLastCalledWith({ ...createCronSql(), onlyWhenRows: false });

    fireEvent.change(screen.getByTestId('workflow-cron-sql-max-rows'), { target: { value: '50000' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...createCronSql(), maxRows: 10_000 });
  });
});

describe('TriggerInlineSettings · Schedule SQL execute', () => {
  it('offers SQL execute and seeds the SQL settings when it is chosen', () => {
    const onChange = vi.fn();
    render(<TriggerInlineSettings trigger={createTrigger('cron', 'watch')} credentials={[]} onChange={onChange} />);
    const select = screen.getByTestId('workflow-trigger-settings-execution-type') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toContain('SQL execute');

    fireEvent.change(select, { target: { value: 'sql' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionType: 'sql', sql: createCronSql() }),
    );
  });

  it('shows the SQL editor for a schedule in SQL mode', async () => {
    const trigger = {
      ...createTrigger('cron', 'watch'),
      executionType: 'sql',
      sql: { ...createCronSql(), script: 'SELECT 1' },
    } as WorkflowTrigger;
    render(<TriggerInlineSettings trigger={trigger} credentials={[]} onChange={() => {}} />);
    expect(screen.getByTestId('workflow-cron-sql')).toBeTruthy();
    expect((screen.getByLabelText('SQL text') as HTMLTextAreaElement).value).toBe('SELECT 1');
    await screen.findByText('Choose a saved connection…');
  });

  it('shows no SQL editor while the schedule runs the workflow', () => {
    render(<TriggerInlineSettings trigger={createTrigger('cron', 'nightly')} credentials={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('workflow-cron-sql')).toBeNull();
  });
});
