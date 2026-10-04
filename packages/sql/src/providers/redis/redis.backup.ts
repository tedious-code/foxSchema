/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redis backup and restore: redis-cli --rdb fetches a snapshot of the whole
 * server. There is no restore command — Redis loads dump.rdb when it starts —
 * so the restore is the steps, as comments.
 */
import type { BackupCommands, BackupConnection, BackupDialect, BackupRequest } from '../../modules/utilities/backup.types.js';
import { joinPath, portOf, shellArg } from '../../modules/utilities/backup-helpers.js';

function build(conn: BackupConnection, req: BackupRequest): BackupCommands {
  const location = joinPath(req.folder, `${req.fileName}.rdb`);
  const args = ['redis-cli'];
  if (conn.host) args.push(`-h ${shellArg(conn.host)}`);
  const port = portOf(conn.port);
  if (port) args.push(`-p ${port}`);
  if (conn.username) args.push(`--user ${shellArg(conn.username)}`);
  args.push('--askpass', `--rdb ${shellArg(location)}`);
  return {
    language: 'shell',
    backup: args.join(' '),
    restore: [
      '# Redis loads its snapshot at startup; there is no restore command.',
      '# 1. Stop the server.',
      `# 2. Copy ${location} over dump.rdb in its data directory (redis-cli CONFIG GET dir shows it).`,
      '# 3. Turn appendonly off if it is on, or the AOF file wins over the snapshot.',
      '# 4. Start the server.',
    ].join('\n'),
    location,
    notes: ['The snapshot holds every database on the server, not only this one.'],
  };
}

export const redisBackup: BackupDialect = {
  tool: 'redis-cli --rdb',
  runsOn: 'client',
  folder: { label: 'Folder', hint: 'On the machine where you run redis-cli. It must already exist.', defaultValue: './backups' },
  formats: [{ id: 'rdb', label: 'RDB snapshot', hint: 'The server’s own snapshot format.' }],
  scopes: ['full'],
  compression: false,
  tables: false,
  schemaLimit: false,
  passwordNote: '--askpass makes redis-cli ask for the password instead of taking it on the command line.',
  build,
};
