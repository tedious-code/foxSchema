/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * YugabyteDB backup and restore: ysql_dump and ysqlsh, its builds of pg_dump
 * and psql. Plain SQL only — that is the format YugabyteDB documents for them.
 */
import type { BackupDialect } from '../../modules/utilities/backup.types.js';
import { pgBackupDialect } from '../postgres/postgres.backup.js';

export const yugabyteDbBackup: BackupDialect = pgBackupDialect({
  dump: 'ysql_dump',
  restore: 'ysqlsh',
  psql: 'ysqlsh',
  formats: [{ id: 'plain', label: 'Plain SQL (.sql)', hint: 'Readable SQL; restore with ysqlsh.' }],
});
