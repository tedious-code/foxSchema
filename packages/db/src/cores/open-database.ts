/**
 * Fox Schema (@foxschema/db)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One handle over ten engines, for a project using this package as a library.
 *
 * Everything here already existed; what was missing was a seam that put it
 * together. A caller had to know three things — `ConnectionFactory.create`,
 * `getAdapter(dialect).query`, and that closing goes back through
 * `ConnectionFactory.close(dialect, conn)` with the same dialect string — and
 * carry the dialect through all three by hand. Getting that last pairing wrong
 * leaks a pooled connection, and nothing tells you.
 *
 * This changes no existing API. The migration/compare paths keep using the
 * factory directly; this is the front door for someone who only wants to run
 * queries against several engines with one shape of code.
 */
import { ConnectionFactory } from './connection-factory.js';
import { getAdapter } from '../providers/adapter-registry.js';
import { ensureDialect } from '../plugins/dialect-plugin.js';
import type { ConnectionOptions } from '@foxschema/sql';

export interface OpenDatabase {
  /** The dialect this handle speaks, e.g. `postgres`. */
  readonly dialect: string;
  /**
   * Run a statement. Parameters use the engine's own placeholder style — `$1`
   * on Postgres, `?` on MySQL — because this is a thin pass-through, not a
   * query builder pretending the dialects are the same.
   */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Release the connection. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Open a connection and hand back something that can query and close itself.
 *
 * ```ts
 * const db = await openDatabase('postgres', { host: 'localhost', database: 'app', username: 'me', password: '…' });
 * try {
 *   const rows = await db.query('SELECT * FROM orders WHERE id = $1', [1]);
 * } finally {
 *   await db.close();
 * }
 * ```
 *
 * The driver for the dialect is an optional peer dependency — install only the
 * engines you talk to. A missing one fails with the install command to run.
 */
export async function openDatabase(
  dialect: string,
  options: ConnectionOptions,
  opts: { pooled?: boolean } = {}
): Promise<OpenDatabase> {
  await ensureDialect(dialect);
  const adapter = getAdapter(dialect);
  const connection = await ConnectionFactory.create(dialect, options, opts);
  let closed = false;

  return {
    dialect,
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      if (closed) throw new Error(`This ${dialect} connection is already closed.`);
      return adapter.query<T>(connection, sql, params);
    },
    async close() {
      // Idempotent on purpose: `close()` in a finally block after an earlier
      // close on the success path is the ordinary shape, and a double release
      // corrupts a pool's accounting.
      if (closed) return;
      closed = true;
      await ConnectionFactory.close(dialect, connection);
    },
  };
}

/**
 * Run one statement and close, for a script that makes a single query.
 *
 * Closes even when the query throws — the mistake this exists to prevent.
 */
export async function queryOnce<T = Record<string, unknown>>(
  dialect: string,
  options: ConnectionOptions,
  sql: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const db = await openDatabase(dialect, options, { pooled: false });
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.close();
  }
}
