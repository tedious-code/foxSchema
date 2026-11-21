
import { type ConnectionOptions, type PositionalRows, errorMessage } from '@foxschema/sql';
import { getProviderSettings } from '@foxschema/sql';
import { getAdapter, ADAPTERS } from '../providers/adapter-registry.js';
import { addonPackageFor } from '../plugins/addon-packages.js';
import { dialectPlugin } from '../plugins/plugin-store.js';
import { circuitKey, dbCircuitBreaker } from './circuit-breaker.js';
import { noopLogger, safeTarget, type AppLogger } from './logger.js';

/**
 * Generic connection orchestrator. All dialect-specific behaviour lives in the
 * per-provider DriverAdapter — this layer only builds the connection string and
 * delegates, so adding a database platform never touches this file.
 */
/**
 * Node's dual-stack TCP connect (e.g. host "localhost" resolving to both ::1
 * and 127.0.0.1 with nothing listening on either) throws an AggregateError
 * whose own `.message` is `''` — the real reasons live in `.errors`. Left
 * as-is, every provider's `error.message` rethrow surfaces that empty string
 * (the client then shows a bare "Internal Server Error"). Join the nested
 * messages instead so the real cause reaches the UI.
 */
function describeConnectionError(error: unknown): Error {
  if (error instanceof AggregateError && !error.message && error.errors?.length) {
    const message = error.errors
      .map((e) => errorMessage(e))
      .join('; ');
    return new Error(message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class ConnectionFactory {
  static async create(
    provider: string,
    options: ConnectionOptions,
    opts: { pooled?: boolean } = {}
  ): Promise<any> {
    if (addonPackageFor(provider) && !dialectPlugin(provider)) {
      // Imported here, not at the top: the plugin loader reaches the provider
      // registry, whose providers import this file.
      await (await import('../plugins/dialect-plugin.js')).ensureDialect(provider);
    }
    const adapter = getAdapter(provider);
    const connectionString = getProviderSettings(provider).buildConnectionString(options);
    // Acquire is where an unreachable target costs the most: every caller waits
    // out the full connect timeout holding a request slot. The breaker turns
    // repeat attempts against a known-down target into an instant rejection.
    return dbCircuitBreaker.run(circuitKey(provider, options), async () => {
      try {
        return await adapter.acquire(connectionString, options, opts.pooled !== false);
      } catch (error) {
        throw describeConnectionError(error);
      }
    });
  }

  static async close(provider: string, connection: any): Promise<void> {
    if (!connection) return;
    await getAdapter(provider).release(connection);
  }

  /**
   * Closes every pooled connection across all adapters. Call on graceful
   * shutdown so the process can exit cleanly instead of hanging on DB handles.
   */
  static async closeAll(): Promise<void> {
    await Promise.all(
      Object.values(ADAPTERS).map((adapter) =>
        adapter.closeAll().catch((err) => console.error(`Error closing ${adapter.dialect} pool:`, err))
      )
    );
  }

  /**
   * The logger every query reports through. Injected rather than imported so
   * this package keeps no dependency on pino or the HTTP layer; silent until a
   * host installs one.
   */
  private static logger: AppLogger = noopLogger;

  /** Operations slower than this are reported at warn. */
  private static slowQueryMs = Number(process.env.SLOW_DB_QUERY_MS) || 500;

  static useLogger(logger: AppLogger, opts: { slowQueryMs?: number } = {}): void {
    this.logger = logger;
    if (opts.slowQueryMs) this.slowQueryMs = opts.slowQueryMs;
  }

  /** One-shot query: acquire, run, release. */
  static async executeQuery<T = Record<string, unknown>>(
    provider: string,
    options: ConnectionOptions,
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    const startedAt = performance.now();
    const connection = await this.create(provider, options);
    try {
      const rows = await getAdapter(provider).query<T>(connection, sql, params);
      this.report(provider, options, startedAt, rows.length);
      return rows;
    } catch (error) {
      // Reported, not logged as an error: the boundary that turns this into an
      // HTTP response logs the failure once. Logging here too would make one
      // failure four lines.
      this.report(provider, options, startedAt, undefined, error);
      throw error;
    } finally {
      await this.close(provider, connection);
    }
  }

  /**
   * One structured line per query — never the SQL, never the rows.
   *
   * SQL text can embed literals, and rows are the user's data; both belong in
   * a debugger, not in a log that ships to a collector. What is useful and safe
   * is the shape: which engine, how long, how many rows.
   */
  private static report(
    provider: string,
    options: ConnectionOptions,
    startedAt: number,
    rowCount?: number,
    error?: unknown
  ): void {
    const durationMs = Math.round(performance.now() - startedAt);
    const fields = {
      component: 'database' as const,
      operation: 'query',
      engine: provider,
      target: safeTarget(options),
      durationMs,
      ...(rowCount === undefined ? {} : { rowCount }),
    };

    if (error) {
      this.logger.debug({ ...fields, failed: true }, 'database query failed');
      return;
    }
    if (durationMs >= this.slowQueryMs) {
      this.logger.warn(fields, 'slow database query');
      return;
    }
    this.logger.debug(fields, 'database query completed');
  }

  /** Query on an existing connection (used when loading a whole schema). */
  static executeOnConnection<T = Record<string, unknown>>(
    provider: string,
    connection: any,
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    return getAdapter(provider).query<T>(connection, sql, params);
  }

  /**
   * Rows with every column intact, or null when this driver cannot do it.
   *
   * Null is a normal answer — Db2, Oracle, SQLite, DuckDB and ClickHouse keep
   * the name-keyed path — so callers fall back rather than failing.
   */
  static executePositional(
    provider: string,
    connection: any,
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PositionalRows> | null {
    const adapter = getAdapter(provider);
    if (typeof adapter.queryPositional !== 'function') return null;
    return adapter.queryPositional(connection, sql, params);
  }
}
