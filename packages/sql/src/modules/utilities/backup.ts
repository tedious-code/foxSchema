/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup and restore commands, for every engine Fox Schema connects to.
 *
 * Fox Schema writes the commands and never runs them: a backup is the first
 * thing a DBA wants to control, and the tools that take one (pg_dump,
 * mysqldump, Data Pump, BACKUP DATABASE) are where they will want to run it.
 * This facade resolves the engine, settles a reader's settings against what
 * that engine supports, and names the file; the provider files write the
 * commands.
 */
import type {
  BackupCommands,
  BackupConnection,
  BackupDialect,
  BackupRequest,
  BackupScope,
  BackupSettings,
} from './backup.types.js';
import { resolveBackup } from './backup.registry.js';

export type {
  BackupCommands,
  BackupConnection,
  BackupDialect,
  BackupFolder,
  BackupFormatOption,
  BackupRequest,
  BackupRunsOn,
  BackupScope,
  BackupSettings,
} from './backup.types.js';

export const BACKUP_SCOPES: readonly BackupScope[] = ['full', 'schema', 'data'];

/** What an engine supports, without the builder. Undefined for an engine with none. */
export function backupSupport(dialect: string): Omit<BackupDialect, 'build'> | undefined {
  const found = resolveBackup(dialect);
  if (!found) return undefined;
  const { build: _build, ...support } = found;
  return support;
}

/** One backup the engine recorded, as `BackupDialect.history` reports it. */
export interface BackupHistoryEntry {
  finishedAt: string;
  location: string;
  sizeBytes: number | null;
  /** What `restoreFrom` takes to restore this backup. */
  restoreKey: string;
}

/** The query listing this connection's recorded backups, or null where the engine keeps none. */
export function backupHistoryQuery(conn: BackupConnection): string | null {
  return resolveBackup(conn.dialect)?.history?.(conn) ?? null;
}

/** History rows in any column case (Db2 answers in capitals), newest first as queried. */
export function normalizeBackupHistory(rows: readonly Record<string, unknown>[]): BackupHistoryEntry[] {
  const field = (row: Record<string, unknown>, name: string): unknown => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name);
    return key === undefined ? undefined : row[key];
  };
  const text = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? '' : String(v).trim());
  return rows
    .map((row) => {
      const size = Number(field(row, 'size_bytes'));
      return {
        finishedAt: text(field(row, 'finished_at')),
        location: text(field(row, 'location')),
        sizeBytes: field(row, 'size_bytes') == null || !Number.isFinite(size) ? null : size,
        restoreKey: text(field(row, 'restore_key')),
      };
    })
    .filter((e) => e.restoreKey);
}

/** A first-time reader's settings for an engine. */
export function defaultBackupSettings(dialect: string): BackupSettings {
  const support = resolveBackup(dialect);
  return {
    folder: support?.folder?.defaultValue ?? '',
    format: support?.formats[0]?.id ?? '',
    scope: 'full',
    compress: support?.compression ?? false,
    limitToSchema: false,
  };
}

/**
 * Settings an engine can honour, from whatever was saved or typed.
 *
 * A saved default can outlive the options it was saved with, and arrives from
 * storage as untyped JSON, so every field is checked rather than trusted: a
 * missing or mistyped one takes the engine's default, an unknown format its
 * first, a scope it lacks full.
 */
export function normalizeBackupSettings(dialect: string, input: unknown): BackupSettings {
  const base = defaultBackupSettings(dialect);
  const support = resolveBackup(dialect);
  if (!support || !input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;
  const folder = typeof raw.folder === 'string' ? raw.folder.trim().slice(0, 1024) : base.folder;
  const format = typeof raw.format === 'string' && support.formats.some((f) => f.id === raw.format) ? raw.format : base.format;
  const scope = support.scopes.includes(raw.scope as BackupScope) ? (raw.scope as BackupScope) : base.scope;
  return {
    folder: support.folder ? folder || base.folder : '',
    format,
    scope,
    compress: support.compression && (typeof raw.compress === 'boolean' ? raw.compress : base.compress),
    limitToSchema: support.schemaLimit && (typeof raw.limitToSchema === 'boolean' ? raw.limitToSchema : base.limitToSchema),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `orders_20261004_153000`: the database, then when — sortable, and safe in every tool's file names. */
export function backupFileName(database: string, now: Date): string {
  const base = (database.split(/[\\/]/).pop() ?? database).replace(/\.(db|sqlite3?|duckdb)$/i, '');
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'backup';
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${safe}_${stamp}`;
}

/** Table names from a comma- or line-separated list, de-duplicated, blanks dropped. */
export function parseTableList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];
}

/**
 * The backup and restore commands for one connection.
 *
 * An error, rather than half a command, when the engine has no backup support,
 * the connection names no database, or the folder the engine needs is empty.
 */
export function buildBackupCommands(
  conn: BackupConnection,
  settings: Partial<BackupSettings> & { fileName?: string; tables?: readonly string[]; restoreFrom?: string },
  now: Date = new Date()
): BackupCommands | { error: string } {
  const support = resolveBackup(conn.dialect);
  if (!support) return { error: `Fox Schema has no backup commands for ${conn.dialect || 'this engine'}.` };
  if (!conn.database?.trim()) return { error: 'This connection names no database to back up.' };
  const settled = normalizeBackupSettings(conn.dialect, settings);
  if (support.folder && !settled.folder) return { error: `${support.folder.label} is required.` };
  const request: BackupRequest = {
    ...settled,
    fileName: settings.fileName?.trim() || backupFileName(conn.database, now),
    tables: support.tables ? [...(settings.tables ?? [])].map((t) => t.trim()).filter(Boolean) : [],
    restoreFrom: settings.restoreFrom?.trim() || undefined,
  };
  return support.build(conn, request);
}
