/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQLite backup and restore: the sqlite3 shell's .backup and .restore, or a
 * SQL dump.
 *
 * .backup copies the live file page by page and is safe while it is in use —
 * copying the file with cp is not. The connection's "database" is the file's
 * path.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, shellArg } from '../../modules/utilities/backup-helpers.js';

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const file = shellArg(conn.database);
  if (req.format === 'sql') {
    const location = joinPath(req.folder, `${req.fileName}.sql${req.compress ? '.gz' : ''}`);
    const dot = req.scope === 'schema' ? '.schema' : '.dump';
    const tables = req.tables.join(' ');
    const dumpCmd = `sqlite3 ${file} ${shellArg(tables ? `${dot} ${tables}` : dot)}`;
    return {
      language: 'shell',
      backup: req.compress ? `${dumpCmd} | gzip > ${shellArg(location)}` : `${dumpCmd} > ${shellArg(location)}`,
      restore: req.compress
        ? `gunzip -c ${shellArg(location)} | sqlite3 ${file}`
        : `sqlite3 ${file} < ${shellArg(location)}`,
      location,
      notes: ['A SQL dump replays as statements: restore into an empty file, or existing tables collide.'],
    };
  }
  const location = joinPath(req.folder, `${req.fileName}.db`);
  return {
    language: 'shell',
    backup: `sqlite3 ${file} ${shellArg(`.backup ${location}`)}`,
    restore: `sqlite3 ${file} ${shellArg(`.restore ${location}`)}`,
    location,
    notes: ['.restore replaces the whole database file’s contents.'],
  };
}

export const sqliteBackup: BackupDialect = {
  tool: 'sqlite3 (.backup / .dump)',
  runsOn: 'client',
  folder: { label: 'Folder', hint: 'On the machine that holds the database file. It must already exist.', defaultValue: './backups' },
  formats: [
    { id: 'db', label: 'Database copy (.db)', hint: 'An exact, consistent copy of the file.' },
    { id: 'sql', label: 'SQL dump (.sql)', hint: 'Readable SQL; can be loaded into another engine with edits.' },
  ],
  scopes: ['full', 'schema'],
  compression: true,
  tables: true,
  schemaLimit: false,
  passwordNote: 'SQLite has no login; the file’s permissions are the access control.',
  build,
};
