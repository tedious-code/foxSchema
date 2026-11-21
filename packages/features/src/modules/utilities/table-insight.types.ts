/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Catalog-only table insight. Never scan live rows; never COUNT(DISTINCT).
 */
import { quoteSqlIdentifier } from '@foxschema/sql';

export type TableInsightMode = 'catalog' | 'unsupported';

export interface TableInsightSupport {
  mode: TableInsightMode;
  query: boolean;
  hint: string;
}

export interface TableInsightQuery {
  sql: string;
  params: unknown[];
  mode: 'catalog';
}

export interface TableInsightColumn {
  name: string;
  nDistinct: number | null;
  nullFrac: number | null;
}

export interface TableInsightResult {
  table: string;
  schema: string;
  estimatedRows: number | null;
  /**
   * Bytes the table occupies, table plus indexes, as the catalog reports it.
   *
   * Null where the engine has no dependable answer rather than a guessed one:
   * Oracle and Db2 expose only a page count whose page size varies per
   * tablespace, and SQLite/DuckDB carry no size in their stat tables at all. A
   * plausible wrong number is worse here than a dash, because a size is the
   * kind of figure people act on.
   */
  sizeBytes: number | null;
  columns: TableInsightColumn[];
  mode: TableInsightMode;
  support: TableInsightSupport;
  warning?: string;
}

export interface TableInsightTarget {
  schema: string;
  table: string;
}

export interface TableInsightDialect {
  readonly id: string;
  support: TableInsightSupport;
  probe(target: TableInsightTarget): TableInsightQuery | { error: string };
}

export function quotedInsightTarget(dialect: string, target: TableInsightTarget): {
  schema: string;
  table: string;
} {
  return {
    schema: quoteSqlIdentifier(target.schema || '', dialect),
    table: quoteSqlIdentifier(target.table, dialect),
  };
}
