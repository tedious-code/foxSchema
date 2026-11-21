/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 backup and restore: the CLP's BACKUP DATABASE and RESTORE DATABASE, and
 * db2look for a schema-only copy.
 *
 * These run on the database server as the instance owner, and an image is
 * written into a folder there; Db2 names the file itself, with a timestamp.
 * A default (offline) backup needs every connection closed first; ONLINE needs
 * archive logging switched on.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, shellArg } from '../../modules/utilities/backup-helpers.js';

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const db = shellArg(conn.database.toUpperCase());
  // An image picked from DB_HISTORY: Db2 names it by its 14-digit timestamp.
  const takenAt = req.restoreFrom && /^\d{14}$/.test(req.restoreFrom) ? req.restoreFrom : null;
  const folder = req.folder.trim() || '/database/backups';
  if (req.scope === 'schema') {
    const schema = (conn.schema || conn.username || '').toUpperCase();
    const location = joinPath(folder, `${req.fileName}.sql`);
    return {
      language: 'shell',
      backup: `db2look -d ${db}${schema ? ` -z ${shellArg(schema)}` : ''} -e -o ${shellArg(location)}`,
      restore: `db2 connect to ${db} && db2 -tvf ${shellArg(location)}`,
      location,
      notes: ['db2look writes the DDL to recreate the objects, no data.'],
    };
  }
  return {
    language: 'shell',
    backup: `db2 BACKUP DATABASE ${db} TO ${shellArg(folder)}${req.compress ? ' COMPRESS' : ''} WITHOUT PROMPTING`,
    restore: `db2 RESTORE DATABASE ${db} FROM ${shellArg(folder)}${takenAt ? ` TAKEN AT ${takenAt}` : ''} REPLACE EXISTING WITHOUT PROMPTING`,
    location: folder,
    notes: [
      'An offline backup fails while anything is connected: db2 force application all, or add ONLINE once archive logging is on.',
      takenAt
        ? `The restore reads the image taken at ${takenAt}.`
        : `With more than one image in the folder, pick one under Backups on this server, or add TAKEN AT <timestamp> to the restore.`,
      'REPLACE EXISTING overwrites the database.',
    ],
  };
}

export const db2Backup: BackupDialect = {
  tool: 'db2 BACKUP / RESTORE, db2look',
  runsOn: 'server',
  folder: {
    label: 'Folder on the database server',
    hint: 'Run as the instance owner on the database server; the folder must exist and be writable by it.',
    defaultValue: '/database/backups',
  },
  formats: [{ id: 'image', label: 'Backup image (data) or DDL (schema)', hint: 'A full backup is a restorable image; a schema backup is db2look DDL.' }],
  scopes: ['full', 'schema'],
  compression: true,
  tables: false,
  schemaLimit: false,
  passwordNote: 'Runs as the instance owner on the server, who needs no password there.',
  // Read with SQL on this connection; the restore itself is a CLP command.
  history: () => `SELECT START_TIME AS finished_at, LOCATION AS location, CAST(NULL AS BIGINT) AS size_bytes,
       START_TIME AS restore_key
FROM SYSIBMADM.DB_HISTORY
WHERE OPERATION = 'B' AND OBJECTTYPE = 'D' AND COALESCE(SQLCODE, 0) >= 0
ORDER BY START_TIME DESC
FETCH FIRST 20 ROWS ONLY`,
  build,
};
