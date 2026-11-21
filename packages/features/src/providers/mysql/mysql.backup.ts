/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MySQL backup and restore: mysqldump, and the mysql client to load it.
 *
 * --single-transaction takes a consistent InnoDB snapshot without locking
 * tables, so the dump can run against a live server. MariaDB ships the same
 * tools as mariadb-dump and mariadb; TiDB accepts mysqldump but has no stored
 * routines or events to include.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, portOf, shellArg } from '../../modules/utilities/backup-helpers.js';

interface MysqlTools {
  dump: string;
  client: string;
  /** Stored routines and events exist on this engine. */
  routines: boolean;
  extraNotes?: string[];
}

function connectionArgs(conn: BackupConnection): string[] {
  const args: string[] = [];
  if (conn.host) args.push(`--host=${shellArg(conn.host)}`);
  const port = portOf(conn.port);
  if (port) args.push(`--port=${port}`);
  if (conn.username) args.push(`--user=${shellArg(conn.username)}`);
  args.push('--password');
  return args;
}

function buildMysql(tools: MysqlTools, conn: BackupConnection, req: BackupRequest): BackupCommands {
  const location = joinPath(req.folder, `${req.fileName}.sql${req.compress ? '.gz' : ''}`);
  const conn_ = connectionArgs(conn);
  const db = shellArg(conn.database);

  const dump = [tools.dump, ...conn_, '--single-transaction'];
  if (req.scope === 'schema') dump.push('--no-data');
  if (req.scope === 'data') dump.push('--no-create-info', '--skip-triggers');
  else if (tools.routines) dump.push('--routines', '--events');
  dump.push(db, ...req.tables.map(shellArg));
  dump.push(...(req.compress ? ['|', 'gzip', '>', shellArg(location)] : ['>', shellArg(location)]));

  const restore = req.compress
    ? ['gunzip', '-c', shellArg(location), '|', tools.client, ...conn_, db]
    : [tools.client, ...conn_, db, '<', shellArg(location)];

  return {
    language: 'shell',
    backup: dump.join(' '),
    restore: restore.join(' '),
    location,
    notes: [
      'The dump drops and recreates each table it holds, so a restore replaces those tables and leaves others alone.',
      ...(tools.extraNotes ?? []),
    ],
  };
}

export function mysqlFamilyBackup(tools: MysqlTools): BackupDialect {
  return {
    tool: `${tools.dump} / ${tools.client}`,
    runsOn: 'client',
    folder: { label: 'Folder', hint: `On the machine where you run ${tools.dump}. It must already exist.`, defaultValue: './backups' },
    formats: [{ id: 'sql', label: 'SQL (.sql)', hint: 'Readable SQL; restore with the client.' }],
    scopes: ['full', 'schema', 'data'],
    compression: true,
    tables: true,
    schemaLimit: false,
    passwordNote: `--password with no value makes ${tools.dump} ask for it, so it never lands in your shell history.`,
    build: (conn, req) => buildMysql(tools, conn, req),
  };
}

export const mysqlBackup: BackupDialect = mysqlFamilyBackup({ dump: 'mysqldump', client: 'mysql', routines: true });
