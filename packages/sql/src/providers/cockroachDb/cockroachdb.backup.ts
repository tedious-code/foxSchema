/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * CockroachDB backup and restore: its own BACKUP and RESTORE statements.
 *
 * The cluster writes the backup itself, into a collection URI: nodelocal://1/…
 * is node 1's external-io directory, and s3://, gs:// or azure:// put it in
 * cloud storage. RESTORE refuses a database that exists, so the restore here
 * brings it back under a new name to compare or rename, never over the live one.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { sqlString } from '../../modules/utilities/backup-helpers.js';

const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const db = ident(conn.database);
  const collection = `${req.folder.trim().replace(/\/+$/, '')}/${req.fileName}`;
  const restored = ident(`${conn.database}_restored`);
  if (req.tables.length > 0) {
    const tables = req.tables.map((t) => `${db}.${t.split('.').map(ident).join('.')}`).join(', ');
    return {
      language: 'sql',
      backup: `BACKUP TABLE ${tables} INTO ${sqlString(collection)} AS OF SYSTEM TIME '-10s';`,
      restore: `CREATE DATABASE IF NOT EXISTS ${restored};\nRESTORE TABLE ${tables} FROM LATEST IN ${sqlString(collection)} WITH into_db = ${sqlString(`${conn.database}_restored`)};`,
      location: collection,
      notes: ['The tables are restored into a new database; move them into place once checked.'],
    };
  }
  return {
    language: 'sql',
    backup: `BACKUP DATABASE ${db} INTO ${sqlString(collection)} AS OF SYSTEM TIME '-10s';`,
    restore: `RESTORE DATABASE ${db} FROM LATEST IN ${sqlString(collection)} WITH new_db_name = ${sqlString(`${conn.database}_restored`)};`,
    location: collection,
    notes: [
      'AS OF SYSTEM TIME reads a moment ten seconds ago, so the backup does not contend with live writes.',
      `The restore creates ${conn.database}_restored rather than overwriting ${conn.database}.`,
    ],
  };
}

export const cockroachDbBackup: BackupDialect = {
  tool: 'BACKUP / RESTORE (SQL)',
  runsOn: 'server',
  folder: {
    label: 'Collection URI',
    hint: 'Where the cluster writes: nodelocal://1/backups is node 1’s external-io directory; s3://, gs:// or azure:// for cloud storage.',
    defaultValue: 'nodelocal://1/backups',
  },
  formats: [{ id: 'native', label: 'CockroachDB backup', hint: 'The cluster’s own format, compressed; schema and data.' }],
  scopes: ['full'],
  compression: false,
  tables: true,
  schemaLimit: false,
  passwordNote: 'Runs as SQL on this connection; no separate login.',
  build,
};
