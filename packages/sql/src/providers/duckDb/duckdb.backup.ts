/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * DuckDB backup and restore: EXPORT DATABASE and IMPORT DATABASE.
 *
 * DuckDB runs inside whichever process opened the file — here, Fox Schema's
 * server — so the folder is a path on that machine. EXPORT writes the schema,
 * a load script and one file per table; IMPORT expects an empty database.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, sqlString } from '../../modules/utilities/backup-helpers.js';

function build(_conn: BackupConnection, req: BackupRequest): BackupCommands {
  const location = joinPath(req.folder, req.fileName);
  const format = req.format === 'csv' ? 'CSV' : 'PARQUET';
  return {
    language: 'sql',
    backup: `EXPORT DATABASE ${sqlString(location)} (FORMAT ${format});`,
    restore: `IMPORT DATABASE ${sqlString(location)};`,
    location,
    notes: ['IMPORT DATABASE loads into the database it runs in, which should be empty.'],
  };
}

export const duckDbBackup: BackupDialect = {
  tool: 'EXPORT / IMPORT DATABASE (SQL)',
  runsOn: 'server',
  folder: {
    label: 'Folder',
    hint: 'On the machine running Fox Schema, which opens the DuckDB file. It must already exist; the backup is a new folder inside it.',
    defaultValue: './backups',
  },
  formats: [
    { id: 'parquet', label: 'Parquet', hint: 'Compact and typed; the usual choice.' },
    { id: 'csv', label: 'CSV', hint: 'Readable by anything, larger, loses some types.' },
  ],
  scopes: ['full'],
  compression: false,
  tables: false,
  schemaLimit: false,
  passwordNote: 'Runs as SQL on this connection; DuckDB has no login.',
  build,
};
