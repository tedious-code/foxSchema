/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Azure SQL backup and restore: SqlPackage.
 *
 * Azure SQL Database has no BACKUP TO DISK — Azure keeps point-in-time
 * backups itself. A copy you hold is an export: a .bacpac (schema and data) or
 * a .dacpac (schema only). Import needs a new, empty database, so the restore
 * names one.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, shellArg } from '../../modules/utilities/backup-helpers.js';

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const schemaOnly = req.scope === 'schema';
  const location = joinPath(req.folder, `${req.fileName}.${schemaOnly ? 'dacpac' : 'bacpac'}`);
  const server = shellArg(conn.host ?? '<server>.database.windows.net');
  const user = shellArg(conn.username ?? '<user>');
  const restored = shellArg(`${conn.database}_restored`);
  return {
    language: 'shell',
    backup: [
      'SqlPackage',
      `/Action:${schemaOnly ? 'Extract' : 'Export'}`,
      `/SourceServerName:${server}`,
      `/SourceDatabaseName:${shellArg(conn.database)}`,
      `/SourceUser:${user}`,
      '/SourcePassword:"$DB_PASSWORD"',
      `/TargetFile:${shellArg(location)}`,
    ].join(' '),
    restore: [
      'SqlPackage',
      `/Action:${schemaOnly ? 'Publish' : 'Import'}`,
      `/TargetServerName:${server}`,
      `/TargetDatabaseName:${restored}`,
      `/TargetUser:${user}`,
      '/TargetPassword:"$DB_PASSWORD"',
      `/SourceFile:${shellArg(location)}`,
    ].join(' '),
    location,
    notes: [
      'Azure already keeps point-in-time backups of the database; this is a copy you hold.',
      `The restore creates ${conn.database}_restored; import cannot load into a database that has objects.`,
    ],
  };
}

export const azureSqlBackup: BackupDialect = {
  tool: 'SqlPackage',
  runsOn: 'client',
  folder: { label: 'Folder', hint: 'On the machine where you run SqlPackage. It must already exist.', defaultValue: './backups' },
  formats: [{ id: 'bacpac', label: 'BACPAC / DACPAC', hint: 'BACPAC holds schema and data; DACPAC (schema only) is chosen for a schema backup.' }],
  scopes: ['full', 'schema'],
  compression: false,
  tables: false,
  schemaLimit: false,
  passwordNote: 'Set DB_PASSWORD in your shell first, so the password stays out of the command and its history.',
  build,
};
