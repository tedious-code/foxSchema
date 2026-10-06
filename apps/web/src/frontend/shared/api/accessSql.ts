/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Running a generated GRANT / REVOKE script against a connection.
 *
 * Dialect emitters return a script, not a statement: Postgres pairs USAGE ON
 * SCHEMA with ON ALL TABLES, Oracle follows CREATE USER with its quota grant.
 * The driver takes one statement per round-trip, so the script is split first.
 *
 * Split by `splitSqlStatements`, not a regex over `;`. Access scripts carry
 * quoted identifiers and passwords, and a `;` inside one is a semicolon, not a
 * separator — `GRANT SELECT ON "audit;2024" TO app` is one statement. The
 * shared splitter already tracks single quotes (including `''`), double
 * quotes, backticks, brackets and dollar-quoting, and terminates a statement
 * on `;` wherever it sits, so `GRANT a; GRANT b;` on one line splits in two.
 */
import { splitSqlStatements } from '@foxschema/ui-shared';
import type { ConnectionRef } from './schemaApi';
import { executeSql } from './sqlApi';

/** Every statement succeeded, or the joined errors of those that did not. */
export type AccessSqlOutcome = { ok: true } | { ok: false; error: string };

/**
 * Execute a grant/revoke script statement by statement.
 *
 * Statements run in order and are not wrapped in a transaction: most engines
 * auto-commit DDL anyway, so a mid-script failure leaves the earlier grants
 * applied. The caller reports the failure and re-reads the catalog rather than
 * claiming the script was undone.
 */
export async function runAccessSql(
  ref: ConnectionRef,
  sql: string
): Promise<AccessSqlOutcome> {
  const statements = splitSqlStatements(sql)
    .map((s) => s.text.trim())
    .filter(Boolean);
  const { results } = await executeSql(ref, statements.length ? statements : [sql]);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { ok: true };
  return {
    ok: false,
    error: failed.map((r) => ('error' in r ? r.error : 'failed')).join(' · '),
  };
}
