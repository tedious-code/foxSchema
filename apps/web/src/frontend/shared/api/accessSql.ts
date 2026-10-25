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

/**
 * Every statement succeeded, or which one failed and what ran around it.
 * `applied` counts the statements that ran before the failure and stay
 * applied — a caller re-reads the catalog when it is above zero, or it shows
 * grants as they were before part of the script landed.
 */
export type AccessSqlOutcome = { ok: true } | { ok: false; error: string; applied: number };

/**
 * Execute a grant/revoke script statement by statement.
 *
 * Statements run in order and stop at the first failure: a script's later
 * steps assume its earlier ones (USAGE ON SCHEMA before ON ALL TABLES, CREATE
 * USER before its quota), so running them against a state the script did not
 * reach only adds errors or half-applied access. Nothing is wrapped in a
 * transaction — most engines auto-commit DDL anyway — so the statements before
 * the failure stay applied. The error says so, and the caller re-reads the
 * catalog rather than claiming the script was undone.
 */
export async function runAccessSql(
  ref: ConnectionRef,
  sql: string
): Promise<AccessSqlOutcome> {
  const split = splitSqlStatements(sql)
    .map((s) => s.text.trim())
    .filter(Boolean);
  const statements = split.length ? split : [sql];
  const { results } = await executeSql(ref, statements, undefined, undefined, undefined, { stopOnError: true });
  const failedAt = results.findIndex((r) => !r.ok);
  if (failedAt === -1 && results.length === statements.length) return { ok: true };
  if (failedAt === -1) {
    return { ok: false, error: `Only ${results.length} of ${statements.length} statements ran.`, applied: results.length };
  }
  const failure = results[failedAt]!;
  const error = 'error' in failure ? failure.error : 'failed';
  if (statements.length === 1) return { ok: false, error, applied: 0 };
  const notRun = statements.length - failedAt - 1;
  const before = failedAt === 0 ? '' : ` The ${failedAt} before it ${failedAt === 1 ? 'was' : 'were'} applied.`;
  const after = notRun === 0 ? '' : ` The ${notRun} after it did not run.`;
  const reason = error.trim().replace(/\.$/, '');
  return {
    ok: false,
    error: `Statement ${failedAt + 1} of ${statements.length} failed: ${reason}.${before}${after}`,
    applied: failedAt,
  };
}
