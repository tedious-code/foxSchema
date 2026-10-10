/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { splitSqlStatements } from '@foxschema/db';

/**
 * True when `sql` holds exactly one executable statement.
 *
 * Guards the endpoints that price a write by its *verb*: `statementVerb`
 * reports only the first one, so `INSERT … ; DELETE FROM users` reads as an
 * insert and never asks for `editor.datagrid.delete`. Every category is
 * checked (so `; DROP TABLE` is caught by the DDL rule), but a second verb in
 * the *same* category slips through — which is exactly the case where the
 * per-action Data grid permissions are meant to bite.
 *
 * Whether the smuggled statement actually runs is the driver's call — the
 * mssql adapter sends the text as a T-SQL batch, while node-postgres refuses a
 * multi-statement extended query and mysql2 pins `multipleStatements: false`.
 * Relying on that is relying on luck, so reject the shape instead.
 *
 * Grid CRUD and data-migrate row ops are generated one statement at a time, so
 * this costs a legitimate caller nothing.
 */
export function isSingleSqlStatement(sql: string): boolean {
  return splitSqlStatements(sql).filter((part) => part.text.trim()).length <= 1;
}
