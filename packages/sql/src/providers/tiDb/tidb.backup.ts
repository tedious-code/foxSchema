/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * TiDB backup and restore: mysqldump works for small databases. TiDB has no
 * stored routines or events, so the dump does not ask for them.
 */
import type { BackupDialect } from '../../modules/utilities/backup.types.js';
import { mysqlFamilyBackup } from '../mysql/mysql.backup.js';

export const tiDbBackup: BackupDialect = mysqlFamilyBackup({
  dump: 'mysqldump',
  client: 'mysql',
  routines: false,
  extraNotes: ['For large databases use TiDB’s own tools: Dumpling to export and TiDB Lightning to load, or BR for a physical backup.'],
});
