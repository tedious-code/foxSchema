/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL backup and restore: pg_dump, and pg_restore or psql to load it.
 *
 * pg_dump runs anywhere that reaches the server and writes where it runs. The
 * custom format is the default because it is compressed and pg_restore can
 * pick single objects out of it; plain SQL is for reading or for another
 * engine. YugabyteDB ships the same tools as ysql_dump and ysqlsh.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, portOf, shellArg } from '../../modules/utilities/backup-helpers.js';

interface PgTools {
  dump: string;
  restore: string;
  psql: string;
  /** Formats this build of the tools can write. */
  formats: BackupDialect['formats'];
}

const PG_FORMATS: BackupDialect['formats'] = [
  { id: 'custom', label: 'Custom archive (.dump)', hint: 'Compressed; pg_restore can restore single tables from it.' },
  { id: 'plain', label: 'Plain SQL (.sql)', hint: 'Readable SQL; restore with psql.' },
  { id: 'directory', label: 'Directory', hint: 'One file per table; dumps and restores in parallel.' },
  { id: 'tar', label: 'Tar archive (.tar)', hint: 'Like custom, but not compressed.' },
];

const EXTENSION: Record<string, string> = { custom: '.dump', plain: '.sql', directory: '', tar: '.tar' };

function connectionArgs(conn: BackupConnection): string[] {
  const args: string[] = [];
  if (conn.host) args.push(`--host ${shellArg(conn.host)}`);
  const port = portOf(conn.port);
  if (port) args.push(`--port ${port}`);
  if (conn.username) args.push(`--username ${shellArg(conn.username)}`);
  return args;
}

function buildPg(tools: PgTools, conn: BackupConnection, req: BackupRequest): BackupCommands {
  const format = tools.formats.some((f) => f.id === req.format) ? req.format : tools.formats[0]!.id;
  const gzip = format === 'plain' && req.compress;
  const location = joinPath(req.folder, `${req.fileName}${EXTENSION[format] ?? ''}${gzip ? '.gz' : ''}`);
  const conn_ = connectionArgs(conn);
  const db = shellArg(conn.database);

  const dump = [tools.dump, ...conn_, `--format=${format}`];
  if (req.scope === 'schema') dump.push('--schema-only');
  if (req.scope === 'data') dump.push('--data-only');
  if (req.compress && (format === 'custom' || format === 'directory')) dump.push('--compress=9');
  if (req.limitToSchema && conn.schema && req.tables.length === 0) dump.push(`--schema=${shellArg(conn.schema)}`);
  for (const t of req.tables) dump.push(`--table=${shellArg(t.includes('.') || !conn.schema ? t : `${conn.schema}.${t}`)}`);
  if (gzip) dump.push(db, '|', 'gzip', '>', shellArg(location));
  else dump.push(`--file=${shellArg(location)}`, db);

  const restore =
    format === 'plain'
      ? gzip
        ? ['gunzip', '-c', shellArg(location), '|', tools.psql, ...conn_, `--dbname=${db}`]
        : [tools.psql, ...conn_, `--dbname=${db}`, `--file=${shellArg(location)}`]
      : [tools.restore, ...conn_, `--dbname=${db}`, '--clean', '--if-exists', '--no-owner', shellArg(location)];

  const notes = [
    `${tools.dump} must be at least the server's major version; an older one refuses to dump a newer server.`,
    format === 'plain'
      ? 'A plain dump replays as SQL: restore into an empty database, or objects that already exist fail.'
      : '--clean drops each object before recreating it, so the restore replaces what is there.',
  ];
  if (format === 'tar' && req.compress) notes.push('The tar format is never compressed; choose custom or directory to compress.');
  return { language: 'shell', backup: dump.join(' '), restore: restore.join(' '), location, notes };
}

export function pgBackupDialect(tools: PgTools): BackupDialect {
  return {
    tool: `${tools.dump} / ${tools.formats.length > 1 ? tools.restore : tools.psql}`,
    runsOn: 'client',
    folder: {
      label: 'Folder',
      hint: `On the machine where you run ${tools.dump}. It must already exist.`,
      defaultValue: './backups',
    },
    formats: tools.formats,
    scopes: ['full', 'schema', 'data'],
    compression: true,
    tables: true,
    schemaLimit: true,
    passwordNote: `${tools.dump} asks for the password. To skip the prompt, set PGPASSWORD for the command or add the server to ~/.pgpass.`,
    build: (conn, req) => buildPg(tools, conn, req),
  };
}

export const postgresBackup: BackupDialect = pgBackupDialect({
  dump: 'pg_dump',
  restore: 'pg_restore',
  psql: 'psql',
  formats: PG_FORMATS,
});
