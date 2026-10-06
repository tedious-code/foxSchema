/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup & Restore's server actions on every engine.
 *
 * BackupRestorePanel.test.tsx follows Postgres and SQL Server through the
 * panel. This asks every engine the same questions: is "Run backup now"
 * offered (only where the backup is SQL the database server runs), is "List
 * backups" offered (only where the server keeps a record), what a connection
 * whose password is not in this session gets, what a failed run and a failed
 * listing show, and that "Restore the newest instead" undoes a pick.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DIALECTS } from '@foxschema/ui-shared';
import { BackupRestorePanel } from './BackupRestorePanel';

const FILE_ENGINES = new Set(['sqlite', 'duckdb']);
const connectionFor = (dialect: string, over: Record<string, unknown> = {}) => ({
  id: dialect,
  name: `My ${dialect}`,
  dialect,
  host: FILE_ENGINES.has(dialect) ? undefined : 'db.local',
  port: 1000,
  database: FILE_ENGINES.has(dialect) ? '/data/shop.db' : 'shop',
  username: 'fox',
  hasPassword: true,
  ...over,
});
let connections: Array<ReturnType<typeof connectionFor>> = [];
vi.mock('@/app/store/useSyncStore', () => ({
  useSyncStore: (sel: (s: { connections: unknown[] }) => unknown) => sel({ connections }),
}));
let sessionPasswords: Record<string, string> = {};
vi.mock('@/app/store/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setSql: vi.fn(), ensureConnectionSelected: vi.fn(), sessionPasswords }),
}));
vi.mock('@/app/store/authStore', () => ({
  useAuthStore: (sel: (s: { can: () => boolean }) => unknown) => sel({ can: () => true }),
}));
const executeSql = vi.fn();
vi.mock('@/shared/api/sqlApi', () => ({ executeSql: (...args: unknown[]) => executeSql(...args) }));
vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: { setActiveView: () => void }) => unknown) => sel({ setActiveView: vi.fn() }),
}));
const getSettings = vi.fn();
vi.mock('@/shared/api/backupApi', () => ({
  apiGetBackupSettings: () => getSettings(),
  apiSaveBackupSettings: (_d: string, s: unknown) => Promise.resolve(s),
}));
vi.mock('@/shared/utils/clipboard', () => ({ writeClipboard: vi.fn(() => Promise.resolve()) }));

/** What the panel offers on the server, per engine. */
const EXPECTED: Record<string, { run: boolean; history: boolean }> = {
  postgres: { run: false, history: false },
  yugabytedb: { run: false, history: false },
  redshift: { run: false, history: false },
  mysql: { run: false, history: false },
  mariadb: { run: false, history: false },
  tidb: { run: false, history: false },
  azuresql: { run: false, history: false },
  // Data Pump runs on the server, but as a shell tool, not SQL.
  oracle: { run: false, history: false },
  sqlite: { run: false, history: false },
  mongodb: { run: false, history: false },
  redis: { run: false, history: false },
  cockroachdb: { run: true, history: false },
  duckdb: { run: true, history: false },
  sqlserver: { run: true, history: true },
  // The CLP backup is a shell command; the history is SQL.
  db2: { run: false, history: true },
  clickhouse: { run: true, history: true },
};

const ok = (columns: string[], rows: unknown[][]) => ({
  results: [{ ok: true, columns, rows, rowCount: rows.length, truncated: false, durationMs: 5 }],
});
const failed = (error: string) => ({ results: [{ ok: false, error, durationMs: 1 }] });
const restoreText = () => screen.getByTestId('restore-command-text').textContent ?? '';

/** A key of the shape each engine's history returns. */
const HISTORY_ROW: Record<string, { key: string; inRestore: string }> = {
  sqlserver: { key: '/var/opt/mssql/backups/shop_old.bak', inRestore: "FROM DISK = N'/var/opt/mssql/backups/shop_old.bak'" },
  db2: { key: '20261005220000', inRestore: 'TAKEN AT 20261005220000' },
  clickhouse: { key: "Disk('backups', 'shop_old.zip')", inRestore: "FROM Disk('backups', 'shop_old.zip')" },
};

