/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A step a planner writes as `BEGIN; …; COMMIT;` (PostgreSQL), turned into
 * the statements between, run inside the server's own transaction.
 *
 * Sent as text with stop-on-error, a failing statement left COMMIT unrun and
 * the connection went back to the pool inside an aborted transaction: pg's
 * pool does not roll back on release, so the next queries on that connection
 * failed with "current transaction is aborted". With `transaction: true` the
 * server begins, rolls back on a failure, commits otherwise, and releases a
 * clean connection. A step that is one batch (SQL Server's `SET XACT_ABORT ON
 * … COMMIT TRANSACTION`) or has no transaction of its own is left as it is.
 */
const OPENERS = new Set(['BEGIN', 'BEGIN TRANSACTION', 'BEGIN WORK', 'START TRANSACTION']);
const CLOSERS = new Set(['COMMIT', 'COMMIT TRANSACTION', 'COMMIT WORK', 'END', 'END TRANSACTION']);

const keyword = (statement: string) =>
  statement
    .trim()
    .replace(/;$/, '')
    .trim()
    .split(/\s+/)
    .join(' ')
    .toUpperCase();

export function stepStatements(statements: string[]): { statements: string[]; transaction: boolean } {
  const first = statements[0];
  const last = statements[statements.length - 1];
  if (statements.length >= 2 && first && last && OPENERS.has(keyword(first)) && CLOSERS.has(keyword(last))) {
    return { statements: statements.slice(1, -1), transaction: true };
  }
  return { statements, transaction: false };
}
