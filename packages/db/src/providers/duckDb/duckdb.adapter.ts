import { type ConnectionOptions, type DriverAdapter } from '@foxschema/sql';
import { requireDriver } from '../../cores/driver-loader.js';
import { assertSafeEmbeddedDatabasePath } from '../../cores/embedded-db-guard.js';

interface DuckHandle {
  instance: any;
  conn: any;
}

/**
 * DuckDB adapter via @duckdb/node-api (async). DuckDB is embedded like SQLite —
 * the "connection string" is a file path (or ':memory:'). One instance +
 * connection is cached per path; different files (e.g. a source and target DB)
 * get independent handles.
 *
 * getRowObjects() returns BIGINT columns as JS bigint; introspection code
 * expects plain numbers/strings, so query() coerces bigint to Number.
 */
class DuckDbAdapter implements DriverAdapter {
  readonly dialect = 'duckdb';
  readonly packageName = '@duckdb/node-api';

  private handles = new Map<string, Promise<DuckHandle>>();
  private api: any;

  private load(): any {
    if (this.api) return this.api;
    this.api = requireDriver(this.packageName, this.dialect, { unwrapDefault: false });
    return this.api;
  }

  async acquire(connectionString: string, _options: ConnectionOptions, _pooled: boolean): Promise<DuckHandle> {
    assertSafeEmbeddedDatabasePath(connectionString);
    let pending = this.handles.get(connectionString);
    if (!pending) {
      const { DuckDBInstance } = this.load();
      pending = (async () => {
        const instance = await DuckDBInstance.create(connectionString);
        const conn = await instance.connect();
        // Disable host filesystem / external file-reader access (`read_text`,
        // `read_csv`, `ATTACH`, `COPY ... TO/FROM`, extension installs) at the
        // DuckDB engine layer and lock configuration so user SQL cannot re-enable
        // it to read FoxSchema's internal DB or encryption key.
        await conn.run('SET enable_external_access = false');
        await conn.run('SET lock_configuration = true');
        return { instance, conn };
      })();
      this.handles.set(connectionString, pending);
      pending.catch(() => {
        if (this.handles.get(connectionString) === pending) {
          this.handles.delete(connectionString);
        }
      });
    }
    return pending;
  }

  async release(_handle: DuckHandle): Promise<void> {
    // Cached; closed in closeAll().
  }

  async query<T = Record<string, unknown>>(handle: DuckHandle, sql: string, params: readonly unknown[]): Promise<T[]> {
    const reader = params.length
      ? await handle.conn.runAndReadAll(sql, params as unknown[])
      : await handle.conn.runAndReadAll(sql);
    return reader.getRowObjects().map(coerceBigints) as T[];
  }

  async beginTransaction(handle: DuckHandle): Promise<void> {
    await handle.conn.run('BEGIN TRANSACTION');
  }

  async commitTransaction(handle: DuckHandle): Promise<void> {
    await handle.conn.run('COMMIT');
  }

  async rollbackTransaction(handle: DuckHandle): Promise<void> {
    try { await handle.conn.run('ROLLBACK'); } catch { /* ignore */ }
  }

  async setCurrentSchema(handle: DuckHandle, schema: string): Promise<void> {
    // DuckDB is schema-aware; SET schema scopes unqualified names.
    if (schema) await handle.conn.run(`SET schema='${schema.replace(/'/g, "''")}'`);
  }

  async closeAll(): Promise<void> {
    const pending = Array.from(this.handles.values());
    this.handles.clear();
    await Promise.all(
      pending.map(async (p) => {
        try {
          const h = await p;
          h.conn?.closeSync?.();
          h.instance?.closeSync?.();
        } catch { /* ignore */ }
      })
    );
  }
}

/**
 * Coerce driver bigint for JSON / grid use.
 * Safe integers stay numbers (introspection + small PKs). Values beyond
 * Number.MAX_SAFE_INTEGER stay digit strings so Peek / result-grid
 * UPDATE/DELETE WHERE clauses are not silently rounded to the wrong key.
 */
export function coerceDriverBigint(v: bigint): number | string {
  const asNumber = Number(v);
  return Number.isSafeInteger(asNumber) ? asNumber : v.toString();
}

/** Shallow-coerce bigint values in a row object for callers that expect JSON-ish cells. */
function coerceBigints(row: Record<string, unknown>): Record<string, unknown> {
  let hasBig = false;
  for (const k in row) if (typeof row[k] === 'bigint') { hasBig = true; break; }
  if (!hasBig) return row;
  const out: Record<string, unknown> = {};
  for (const k in row) {
    const v = row[k];
    out[k] = typeof v === 'bigint' ? coerceDriverBigint(v) : v;
  }
  return out;
}

export const duckDbAdapter = new DuckDbAdapter();
