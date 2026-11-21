/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Types for backup and restore commands.
 *
 * Fox Schema writes the commands; it never runs them. A backup is a file on a
 * disk somewhere, and *where* is the first thing a reader must know: pg_dump
 * writes on the machine that runs it, SQL Server's BACKUP DATABASE on the
 * database server, Oracle Data Pump into a DIRECTORY object. `runsOn` says
 * which, and the UI leads with it.
 */

/** What the backup holds. */
export type BackupScope = 'full' | 'schema' | 'data';

/** Where the command runs, and so where `folder` is. */
export type BackupRunsOn =
  /** A command-line tool, on any machine that can reach the database. */
  | 'client'
  /** SQL the database executes itself; the file is written on the database server. */
  | 'server'
  /** A cloud provider's snapshot; there is no file to place. */
  | 'cloud';

export interface BackupFormatOption {
  id: string;
  label: string;
  /** One line: what this format is good for. */
  hint: string;
}

/** The connection a command is written for. Never carries a password. */
export interface BackupConnection {
  dialect: string;
  host?: string | null;
  port?: number | string | null;
  /** Database name; a file path on SQLite and DuckDB. */
  database: string;
  schema?: string | null;
  username?: string | null;
}

/** What a reader chooses, and what is saved per dialect as their default. */
export interface BackupSettings {
  /** Where backups go. What that means depends on the engine: see `BackupFolder`. */
  folder: string;
  /** A `BackupFormatOption` id. */
  format: string;
  scope: BackupScope;
  compress: boolean;
  /** Back up only the connection's schema rather than the whole database. */
  limitToSchema: boolean;
}

/** One backup to write commands for: the settings, plus what it is called. */
export interface BackupRequest extends BackupSettings {
  /** File name without extension; the format adds its own. */
  fileName: string;
  /** Only these tables. Empty: everything in scope. */
  tables: readonly string[];
  /**
   * A backup picked from the engine's history (its `restore_key`), for the
   * restore to read instead of the newest one in the folder. Each engine
   * checks it and quotes it; one it cannot read leaves the restore as it was.
   */
  restoreFrom?: string;
}

/** What "folder" means on an engine, so the field can say so. */
export interface BackupFolder {
  label: string;
  hint: string;
  defaultValue: string;
}

/** The commands for one backup, and its restore. */
export interface BackupCommands {
  language: 'shell' | 'sql';
  backup: string;
  restore: string;
  /** The file or location the backup produces, as the commands name it. */
  location: string;
  /** Things to know before running them. */
  notes: string[];
}

/** Everything an engine supports, and how to write its commands. */
export interface BackupDialect {
  /** The tool or statement, as a reader would search for it. */
  tool: string;
  runsOn: BackupRunsOn;
  /** Null where there is no folder (a cloud snapshot). */
  folder: BackupFolder | null;
  formats: readonly BackupFormatOption[];
  scopes: readonly BackupScope[];
  compression: boolean;
  /** Can a backup name individual tables? */
  tables: boolean;
  /** Can a backup be limited to the connection's schema? */
  schemaLimit: boolean;
  /** How the tool gets the password, since the command never contains it. */
  passwordNote: string;
  /**
   * The backups this engine has recorded, newest first, as one read-only query.
   * Columns: `finished_at`, `location`, `size_bytes` (may be null) and
   * `restore_key`, the value `BackupRequest.restoreFrom` takes. Absent where
   * the engine keeps no record (a dump file on the client is just a file).
   */
  history?(conn: BackupConnection): string;
  build(conn: BackupConnection, request: BackupRequest): BackupCommands;
}
