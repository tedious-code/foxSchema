/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for the index fragmentation probes. Dialect modules import
 * from here, not from `index-fragmentation.ts`, so the registry can load them
 * without a cycle.
 */
import { quoteSqlIdentifier } from '@foxschema/sql';

export type IndexFragmentationMode = 'physical' | 'estimated' | 'unsupported';

export interface IndexFragmentationSupport {
  mode: IndexFragmentationMode;
  /** Engine has a built-in SELECT we can try first. */
  query: boolean;
  /** We can suggest REBUILD / REORG / OPTIMIZE / REINDEX SQL. */
  defrag: boolean;
  hint: string;
  /** Shape admins should return from custom SQL. */
  customSqlHint: string;
}

export type IndexProbeMode = Exclude<IndexFragmentationMode, 'unsupported'>;

export interface IndexFragmentationQuery {
  sql: string;
  params: unknown[];
  mode: IndexProbeMode;
  /**
   * A second probe to try when the first fails because an optional server
   * feature is missing — Postgres `pgstatindex` needs the `pgstattuple`
   * extension, which most managed servers do not install by default.
   *
   * The fallback answers a strictly smaller question (no fragmentation
   * percent), but index list, size, and usage are what the panel is mostly
   * read for, and those need no extension. A dead panel is the worse answer.
   */
  fallback?: { sql: string; params: unknown[]; mode: IndexProbeMode; warning: string };
}

export interface IndexFragmentationRow {
  indexName: string;
  /** 0–100 when known; null when the engine could not compute a percent. */
  fragmentationPercent: number | null;
  pageCount?: number | null;
  /**
   * Last time the engine observed this index being used (ISO-8601), when the
   * dialect exposes it. Null means unknown or never (see `scanCount`).
   */
  lastUsed?: string | null;
  /**
   * User seeks/scans/lookups (SQL Server) or `idx_scan` (Postgres family).
   * Null when the dialect has no usage counter. `0` means never used.
   */
  scanCount?: number | null;
}

export type IndexFragmentationSeverity = 'ok' | 'warn' | 'critical' | 'unknown';

export type IndexUsageQuery = { sql: string; params: unknown[] };

export const CUSTOM_HINT =
  'Custom SQL must return columns index_name, fragmentation_percent (0–100), optional page_count, last_used, scan_count.';

/** The table a probe or statement is about, already split and trimmed. */
export interface IndexTarget {
  dialect: string;
  /** Empty when neither the name nor the connection supplied one. */
  schema: string;
  table: string;
}

/** Quoted identifiers for one table and its indexes, in this engine's style. */
export interface QuotedIndexTarget {
  table: string;
  index: (name: string) => string;
  /** `schema.index` where the engine addresses indexes by schema. */
  indexQualified: (name: string) => string;
}

export function quoteIndexTarget(target: IndexTarget): QuotedIndexTarget {
  const q = (name: string) => quoteSqlIdentifier(name, target.dialect);
  const { schema, table } = target;
  return {
    table: schema ? `${q(schema)}.${q(table)}` : q(table),
    index: q,
    indexQualified: (name) => (schema ? `${q(schema)}.${q(name)}` : q(name)),
  };
}

/**
 * One engine's index maintenance vocabulary.
 *
 * Every method is given a target whose `table` is non-empty; the facade rejects
 * blank names before dispatching. Engines return `[]` or `{ error }` for the
 * pieces they cannot express rather than approximate SQL.
 */
export interface IndexFragmentationDialect {
  readonly id: string;
  readonly support: IndexFragmentationSupport;
  /** What the engine calls the operation, for buttons and confirmations. */
  readonly maintenanceVerb: string;
  probe(target: IndexTarget): IndexFragmentationQuery | { error: string };
  /**
   * Extra SELECTs that fill `last_used` / `scan_count` from usage catalogs,
   * tried in order until one succeeds. Empty when the probe already joins them.
   */
  usageQueries(target: IndexTarget): IndexUsageQuery[];
  defragSql(target: IndexTarget, indexName: string, fragmentationPercent?: number | null): string[];
  dropSql(target: IndexTarget, indexName: string): string[];
  /** Example custom SELECT admins can paste when the default probe fails. */
  customTemplate(target: IndexTarget): string;
}
