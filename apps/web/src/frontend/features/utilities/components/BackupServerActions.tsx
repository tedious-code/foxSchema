/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the Backup & Restore panel can do on the database server itself.
 *
 * Where a backup is SQL the server executes (SQL Server, CockroachDB,
 * ClickHouse, DuckDB), it can run it, after the reader confirms what it will
 * write and where. Where the server records its backups (SQL Server's msdb,
 * Db2's history, ClickHouse's system.backups), it lists them, and picking one
 * points the restore command at that backup instead of the newest in the
 * folder. A restore is never run from here: it replaces a database, so it
 * stays a command the reader opens in the SQL editor and runs themselves.
 */
import React, { useState } from 'react';
import { History, Loader2, Play } from 'lucide-react';
import {
  backupHistoryQuery,
  normalizeBackupHistory,
  type BackupCommands,
  type BackupHistoryEntry,
} from '@foxschema/ui-shared';
import { useAuthStore } from '@/app/store/authStore';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import type { useSyncStore } from '@/features/compare';
import { executeSql } from '@/shared/api/sqlApi';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { dialectLabel } from '@/shared/lib/dialectLabel';

type Connection = ReturnType<typeof useSyncStore.getState>['connections'][number];

const formatSize = (bytes: number | null) =>
  bytes == null ? '' : bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A result's rows as records, the shape the history normaliser reads. */
const asRecords = (columns: string[], rows: unknown[][]) =>
  rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));

export const BackupServerActions: React.FC<{
  connection: Connection;
  /** The backup is SQL the database server runs, so it can be run from here. */
  runnable: boolean;
  commands: BackupCommands;
  picked: BackupHistoryEntry | null;
  onPick: (entry: BackupHistoryEntry | null) => void;
}> = ({ connection, runnable, commands, picked, onPick }) => {
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const canRun = useAuthStore((s) => s.can('editor.ddl'));
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<'idle' | 'running' | { ok: true; ms: number } | { error: string }>('idle');
  const [history, setHistory] = useState<'idle' | 'loading' | BackupHistoryEntry[] | { error: string }>('idle');

  const historySql = backupHistoryQuery({ dialect: connection.dialect, database: connection.database ?? '', schema: connection.schema });
  const needsPassword =
    !connection.hasPassword &&
    connectionNeedsSecret(connection.dialect, connection.authMethod) &&
    !sessionPasswords[connection.id];
  const ref = {
    connectionId: connection.id,
    password: sessionPasswords[connection.id] || undefined,
    schema: connection.schema?.trim() || undefined,
  };

  if (!runnable && !historySql) return null;

  const runBackup = async () => {
    setConfirming(false);
    setRun('running');
    try {
      const { results } = await executeSql(ref, [commands.backup]);
      const result = results[0];
      setRun(result && result.ok ? { ok: true, ms: result.durationMs } : { error: result && !result.ok ? result.error : 'The server returned no result.' });
      if (result?.ok && historySql) void loadHistory();
    } catch (err) {
      setRun({ error: err instanceof Error ? err.message : 'The backup could not run.' });
    }
  };

  const loadHistory = async () => {
    if (!historySql) return;
    setHistory('loading');
    try {
      const { results } = await executeSql(ref, [historySql]);
      const result = results[0];
      if (!result || !result.ok) {
        setHistory({ error: result && !result.ok ? result.error : 'The server returned no result.' });
        return;
      }
      setHistory(normalizeBackupHistory(asRecords(result.columns, result.rows)));
    } catch (err) {
      setHistory({ error: err instanceof Error ? err.message : 'Could not read the backup history.' });
    }
  };

  const passwordHint = needsPassword ? 'Enter this connection’s password in the SQL Editor first.' : undefined;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3" data-testid="backup-server-actions">
      {runnable && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="backup-run"
              disabled={!canRun || needsPassword || run === 'running' || confirming}
              title={!canRun ? 'Running a backup needs the Change schema permission.' : passwordHint}
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-bold text-emerald-100 disabled:opacity-40"
            >
              {run === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run backup now
            </button>
            <span className="text-[11px] text-slate-500" data-testid="backup-run-status">
              {run === 'running'
                ? 'Running on the database server…'
                : typeof run === 'object' && 'ok' in run
                  ? `Backup finished in ${(run.ms / 1000).toFixed(1)} s: ${commands.location}`
                  : null}
            </span>
          </div>
          {confirming && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-100" data-testid="backup-run-confirm-box">
              <p>
                {dialectLabel(connection.dialect)} will write <span className="font-mono">{commands.location}</span> on the
                database server for <span className="font-semibold">{connection.name}</span>. A large database can take a
                while, and the server needs room for the file.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="backup-run-confirm"
                  onClick={() => void runBackup()}
                  className="rounded-md border border-amber-400/50 bg-amber-500/20 px-2 py-0.5 font-bold"
                >
                  Run it
                </button>
                <button
                  type="button"
                  data-testid="backup-run-cancel"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-slate-600 px-2 py-0.5 text-slate-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {typeof run === 'object' && 'error' in run && (
            <p className="text-[11px] text-rose-300" data-testid="backup-run-error">
              {run.error}
            </p>
          )}
        </div>
      )}

      {historySql && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="backup-history-load"
              disabled={needsPassword || history === 'loading'}
              title={passwordHint}
              onClick={() => void loadHistory()}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] font-bold text-slate-200 disabled:opacity-40"
            >
              {history === 'loading' ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
              {Array.isArray(history) ? 'Refresh backups on this server' : 'List backups on this server'}
            </button>
            {picked && (
              <button
                type="button"
                data-testid="backup-history-clear-pick"
                onClick={() => onPick(null)}
                className="text-[11px] text-slate-400 underline"
              >
                Restore the newest instead
              </button>
            )}
          </div>
          {typeof history === 'object' && !Array.isArray(history) && (
            <p className="text-[11px] text-rose-300" data-testid="backup-history-error">
              {history.error}
            </p>
          )}
          {Array.isArray(history) &&
            (history.length === 0 ? (
              <p className="text-[11px] text-slate-500" data-testid="backup-history-empty">
                The server has no backups of this database on record.
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="backup-history">
                {history.map((entry, i) => {
                  const chosen = picked?.restoreKey === entry.restoreKey;
                  return (
                    <li
                      key={`${entry.restoreKey}-${i}`}
                      className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                        chosen ? 'border-sky-500/50 bg-sky-500/10 text-sky-100' : 'border-slate-800 text-slate-300'
                      }`}
                      data-testid={`backup-history-row-${i}`}
                    >
                      <span className="shrink-0 font-mono">{entry.finishedAt}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-400" title={entry.location}>
                        {entry.location}
                      </span>
                      <span className="shrink-0 text-slate-500">{formatSize(entry.sizeBytes)}</span>
                      <button
                        type="button"
                        data-testid={`backup-history-pick-${i}`}
                        disabled={chosen}
                        onClick={() => onPick(entry)}
                        className="shrink-0 rounded border border-sky-500/40 px-1.5 py-0.5 font-bold text-sky-200 disabled:opacity-50"
                      >
                        {chosen ? 'Restoring this' : 'Restore this'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      )}
    </section>
  );
};
