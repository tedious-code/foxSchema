/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Last Id paging: when ORDER BY is a unique key prefix, Next walks from the
 * last row instead of OFFSET. Jumping to an unvisited page N falls back to
 * OFFSET (or is refused by the server when a seek is also sent).
 */
import {
  parseTopLevelOrderBy,
  uniqueKeyCoversOrder,
  uniqueKeysFromTable,
} from '@foxschema/ui-shared';
import type { TableSchema } from '@/shared/lib/types';
import {
  fromClauseIsMultiTable,
  fromClauseIsSubquery,
  outerTableNamesFromSql,
  selectListSafeForResultEdit,
  sqlHasSetOperation,
} from '@/shared/lib/tablePreview';

export type ResultSeek = {
  columns: string[];
  values: unknown[];
  descending: boolean[];
};

export function tableForOrderBy(
  sql: string,
  tables: readonly TableSchema[] | undefined
): TableSchema | undefined {
  if (!tables?.length) return undefined;
  // A unique key is only unique in the result while one source row can produce
  // at most one output row. Subqueries can also expose a non-unique expression
  // under a base table's key name. In either case keyset paging would skip the
  // remaining rows for that value.
  if (
    fromClauseIsMultiTable(sql) ||
    fromClauseIsSubquery(sql) ||
    sqlHasSetOperation(sql) ||
    /\b(?:CROSS|OUTER)\s+APPLY\b/i.test(sql)
  ) {
    return undefined;
  }
  // Match parsed FROM references, not substrings. With tables `order` and
  // `order_items`, searching the SQL text returned whichever cache entry came
  // first and could borrow the wrong table's uniqueness metadata.
  const names = outerTableNamesFromSql(sql);
  if (names.length !== 1) return undefined;
  const wanted = names[0]!.toLowerCase();
  if (wanted.includes('.')) {
    return tables.find((table) => table.name.toLowerCase() === wanted);
  }
  const matched = tables.filter((table) => {
    const name = table.name.toLowerCase();
    return (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name) === wanted;
  });
  return matched.length === 1 ? matched[0] : undefined;
}

export function seekFromLastRow(opts: {
  sql: string;
  table?: TableSchema;
  resultColumns: readonly string[];
  lastRow: readonly unknown[];
}): ResultSeek | null {
  const parsed = parseTopLevelOrderBy(opts.sql);
  if (!parsed || !opts.table) return null;
  // The ORDER BY name must still mean the base-table column in the result.
  // `SELECT id % 2 AS id ... ORDER BY id` otherwise borrows the table PK's
  // uniqueness and keyset paging skips every remaining row with that value.
  if (!selectListSafeForResultEdit(opts.sql)) return null;
  const orderCols = parsed.terms.map((t) => t.column);
  if (!uniqueKeyCoversOrder(uniqueKeysFromTable(opts.table), orderCols)) return null;
  const values: unknown[] = [];
  for (const col of orderCols) {
    const i = opts.resultColumns.findIndex((c) => c.toLowerCase() === col.toLowerCase());
    if (i < 0) return null;
    const v = opts.lastRow[i];
    if (v === null || v === undefined) return null;
    values.push(v);
  }
  return {
    columns: orderCols,
    values,
    descending: parsed.terms.map((t) => t.descending),
  };
}
