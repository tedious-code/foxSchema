/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/sql-probe.ts).
 */
import type { CredentialStore } from '@foxschema/workflow-engine';
import type { SqlProbe } from '@foxschema/workflow-engine';

/**
 * The database side of a cron precondition.
 *
 * Lives in the app layer because that is where composition happens: the
 * runtime declares the seam (`SqlProbe`, injected the way `fetch` is) and
 * stays free of drivers, while this file is allowed to know about `pg` and
 * `mysql2`. Drivers are imported on demand, the same way the source pipes do
 * it, so an installation that never schedules a SQL check never loads them.
 *
 * A connection per evaluation rather than a pool: preconditions run on the
 * scheduler tick, seconds apart at most, and a pool held open for a query
 * that runs once a minute is a connection an operator has to account for.
 */
export function createSqlProbe(credentials: CredentialStore): SqlProbe {
  return async ({ credentialId, engine, sql, timeoutMs, maxRows }) => {
    const secret = await credentials.revealSecret(credentialId);
    if (!secret) {
      throw new Error(`sql precondition credential not found: ${credentialId}`);
    }

    if (engine === 'postgres') {
      const pg = await import('pg');
      // Enforced by the server, not by us waiting: a query that hangs would
      // otherwise stall the single scheduling tick for every other schedule.
      const client = new pg.Client({
        ...(secret as Record<string, unknown>),
        statement_timeout: timeoutMs,
      } as never);
      await client.connect();
      try {
        const result = await client.query(sql);
        return (result.rows as Record<string, unknown>[]).slice(0, maxRows);
      } finally {
        await client.end();
      }
    }

    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      ...(secret as Record<string, unknown>),
      connectTimeout: timeoutMs,
    } as never);
    try {
      // mysql2 takes the cap as a query option; `rows` may also be a result
      // header for non-SELECT statements, which `assertReadOnly` has already
      // refused — the array check keeps a surprise from becoming a crash.
      const [rows] = await connection.query({ sql, timeout: timeoutMs });
      return Array.isArray(rows)
        ? (rows as Record<string, unknown>[]).slice(0, maxRows)
        : [];
    } finally {
      await connection.end();
    }
  };
}
