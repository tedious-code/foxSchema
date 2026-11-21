/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL DBA probes: pg_settings, pg_stat_activity, relation sizes.
 * CockroachDB and YugabyteDB reuse this shape through `makePostgresDbaUtilities`.
 */
import {
  noProbe,
  probeSupport,
  type DbaProbeOptions,
  type DbaUtilityDialect,
  type DbaUtilityKind,
  type DbaUtilityQuery,
  type DbaUtilitySupport,
} from '../../modules/utilities/dba-utilities.types.js';

const HINTS: Record<DbaUtilityKind, string> = {
  system: 'PostgreSQL exposes DB size and memory settings; host CPU/RAM need OS access or extensions.',
  pool: 'PostgreSQL: max_connections vs pg_stat_activity counts.',
  sessions: 'PostgreSQL: pg_stat_activity.',
  sizes: 'PostgreSQL: pg_total_relation_size / pg_indexes_size.',
};

const POOL_SQL = `
SELECT
  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
  (SELECT count(*)::int FROM pg_stat_activity) AS current_connections,
  (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active') AS active_connections,
  (SELECT count(*)::int FROM pg_stat_activity WHERE wait_event IS NOT NULL) AS wait_count,
  (SELECT setting FROM pg_settings WHERE name = 'superuser_reserved_connections') AS superuser_reserved
`.trim();

const SESSIONS_SQL = `
SELECT
  pid::text AS session_id,
  usename AS user_name,
  client_addr::text AS client_host,
  datname AS database_name,
  state,
  COALESCE(wait_event_type || ':' || wait_event, wait_event) AS wait_event,
  LEFT(query, 500) AS query_text,
  backend_start::text AS connected_at,
  application_name
FROM pg_stat_activity
WHERE backend_type = 'client backend' OR backend_type IS NULL
ORDER BY backend_start DESC NULLS LAST
LIMIT 500
`.trim();

function systemSql(uptime: string): string {
  return `
SELECT
  NULL::int AS cpu_count,
  NULL::float8 AS cpu_usage_percent,
  (SELECT setting::bigint * CASE unit WHEN '8kB' THEN 8192 WHEN 'kB' THEN 1024 ELSE 1 END
     FROM pg_settings WHERE name = 'shared_buffers') AS memory_total_bytes,
  NULL::bigint AS memory_used_bytes,
  NULL::bigint AS memory_available_bytes,
  NULL::bigint AS storage_total_bytes,
  pg_database_size(current_database()) AS storage_used_bytes,
  NULL::bigint AS storage_available_bytes,
  ${uptime},
  version() AS server_version
`.trim();
}

const SIZES_SELECT = `
SELECT
  n.nspname AS schema_name,
  c.relname AS object_name,
  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'i' THEN 'index' ELSE 'other' END AS object_type,
  COALESCE(t.relname, c.relname) AS table_name,
  pg_total_relation_size(c.oid) AS total_bytes,
  CASE WHEN c.relkind IN ('r','p') THEN pg_relation_size(c.oid) ELSE NULL END AS data_bytes,
  CASE WHEN c.relkind IN ('r','p') THEN pg_indexes_size(c.oid) WHEN c.relkind = 'i' THEN pg_relation_size(c.oid) ELSE NULL END AS index_bytes,
  c.reltuples::bigint AS row_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index i ON i.indexrelid = c.oid
LEFT JOIN pg_class t ON t.oid = i.indrelid`.trim();

const SIZES_TAIL = `
  AND c.relkind IN ('r','p','i','m')
ORDER BY pg_total_relation_size(c.oid) DESC NULLS LAST
LIMIT 1000`;

function sizesQuery(schema: string, mode: DbaProbeOptions['mode']): DbaUtilityQuery {
  return {
    mode,
    params: schema ? [schema] : [],
    sql: schema
      ? `${SIZES_SELECT}\nWHERE n.nspname = $1${SIZES_TAIL}`
      : `${SIZES_SELECT}\nWHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')${SIZES_TAIL}`,
  };
}

export interface PostgresDbaVariant {
  id: string;
  /** Appended to every hint: `(CockroachDB may differ)`. */
  hintSuffix?: string;
  /** Wire-compatible forks answer estimates, not native figures. */
  mode?: 'native' | 'estimated';
  /**
   * CockroachDB has no pg_postmaster_start_time(); the call fails with
   * "unknown function" and takes the whole System tab with it.
   */
  hasPostmasterStartTime?: boolean;
}

export function makePostgresDbaUtilities(variant: PostgresDbaVariant): DbaUtilityDialect {
  const base = probeSupport(HINTS);
  const support = (kind: DbaUtilityKind): DbaUtilitySupport => {
    const s = base(kind);
    return {
      mode: variant.mode ?? s.mode,
      query: s.query,
      hint: variant.hintSuffix ? `${s.hint} ${variant.hintSuffix}` : s.hint,
    };
  };
  const uptime =
    variant.hasPostmasterStartTime === false
      ? 'NULL::bigint AS uptime_seconds'
      : 'EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_seconds';
  return {
    id: variant.id,
    support,
    build(kind, opts) {
      switch (kind) {
        case 'pool':
          return { mode: opts.mode, params: [], sql: POOL_SQL };
        case 'sessions':
          return { mode: opts.mode, params: [], sql: SESSIONS_SQL };
        case 'system':
          return { mode: opts.mode, params: [], sql: systemSql(uptime) };
        case 'sizes':
          return sizesQuery(opts.schema, opts.mode);
        default:
          return noProbe(kind);
      }
    },
  };
}

export const postgresDbaUtilities = makePostgresDbaUtilities({ id: 'postgres' });
