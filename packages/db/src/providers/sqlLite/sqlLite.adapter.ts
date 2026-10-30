import { type ConnectionOptions, type DriverAdapter } from '@foxschema/sql';
import { BoundedPoolCache } from '../../cores/pool-cache.js';
import { requireDriver } from '../../cores/driver-loader.js';

/**
 * SQLite adapter via better-sqlite3 (synchronous API, wrapped in Promises).
 * The "connection" is the open Database object; the file path is the
 * connection string (use ':memory:' for in-memory databases).
 * SQLite has no real connection pools — we cache one db handle per path.
 */
class SqliteAdapter implements DriverAdapter {
  readonly dialect = 'sqlite';
  readonly packageName = 'better-sqlite3';

  private dbs = new BoundedPoolCache<any>((db) => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });
  private driver: any;

  private load(): any {
    if (this.driver) return this.driver;
    this.driver = requireDriver(this.packageName, this.dialect);
    return this.driver;
  }

  async acquire(connectionString: string, _options: ConnectionOptions, _pooled: boolean): Promise<any> {
    return this.dbs.getOrCreate(connectionString, () => {
      const Database = this.load();
      // Read-write: the SQL editor runs user DDL/DML against SQLite too, and a
      // read-only handle fails those with "attempt to write a readonly
      // database". fileMustExist keeps a typo'd path from silently creating an
      // empty database instead of reporting that the file is missing.
      return new Database(connectionString, { fileMustExist: true });
    });
  }

  async release(_db: any): Promise<void> {
    // Cached; closed in closeAll().
  }

  async query<T = Record<string, unknown>>(db: any, sql: string, params: readonly unknown[]): Promise<T[]> {
    const stmt = db.prepare(sql);
    // better-sqlite3 splits the API by statement kind: `.all()` throws
    // "This statement does not return data. Use run() instead" for anything
    // that isn't a SELECT-like read. `stmt.reader` tells us which to call.
    if (!stmt.reader) {
      stmt.run(...params);
      return [] as T[];
    }
    return stmt.all(...params) as T[];
  }

  async beginTransaction(db: any): Promise<void> {
    db.prepare('BEGIN').run();
  }

  async commitTransaction(db: any): Promise<void> {
    db.prepare('COMMIT').run();
  }

  async rollbackTransaction(db: any): Promise<void> {
    try { db.prepare('ROLLBACK').run(); } catch { /* ignore */ }
  }

  async setCurrentSchema(_db: any, _schema: string): Promise<void> {
    // SQLite has no schema namespaces within a single file — no-op.
  }

  async closeAll(): Promise<void> {
    await this.dbs.clear();
  }
}

export const sqliteAdapter = new SqliteAdapter();
