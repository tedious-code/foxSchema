/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MariaDB is its own family here, not a MySQL alias.
 *
 * Two of the MySQL probes are wrong on it, both verified against MariaDB 11.8.
 * `@@innodb_buffer_pool_instances` was removed in MariaDB 10.5, so System info
 * died on `Unknown system variable` before returning anything. And
 * `performance_schema` is off by default, so the status lookups the pool probe
 * leans on came back *empty* — no error, a blank connection count, which is
 * worse. MariaDB keeps the same figures in `information_schema.GLOBAL_STATUS`.
 */
import {
  noProbe,
  probeSupport,
  type DbaUtilityDialect,
  type DbaUtilityKind,
} from '../../modules/utilities/dba-utilities.types.js';
import { MYSQL_SESSIONS_SQL, MYSQL_SIZES_SQL } from '../mysql/mysql.dba-utilities.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'MariaDB: status/variables (buffer pool, uptime). Host disk/CPU are limited.',
  pool: 'MariaDB: max_connections, Threads_connected, Threads_running.',
  sessions: 'MariaDB: information_schema.PROCESSLIST.',
  sizes: 'MariaDB: information_schema.TABLES DATA_LENGTH / INDEX_LENGTH.',
};

const POOL_SQL = `
SELECT
  CAST(@@max_connections AS SIGNED) AS max_connections,
  (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_connected' LIMIT 1) AS current_connections,
  (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_running' LIMIT 1) AS active_connections,
  (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_cached' LIMIT 1) AS available_connections,
  (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Connection_errors_max_connections' LIMIT 1) AS wait_count
`.trim();

const SYSTEM_SQL = `
SELECT
  NULL AS cpu_count,
  NULL AS cpu_usage_percent,
  CAST(@@innodb_buffer_pool_size AS SIGNED) AS memory_total_bytes,
  NULL AS memory_used_bytes,
  NULL AS memory_available_bytes,
  NULL AS storage_total_bytes,
  (SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS storage_used_bytes,
  NULL AS storage_available_bytes,
  (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Uptime' LIMIT 1) AS uptime_seconds,
  VERSION() AS server_version
`.trim();

export const mariaDbDbaUtilities: DbaUtilityDialect = {
  id: 'mariadb',
  support: probeSupport(HINTS),
  build(kind, opts) {
    switch (kind) {
      case 'pool':
        return { mode: opts.mode, params: [], sql: POOL_SQL };
      case 'sessions':
        return { mode: opts.mode, params: [], sql: MYSQL_SESSIONS_SQL };
      case 'system':
        return { mode: opts.mode, params: [], sql: SYSTEM_SQL };
      case 'sizes':
        return { mode: opts.mode, params: [], sql: MYSQL_SIZES_SQL };
      default:
        return noProbe(kind);
    }
  },
};
