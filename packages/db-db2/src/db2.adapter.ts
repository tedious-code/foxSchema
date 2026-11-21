import { type ConnectionOptions, type DriverAdapter, IBM_DB_VERSION, normalizeAuthMethod, unsupportedAuthMethodMessage } from '@foxschema/sql';
import { BoundedPoolCache, assertSafeIdentifier, disposePoolEndOrClose, requireDriver } from '@foxschema/db';
import { setupDb2ClientEnv, hasDb2Clidriver } from './db2.env.js';
import { explainDb2ConnectError, resolveDb2SslConnectionString, shouldRetryDb2Authentication, alternateDb2Authentication } from './db2.ssl.js';

/**
 * ibm_db adapter. Pooled via the driver's built-in Pool so each schema load
 * reuses connections instead of paying the (expensive) DB2 connect cost per op.
 */
class Db2Adapter implements DriverAdapter {
  readonly dialect = 'db2';
  readonly packageName = 'ibm_db';

  private pools = new BoundedPoolCache<any>(disposePoolEndOrClose);
  private driver: any;

  private load(): any {
    if (this.driver) return this.driver;
    setupDb2ClientEnv(); // point at the bundled clidriver before native load
    if (!hasDb2Clidriver()) {
      throw new Error(
        'ibm_db is installed but its CLI driver (clidriver) is missing. ' +
          'On Windows this usually means scripts were skipped — reinstall with: ' +
          `npm install ibm_db@${IBM_DB_VERSION} --foreground-scripts  (or: foxschema drivers install db2)`
      );
    }
    this.driver = requireDriver(this.packageName, this.dialect, { installFlags: '--foreground-scripts' });
    return this.driver;
  }

  async acquire(connectionString: string, options: ConnectionOptions, pooled: boolean): Promise<any> {
    if (normalizeAuthMethod(options.authMethod) === 'windows') {
      throw new Error(unsupportedAuthMethodMessage('db2', 'windows'));
    }
    const ibmdb = this.load();
    const primary = resolveDb2SslConnectionString(connectionString, options);
    try {
      return await this.open(ibmdb, primary, options, pooled);
    } catch (err) {
      const alternate =
        shouldRetryDb2Authentication(err) ? alternateDb2Authentication(primary) : null;
      if (alternate) {
        try {
          return await this.open(ibmdb, alternate, options, pooled);
        } catch (err2) {
          throw explainDb2ConnectError(err2, options);
        }
      }
      throw explainDb2ConnectError(err, options);
    }
  }

  private open(
    ibmdb: any,
    cs: string,
    options: ConnectionOptions,
    pooled: boolean
  ): Promise<any> {
    if (!pooled || !ibmdb.Pool) {
      return new Promise((resolve, reject) =>
        ibmdb.open(cs, (err: Error | null, conn: any) => (err ? reject(err) : resolve(conn)))
      );
    }

    return this.pools.getOrCreate(cs, () => {
      const created = new ibmdb.Pool();
      if (typeof created.setMaxPoolSize === 'function') created.setMaxPoolSize(options.pool?.max ?? 10);
      if (typeof created.setConnectTimeout === 'function' && options.timeout?.connectMs) {
        created.setConnectTimeout(Math.ceil(options.timeout.connectMs / 1000));
      }
      if (typeof created.setIdleTimeout === 'function' && options.pool?.idleTimeoutMs) {
        created.setIdleTimeout(Math.ceil(options.pool.idleTimeoutMs / 1000));
      }
      return created;
    }).then(
      (pool) =>
        new Promise((resolve, reject) =>
          pool.open(cs, (err: Error | null, conn: any) => (err ? reject(err) : resolve(conn)))
        )
    );
  }

  async release(connection: any): Promise<void> {
    if (!connection) return;
    // A pooled connection's close() returns it to the pool; a raw one closes.
    await new Promise<void>((resolve, reject) =>
      connection.close((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  query<T = Record<string, unknown>>(connection: any, sql: string, params: readonly unknown[]): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) =>
      connection.query(sql, [...params], (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows ?? [])))
    );
  }

  beginTransaction(connection: any): Promise<void> {
    return new Promise((resolve, reject) =>
      connection.beginTransaction((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  commitTransaction(connection: any): Promise<void> {
    return new Promise((resolve, reject) =>
      connection.commitTransaction((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  rollbackTransaction(connection: any): Promise<void> {
    return new Promise((resolve, reject) =>
      connection.rollbackTransaction((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }

  async setCurrentSchema(connection: any, schema: string): Promise<void> {
    // Interpolated into SQL (can't be parameterized) — must be a safe identifier
    const s = assertSafeIdentifier(schema, 'schema').toUpperCase();
    await this.query(connection, `SET CURRENT SCHEMA = ${s}`, []);
    // Unqualified function/procedure resolution follows CURRENT PATH, not CURRENT SCHEMA
    await this.query(connection, `SET CURRENT PATH = SYSTEM PATH, ${s}`, []);
  }

  async closeAll(): Promise<void> {
    await this.pools.clear();
  }
}

export const db2Adapter = new Db2Adapter();
