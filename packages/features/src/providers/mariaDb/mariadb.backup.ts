/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MariaDB backup and restore: mariadb-dump and the mariadb client, its own
 * names for mysqldump and mysql (which newer releases no longer ship).
 */
import type { BackupDialect } from '../../modules/utilities/backup.types.js';
import { mysqlFamilyBackup } from '../mysql/mysql.backup.js';

export const mariaDbBackup: BackupDialect = mysqlFamilyBackup({
  dump: 'mariadb-dump',
  client: 'mariadb',
  routines: true,
});
