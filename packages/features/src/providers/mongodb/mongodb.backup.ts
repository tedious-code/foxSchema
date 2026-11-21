/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MongoDB backup and restore: mongodump and mongorestore, with one gzipped
 * archive file rather than a folder of BSON per collection.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, portOf, shellArg } from '../../modules/utilities/backup-helpers.js';

function connectionArgs(conn: BackupConnection): string[] {
  const args: string[] = [];
  if (conn.host) args.push(`--host=${shellArg(conn.host)}`);
  const port = portOf(conn.port);
  if (port) args.push(`--port=${port}`);
  if (conn.username) args.push(`--username=${shellArg(conn.username)}`, '--authenticationDatabase=admin');
  return args;
}

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const location = joinPath(req.folder, `${req.fileName}.archive${req.compress ? '.gz' : ''}`);
  const gzip = req.compress ? ['--gzip'] : [];
  const conn_ = connectionArgs(conn);
  const collections = req.tables.map((c) => `--collection=${shellArg(c)}`);
  return {
    language: 'shell',
    backup: ['mongodump', ...conn_, `--db=${shellArg(conn.database)}`, ...collections, `--archive=${shellArg(location)}`, ...gzip].join(' '),
    restore: ['mongorestore', ...conn_, `--nsInclude=${shellArg(`${conn.database}.*`)}`, '--drop', `--archive=${shellArg(location)}`, ...gzip].join(' '),
    location,
    notes: ['--drop removes each collection before restoring it.'],
  };
}

export const mongoDbBackup: BackupDialect = {
  tool: 'mongodump / mongorestore',
  runsOn: 'client',
  folder: { label: 'Folder', hint: 'On the machine where you run mongodump. It must already exist.', defaultValue: './backups' },
  formats: [{ id: 'archive', label: 'Archive file', hint: 'One file for the whole database.' }],
  scopes: ['full'],
  compression: true,
  tables: true,
  schemaLimit: false,
  passwordNote: 'mongodump asks for the password when --username is given without one.',
  build,
};