beforeEach(() => {
  getSettings.mockResolvedValue({});
  sessionPasswords = {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function open(dialect: string, over: Record<string, unknown> = {}) {
  connections = [connectionFor(dialect, over)];
  render(<BackupRestorePanel lockedConnectionId={dialect} />);
  await waitFor(() => expect(getSettings).toHaveBeenCalled());
}

describe('BackupRestorePanel server actions, every engine', () => {
  it('names every engine Fox Schema connects to', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...DIALECTS].sort());
  });

  for (const [dialect, expected] of Object.entries(EXPECTED)) {
    const offers = [expected.run && 'run', expected.history && 'list'].filter(Boolean).join(' and ') || 'nothing';
    it(`${dialect}: offers ${offers} on the server`, async () => {
      await open(dialect);
      expect(!!screen.queryByTestId('backup-run')).toBe(expected.run);
      expect(!!screen.queryByTestId('backup-history-load')).toBe(expected.history);
      expect(!!screen.queryByTestId('backup-server-actions')).toBe(expected.run || expected.history);
    });
  }

  for (const dialect of ['sqlserver', 'clickhouse', 'cockroachdb'] as const) {
    it(`${dialect}: without the password in this session, both actions wait for it and say why`, async () => {
      await open(dialect, { hasPassword: false });
      for (const id of ['backup-run', ...(EXPECTED[dialect]!.history ? ['backup-history-load'] : [])]) {
        const button = screen.getByTestId(id) as HTMLButtonElement;
        expect(button.disabled, id).toBe(true);
        expect(button.title).toMatch(/password in the SQL Editor/);
      }
    });
  }

  it('sqlserver: with the password entered in this session, both are offered', async () => {
    sessionPasswords = { sqlserver: 'typed-this-session' };
    await open('sqlserver', { hasPassword: false });
    expect((screen.getByTestId('backup-run') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('backup-history-load') as HTMLButtonElement).disabled).toBe(false);
  });

  for (const dialect of ['sqlserver', 'cockroachdb', 'clickhouse', 'duckdb']) {
    it(`${dialect}: a failed run shows the server’s message`, async () => {
      executeSql.mockResolvedValueOnce(failed(`${dialect} says: cannot open backup device`));
      await open(dialect);
      fireEvent.click(screen.getByTestId('backup-run'));
      fireEvent.click(screen.getByTestId('backup-run-confirm'));
      expect((await screen.findByTestId('backup-run-error')).textContent).toBe(`${dialect} says: cannot open backup device`);
      expect(screen.getByTestId('backup-run-status').textContent).toBe('');
    });
  }

  for (const [dialect, { key, inRestore }] of Object.entries(HISTORY_ROW)) {
    it(`${dialect}: a failed listing shows the server’s message`, async () => {
      executeSql.mockResolvedValueOnce(failed('permission denied on the history catalog'));
      await open(dialect);
      fireEvent.click(screen.getByTestId('backup-history-load'));
      expect((await screen.findByTestId('backup-history-error')).textContent).toBe('permission denied on the history catalog');
    });

    it(`${dialect}: an empty history says so`, async () => {
      executeSql.mockResolvedValueOnce(ok(['finished_at', 'location', 'size_bytes', 'restore_key'], []));
      await open(dialect);
      fireEvent.click(screen.getByTestId('backup-history-load'));
      expect((await screen.findByTestId('backup-history-empty')).textContent).toMatch(/no backups of this database/);
    });

    it(`${dialect}: picking a listed backup points the restore at it, and "Restore the newest instead" undoes it`, async () => {
      // Db2 answers in capitals; the panel reads either.
      const columns = dialect === 'db2' ? ['FINISHED_AT', 'LOCATION', 'SIZE_BYTES', 'RESTORE_KEY'] : ['finished_at', 'location', 'size_bytes', 'restore_key'];
      executeSql.mockResolvedValueOnce(ok(columns, [['2026-10-05 22:00', '/somewhere', 1024, key]]));
      await open(dialect);
      const newest = restoreText();
      expect(newest).not.toContain(inRestore);

      fireEvent.click(screen.getByTestId('backup-history-load'));
      fireEvent.click(await screen.findByTestId('backup-history-pick-0'));
      expect(restoreText()).toContain(inRestore);
      expect(screen.getByTestId('backup-history-pick-0').textContent).toBe('Restoring this');

      fireEvent.click(screen.getByTestId('backup-history-clear-pick'));
      expect(restoreText()).toBe(newest);
      expect(screen.queryByTestId('backup-history-clear-pick')).toBeNull();
    });
  }
});
