/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * ClickHouse backup and restore: its BACKUP and RESTORE statements.
 *
 * The server writes the backup to a disk named in its configuration
 * (`<backups><allowed_disk>`), so the "folder" is that disk's name. The
 * restore brings the database back under a new name, beside the live one.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { sqlString } from '../../modules/utilities/backup-helpers.js';

const ident = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``);

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const disk = req.folder.trim() || 'backups';
  const file = `${req.fileName}${req.compress ? '.zip' : ''}`;
  const target = `Disk(${sqlString(disk)}, ${sqlString(file)})`;
  const db = ident(conn.database);
  const restored = ident(`${conn.database}_restored`);
  const what = req.tables.length > 0 ? req.tables.map((t) => `TABLE ${db}.${ident(t)}`).join(', ') : `DATABASE ${db}`;
  const restoreWhat =
    req.tables.length > 0
      ? req.tables.map((t) => `TABLE ${db}.${ident(t)} AS ${restored}.${ident(t)}`).join(', ')
      : `DATABASE ${db} AS ${restored}`;
  return {
    language: 'sql',
    backup: `BACKUP ${what} TO ${target};`,
    restore: `${req.tables.length > 0 ? `CREATE DATABASE IF NOT EXISTS ${restored};\n` : ''}RESTORE ${restoreWhat} FROM ${target};`,
    location: `${disk}:${file}`,
    notes: [
      `The disk ${disk} must be listed under <backups><allowed_disk> in the server configuration.`,
      `The restore creates ${conn.database}_restored beside the live database.`,
    ],
  };
}

export const clickHouseBackup: BackupDialect = {
  tool: 'BACKUP / RESTORE (SQL)',
  runsOn: 'server',
  folder: {
    label: 'Backup disk',
    hint: 'A disk from the server’s storage configuration that is allowed for backups (<backups><allowed_disk>).',
    defaultValue: 'backups',
  },
  formats: [{ id: 'native', label: 'ClickHouse backup', hint: 'Compressed as a .zip archive, or a plain folder.' }],
  scopes: ['full'],
  compression: true,
  tables: true,
  schemaLimit: false,
  passwordNote: 'Runs as SQL on this connection; the user needs the BACKUP privilege.',
  build,
};
