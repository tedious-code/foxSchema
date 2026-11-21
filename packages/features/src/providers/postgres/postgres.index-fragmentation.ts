/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL index fragmentation: leaf_fragmentation via pgstatindex from the
 * pgstattuple extension. `pgstattuple` itself reports *table* statistics and
 * has no leaf_fragmentation column — naming it here failed twice over: without
 * the extension Postgres says the function does not exist, and with it
 * installed the column does not exist either.
 *
 * CockroachDB and YugabyteDB reuse this shape through
 * `makePostgresIndexFragmentation`; they can never answer pgstatindex.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
  type IndexFragmentationQuery,
  type IndexFragmentationSupport,
  type IndexTarget,
  type IndexUsageQuery,
} from '../../modules/utilities/index-fragmentation.types.js';

/**
 * Index facts that need no extension: name, size in pages and whether anything
 * has ever scanned it. No fragmentation percent — that is the one thing
 * pgstatindex was for, and reporting a guess would be worse than reporting
 * nothing.
 */
export const PG_NO_EXTENSION_FRAGMENTATION_SQL = `
SELECT
  ci.relname AS index_name,
  NULL::float8 AS fragmentation_percent,
  ci.relpages::bigint AS page_count,
  NULL::timestamptz AS last_used,
  COALESCE(psi.idx_scan, 0)::bigint AS scan_count
FROM pg_index ix
JOIN pg_class ct ON ct.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = ct.relnamespace
JOIN pg_class ci ON ci.oid = ix.indexrelid
LEFT JOIN pg_stat_user_indexes psi ON psi.indexrelid = ci.oid
WHERE n.nspname = $1
  AND ct.relname = $2
ORDER BY ci.relname
`.trim();

const PGSTATINDEX_SQL = `
SELECT
  ci.relname AS index_name,
  -- pgstatindex reports NaN for an index with no leaf pages yet; that is
  -- "nothing measured", not a number, and "NaN%" in the grid reads as a bug.
  -- Schema-qualified on purpose. The connection's search_path is the schema
  -- being inspected, not public, so an unqualified call resolved for nobody
  -- except users working in public. CREATE EXTENSION puts pgstattuple in
  -- public by default; an install elsewhere still fails cleanly and takes the
  -- no-extension fallback, which names the extension in its warning.
  NULLIF((SELECT leaf_fragmentation FROM public.pgstatindex(ci.oid::regclass)), 'NaN'::float8) AS fragmentation_percent,
  NULL::bigint AS page_count,
  -- last_idx_scan exists only on PostgreSQL 16+; keep last_used NULL so older
  -- servers (and Cockroach / Yugabyte) still run this probe. idx_scan is the usage signal.
  NULL::timestamptz AS last_used,
  COALESCE(psi.idx_scan, 0)::bigint AS scan_count
FROM pg_index ix
JOIN pg_class ct ON ct.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = ct.relnamespace
JOIN pg_class ci ON ci.oid = ix.indexrelid
LEFT JOIN pg_stat_user_indexes psi ON psi.indexrelid = ci.oid
WHERE n.nspname = $1
  AND ct.relname = $2
ORDER BY ci.relname
`.trim();

const LAST_IDX_SCAN_SQL = `
SELECT
  ci.relname AS index_name,
  psi.last_idx_scan AS last_used,
  COALESCE(psi.idx_scan, 0)::bigint AS scan_count
FROM pg_index ix
JOIN pg_class ct ON ct.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = ct.relnamespace
JOIN pg_class ci ON ci.oid = ix.indexrelid
LEFT JOIN pg_stat_user_indexes psi ON psi.indexrelid = ci.oid
WHERE n.nspname = $1
  AND ct.relname = $2
`.trim();

export interface PostgresIndexFragmentationVariant {
  id: string;
  support: IndexFragmentationSupport;
  /**
   * Only real PostgreSQL tries pgstatindex. Cockroach has no pgstattuple at
   * all ("unknown function"), and Yugabyte stores every index in LSM form, so
   * the call dies with "is not a btree index" — a message that does not even
   * name the function, so the missing-extension fallback would not catch it.
   * The forks skip the doomed round trip and report what they can answer.
   */
  hasPgstatindex: boolean;
  /** CONCURRENTLY avoids long locks on Postgres; Cockroach may ignore/reject it. */
  reindexConcurrently: boolean;
}

export function makePostgresIndexFragmentation(
  variant: PostgresIndexFragmentationVariant
): IndexFragmentationDialect {
  const params = (t: IndexTarget) => [t.schema || 'public', t.table];
  return {
    id: variant.id,
    support: variant.support,
    maintenanceVerb: 'Reindex',
    probe(target): IndexFragmentationQuery {
      if (!variant.hasPgstatindex) {
        return { mode: 'estimated', params: params(target), sql: PG_NO_EXTENSION_FRAGMENTATION_SQL };
      }
      return {
        mode: 'physical',
        params: params(target),
        sql: PGSTATINDEX_SQL,
        // pgstatindex lives in the pgstattuple extension, which most servers do
        // not install. Without it there is no fragmentation percent to report —
        // but the index list, its size, and whether anything has ever used it
        // need nothing but the core catalogs, and that is most of the panel.
        fallback: {
          mode: 'estimated',
          params: params(target),
          warning:
            'Fragmentation needs the pgstattuple extension (CREATE EXTENSION pgstattuple). Showing index size and usage only.',
          sql: PG_NO_EXTENSION_FRAGMENTATION_SQL,
        },
      };
    },
    usageQueries(target): IndexUsageQuery[] {
      return [{ params: params(target), sql: LAST_IDX_SCAN_SQL }];
    },
    defragSql(target, indexName) {
      if (!variant.support.defrag) return [];
      const q = quoteIndexTarget(target);
      return variant.reindexConcurrently
        ? [`REINDEX INDEX CONCURRENTLY ${q.indexQualified(indexName)};`]
        : [`REINDEX INDEX ${q.indexQualified(indexName)};`];
    },
    dropSql(target, indexName) {
      return [`DROP INDEX IF EXISTS ${quoteIndexTarget(target).indexQualified(indexName)};`];
    },
    customTemplate(target) {
      const sch = target.schema || 'schema';
      const tbl = target.table || 'table';
      return `-- Requires: CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT ci.relname AS index_name,
       (pgstatindex(ci.oid::regclass)).leaf_fragmentation AS fragmentation_percent,
       psi.last_idx_scan AS last_used,
       COALESCE(psi.idx_scan, 0)::bigint AS scan_count
FROM pg_index ix
JOIN pg_class ct ON ct.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = ct.relnamespace
JOIN pg_class ci ON ci.oid = ix.indexrelid
LEFT JOIN pg_stat_user_indexes psi ON psi.indexrelid = ci.oid
WHERE n.nspname = '${sch}' AND ct.relname = '${tbl}';`;
    },
  };
}

export const postgresIndexFragmentation = makePostgresIndexFragmentation({
  id: 'postgres',
  support: {
    mode: 'physical',
    query: true,
    defrag: true,
    hint: 'PostgreSQL: leaf_fragmentation via pgstatindex (pgstattuple extension). Last used from pg_stat_user_indexes.last_idx_scan on PG 16+; idx_scan on older servers.',
    customSqlHint: CUSTOM_HINT,
  },
  hasPgstatindex: true,
  reindexConcurrently: true,
});
