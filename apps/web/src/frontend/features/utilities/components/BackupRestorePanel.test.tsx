/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BackupRestorePanel } from './BackupRestorePanel';

const connections = [
  { id: 'pg', name: 'Shop', dialect: 'postgres', host: 'db.local', port: 5432, database: 'shop', schema: 'sales', username: 'fox' },
  { id: 'ms', name: 'Ledger', dialect: 'sqlserver', host: 'sql.local', port: 1433, database: 'ledger', username: 'sa_like', hasPassword: true },
  { id: 'odd', name: 'Odd', dialect: 'notadb', database: 'x' },
];
vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: { connections: typeof connections }) => unknown) => sel({ connections }),
}));
const setSql = vi.fn();
const ensureConnectionSelected = vi.fn();
vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: { setSql: typeof setSql; ensureConnectionSelected: typeof ensureConnectionSelected; sessionPasswords: Record<string, string> }) => unknown) =>
    sel({ setSql, ensureConnectionSelected, sessionPasswords: {} }),
}));
let canChangeSchema = true;
vi.mock('@/app/store/authStore', () => ({
  useAuthStore: (sel: (s: { can: () => boolean }) => unknown) => sel({ can: () => canChangeSchema }),
}));
const executeSql = vi.fn();
vi.mock('@/shared/api/sqlApi', () => ({ executeSql: (...args: unknown[]) => executeSql(...args) }));
const setActiveView = vi.fn();
vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: { setActiveView: typeof setActiveView }) => unknown) => sel({ setActiveView }),
}));
const getSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock('@/shared/api/backupApi', () => ({
  apiGetBackupSettings: () => getSettings(),
  apiSaveBackupSettings: (dialect: string, s: unknown) => saveSettings(dialect, s),
}));
vi.mock('@/shared/utils/clipboard', () => ({ writeClipboard: vi.fn(() => Promise.resolve()) }));

const backupText = () => screen.getByTestId('backup-command-text').textContent ?? '';

