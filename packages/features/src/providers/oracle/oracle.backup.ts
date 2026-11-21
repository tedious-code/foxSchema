/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle backup and restore: Data Pump, expdp and impdp.
 *
 * Data Pump runs inside the database and writes on the database server, into
 * a DIRECTORY object rather than a path — so the "folder" is that object's
 * name, and creating one is a DBA's job (the hint says how). An Oracle schema
 * is a user, so a backup is per schema.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { portOf, shellArg } from '../../modules/utilities/backup-helpers.js';

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const schema = (conn.schema || conn.username || '<SCHEMA>').toUpperCase();
  const port = portOf(conn.port);
  const login = shellArg(`${conn.username ?? '<user>'}@//${conn.host ?? 'localhost'}${port ? `:${port}` : ''}/${conn.database}`);
  const directory = req.folder.trim().toUpperCase() || 'DATA_PUMP_DIR';
  const dumpfile = `${req.fileName}.dmp`;
  // Each parameter is one shell word: the file name is the reader's to edit,
  // and a space or `;` in it must not split the command.
  const what = shellArg(
    req.tables.length > 0
      ? `TABLES=${req.tables.map((t) => (t.includes('.') ? t : `${schema}.${t}`).toUpperCase()).join(',')}`
      : `SCHEMAS=${schema}`
  );
  const files = (log: string) =>
    [`DIRECTORY=${directory}`, `DUMPFILE=${dumpfile}`, `LOGFILE=${log}`].map(shellArg).join(' ');
  const content = req.scope === 'schema' ? ' CONTENT=METADATA_ONLY' : req.scope === 'data' ? ' CONTENT=DATA_ONLY' : '';
  return {
    language: 'shell',
    backup: `expdp ${login} ${what} ${files(`${req.fileName}.log`)}${content}${req.compress ? ' COMPRESSION=ALL' : ''}`,
    restore: `impdp ${login} ${what} ${files(`${req.fileName}_import.log`)} TABLE_EXISTS_ACTION=REPLACE`,
    location: `${directory}:${dumpfile}`,
    notes: [
      'The dump file is written on the database server, in the directory the DIRECTORY object points to.',
      'TABLE_EXISTS_ACTION=REPLACE drops and recreates tables that already exist.',
      ...(req.compress ? ['COMPRESSION=ALL needs the Advanced Compression option; use METADATA_ONLY compression otherwise.'] : []),
    ],
  };
}

export const oracleBackup: BackupDialect = {
  tool: 'Data Pump (expdp / impdp)',
  runsOn: 'server',
  folder: {
    label: 'DIRECTORY object',
    hint: "Data Pump writes into a DIRECTORY object on the database server. A DBA creates one: CREATE DIRECTORY backup_dir AS '/u01/backups'; GRANT READ, WRITE ON DIRECTORY backup_dir TO <user>;",
    defaultValue: 'DATA_PUMP_DIR',
  },
  formats: [{ id: 'dmp', label: 'Data Pump dump (.dmp)', hint: 'Restorable with impdp, into the same schema or remapped to another.' }],
  scopes: ['full', 'schema', 'data'],
  compression: true,
  tables: true,
  schemaLimit: false,
  passwordNote: 'expdp and impdp ask for the password when the login has none.',
  build,
};
