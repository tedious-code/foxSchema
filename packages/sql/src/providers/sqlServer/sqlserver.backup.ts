/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server backup and restore: BACKUP DATABASE and RESTORE DATABASE.
 *
 * The server writes the .bak itself, so the folder is a path on the database
 * server and the service account must be able to write there. COPY_ONLY keeps
 * this backup out of the log-backup chain a DBA's schedule depends on.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath } from '../../modules/utilities/backup-helpers.js';

const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const nString = (value: string) => `N'${value.replace(/'/g, "''")}'`;

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const db = bracket(conn.database);
  const location = joinPath(req.folder, `${req.fileName}.bak`);
  // A file picked from msdb's history; any path is quoted as a string.
  const restoreFile = req.restoreFrom || location;
  const options = ['COPY_ONLY', 'INIT', 'CHECKSUM', ...(req.compress ? ['COMPRESSION'] : []), 'STATS = 10'];
  return {
    language: 'sql',
    backup: `BACKUP DATABASE ${db}\n  TO DISK = ${nString(location)}\n  WITH ${options.join(', ')};`,
    restore: [
      'USE [master];',
      `ALTER DATABASE ${db} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
      `RESTORE DATABASE ${db}\n  FROM DISK = ${nString(restoreFile)}\n  WITH REPLACE, RECOVERY, STATS = 10;`,
      `ALTER DATABASE ${db} SET MULTI_USER;`,
    ].join('\n'),
    location,
    notes: [
      'The restore overwrites the database (REPLACE) and first disconnects everyone in it.',
      ...(req.compress ? ['Express edition cannot compress backups; untick compression there.'] : []),
    ],
  };
}

export const sqlServerBackup: BackupDialect = {
  tool: 'BACKUP / RESTORE DATABASE (T-SQL)',
  runsOn: 'server',
  folder: {
    label: 'Folder on the database server',
    hint: 'SQL Server writes the file itself: /var/opt/mssql/backups on Linux, C:\\Backups on Windows. The folder must exist, and the service account needs write access.',
    defaultValue: '/var/opt/mssql/backups',
  },
  formats: [{ id: 'bak', label: 'Full backup (.bak)', hint: 'Schema and data, restorable to any SQL Server of the same or a newer version.' }],
  scopes: ['full'],
  compression: true,
  tables: false,
  schemaLimit: false,
  passwordNote: 'Runs as SQL on this connection; the login needs BACKUP DATABASE (db_backupoperator) and, to restore, dbcreator.',
  // msdb records every backup the server took, by file. No TOP: the SQL
  // editor's pager appends OFFSET … FETCH to a statement that has an ORDER BY,
  // and SQL Server refuses TOP beside OFFSET, so the listing failed there.
  history: (conn) => `SELECT
  b.backup_finish_date AS finished_at,
  m.physical_device_name AS location,
  b.backup_size AS size_bytes,
  m.physical_device_name AS restore_key
FROM msdb.dbo.backupset b
JOIN msdb.dbo.backupmediafamily m ON m.media_set_id = b.media_set_id
WHERE b.database_name = ${nString(conn.database)} AND b.type = 'D'
ORDER BY b.backup_finish_date DESC;`,
  build,
};