beforeEach(() => {
  canChangeSchema = true;
  getSettings.mockResolvedValue({});
  saveSettings.mockImplementation((_d: string, s: unknown) => Promise.resolve(s));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BackupRestorePanel', () => {
  it('says where the command runs before anything else, and writes it for the engine', async () => {
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(screen.getByTestId('backup-runs-on').textContent).toMatch(/Runs on your machine/);
    expect(backupText()).toMatch(/^pg_dump --host db\.local --port 5432 --username fox --format=custom --compress=9 --file=\.\/backups\/shop_\d{8}_\d{6}\.dump shop$/);
    expect(screen.getByTestId('restore-command-text').textContent).toMatch(/^pg_restore /);
    // A shell command cannot be run in the SQL editor.
    expect(screen.queryByTestId('backup-command-open-sql')).toBeNull();
  });

  it('rewrites the command as the reader changes folder, scope, tables and schema', async () => {
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('backup-folder'), { target: { value: '/srv/My Backups' } });
    fireEvent.click(screen.getByTestId('backup-scope-schema'));
    fireEvent.click(screen.getByTestId('backup-limit-schema'));
    expect(backupText()).toContain("--schema-only --compress=9 --schema=sales --file='/srv/My Backups/");
    fireEvent.change(screen.getByTestId('backup-tables'), { target: { value: 'orders\ncustomers' } });
    expect(backupText()).toContain('--table=sales.orders --table=sales.customers');
    expect(backupText()).not.toContain('--schema=sales');
  });

  it('starts from the reader’s saved default for the engine, and saves a new one', async () => {
    getSettings.mockResolvedValue({ postgres: { folder: '/nas/pg', format: 'plain', scope: 'full', compress: false, limitToSchema: false } });
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    await waitFor(() => expect(backupText()).toContain('--file=/nas/pg/shop_'));
    expect(screen.getByTestId('backup-save-status').textContent).toMatch(/saved default/);
    expect((screen.getByTestId('backup-save-default') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('backup-format-custom'));
    fireEvent.change(screen.getByTestId('backup-tables'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByTestId('backup-save-default'));
    await waitFor(() => expect(screen.getByTestId('backup-save-status').textContent).toMatch(/^Saved/));
    expect(saveSettings).toHaveBeenCalledWith('postgres', { folder: '/nas/pg', format: 'custom', scope: 'full', compress: false, limitToSchema: false });
    // Saving keeps the form as it was: the table filter is not a default and is not wiped.
    expect((screen.getByTestId('backup-tables') as HTMLTextAreaElement).value).toBe('orders');
  });

  it('offers SQL Server’s BACKUP DATABASE to the SQL editor, on this connection', async () => {
    render(<BackupRestorePanel lockedConnectionId="ms" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(screen.getByTestId('backup-runs-on').textContent).toMatch(/database server/);
    expect(screen.queryByTestId('backup-scope')).toBeNull();
    fireEvent.click(screen.getByTestId('backup-command-open-sql'));
    expect(setSql).toHaveBeenCalledWith(expect.stringMatching(/^BACKUP DATABASE \[ledger\]/));
    expect(ensureConnectionSelected).toHaveBeenCalledWith('ms');
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
  });

  it('says so for an engine without backup commands, and without a connection', async () => {
    render(<BackupRestorePanel lockedConnectionId="odd" />);
    expect(screen.getByTestId('backup-unsupported')).toBeTruthy();
    cleanup();
    render(<BackupRestorePanel />);
    expect(screen.getByTestId('backup-no-connection')).toBeTruthy();
  });

  it('keeps what the reader typed when saved defaults arrive afterwards', async () => {
    let arrive: (v: unknown) => void = () => undefined;
    getSettings.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    fireEvent.change(screen.getByTestId('backup-folder'), { target: { value: '/typed' } });
    arrive({ postgres: { folder: '/saved', format: 'plain', scope: 'full', compress: false, limitToSchema: false } });
    await waitFor(() => expect(screen.getByTestId('backup-save-status').textContent).toMatch(/saved default/));
    expect(backupText()).toContain('--file=/typed/');
  });

  it('still works when saved defaults cannot be loaded', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    await waitFor(() => expect(screen.getByTestId('backup-save-status').textContent).toMatch(/could not be loaded/));
    expect(backupText()).toMatch(/^pg_dump /);
  });

  it('runs SQL Server’s backup on the server once confirmed, and restores a listed backup', async () => {
    const ok = (columns: string[], rows: unknown[][], durationMs = 1) => ({
      results: [{ ok: true, columns, rows, rowCount: rows.length, truncated: false, durationMs }],
    });
    executeSql
      .mockResolvedValueOnce(ok([], [], 1200))
      .mockResolvedValueOnce(
        ok(['finished_at', 'location', 'size_bytes', 'restore_key'], [
          ['2026-10-05 22:00', '/var/opt/mssql/backups/ledger_old.bak', 2_097_152, '/var/opt/mssql/backups/ledger_old.bak'],
        ])
      );
    render(<BackupRestorePanel lockedConnectionId="ms" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    // Nothing runs until the reader has seen where the file goes and agreed.
    fireEvent.click(screen.getByTestId('backup-run'));
    expect(executeSql).not.toHaveBeenCalled();
    expect(screen.getByTestId('backup-run-confirm-box').textContent).toMatch(/Ledger/);
    fireEvent.click(screen.getByTestId('backup-run-confirm'));
    await waitFor(() => expect(screen.getByTestId('backup-run-status').textContent).toMatch(/Backup finished in 1\.2 s/));
    expect(executeSql.mock.calls[0]![1]).toEqual([expect.stringMatching(/^BACKUP DATABASE \[ledger\]/)]);

    // The finished backup is listed (read straight after), and picking it points the restore at it.
    fireEvent.click(await screen.findByTestId('backup-history-pick-0'));
    expect(screen.getByTestId('restore-command-text').textContent).toContain(
      "FROM DISK = N'/var/opt/mssql/backups/ledger_old.bak'"
    );
  });

  it('offers nothing to run or list for a tool that runs on the reader’s machine', async () => {
    render(<BackupRestorePanel lockedConnectionId="pg" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(screen.queryByTestId('backup-server-actions')).toBeNull();
  });

  it('will not run a backup for someone who may not change the schema', async () => {
    canChangeSchema = false;
    render(<BackupRestorePanel lockedConnectionId="ms" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect((screen.getByTestId('backup-run') as HTMLButtonElement).disabled).toBe(true);
  });
});
