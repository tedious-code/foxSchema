import { type ConnectionOptions, type DriverAdapter } from '@foxschema/sql';
import { BoundedPoolCache, disposePoolEndOrClose } from '../../cores/pool-cache.js';
import { guardPoolErrors } from '../../cores/pool-error-guard.js';
import { buildMssqlPoolConfig } from './sqlserver.config.js';
import { requireDriver } from '../../cores/driver-loader.js';

type MssqlHandle =
  | { _type: 'pool'; pool: any }
  | { _type: 'tx'; pool: any; tx: any };

/**
 * SQL Server adapter via mssql. mssql's Request objects are created per-query
 * from a pool or transaction — there is no persistent "connection" object to
 * hold between calls. We wrap a pool/transaction in a tagged handle instead.
 *
 * Azure SQL is the same driver and the same code; only the dialect name (for
 * errors and the registry) and the TLS default differ — Azure requires
 * encryption, an on-premises server does not by default.
 */
export class MssqlAdapter implements DriverAdapter {
  readonly packageName = 'mssql';

  constructor(
    readonly dialect: 'sqlserver' | 'azuresql',
    private readonly encryptDefault: boolean
  ) {}

  private pools = new BoundedPoolCache<any>(disposePoolEndOrClose);
  private driver: any;

  private load(): any {
    if (this.driver) return this.driver;
    this.driver = requireDriver(this.packageName, this.dialect);
    return this.driver;
  }

  private buildConfig(options: ConnectionOptions): Record<string, unknown> {
    return buildMssqlPoolConfig(options, { encryptDefault: this.encryptDefault });
  }

  async acquire(connectionString: string, options: ConnectionOptions, _pooled: boolean): Promise<MssqlHandle> {
    const mssql = this.load();
    const pool = await this.pools.getOrCreate(connectionString, async () => {
      const created = new mssql.ConnectionPool(this.buildConfig(options));
      guardPoolErrors(created, this.dialect);
      await created.connect();
      return created;
    });
    return { _type: 'pool', pool };
  }

  async release(_handle: any): Promise<void> {
    // Pool connections are managed by the pool; tx is finalized by commit/rollback.
  }

  async query<T = Record<string, unknown>>(handle: MssqlHandle, sql: string, params: readonly unknown[]): Promise<T[]> {
    const mssql = this.load();
    const req = handle._type === 'tx'
      ? new mssql.Request(handle.tx)
      : new mssql.Request(handle.pool);

    // SQL Server uses named parameters @p0, @p1, …; providers write queries this way.
    params.forEach((value, i) => req.input(`p${i}`, value));

    const result = await req.query(sql);
    // mssql leaves `recordset` undefined for a statement that returns no result
    // set (INSERT/UPDATE/DELETE/DDL). Callers rely on an array — notably
    // ConnectionFactory.executeQuery reads `rows.length` — so normalise it.
    return (result.recordset ?? []) as T[];
  }

  /**
   * `arrayRowMode` makes mssql return arrays plus a column list, so a join
   * selecting `id` from two tables keeps both rather than collapsing them onto
   * one key of a row object.
   */
  async queryPositional(handle: MssqlHandle, sql: string, params: readonly unknown[]) {
    const mssql = this.load();
    const req = handle._type === 'tx'
      ? new mssql.Request(handle.tx)
      : new mssql.Request(handle.pool);
    req.arrayRowMode = true;
    params.forEach((value, i) => req.input(`p${i}`, value));

    const result = await req.query(sql);
    // `columns` is [[{name}, …]] — one entry per recordset.
    const meta = (result.columns?.[0] ?? []) as { name: string }[];
    return {
      columns: meta.map((c) => c.name),
      rows: (result.recordset ?? []) as unknown as unknown[][],
    };
  }

  async beginTransaction(handle: MssqlHandle): Promise<void> {
    const mssql = this.load();
    const tx = new mssql.Transaction((handle as any).pool);
    await tx.begin();
    (handle as any)._type = 'tx';
    (handle as any).tx = tx;
  }

  async commitTransaction(handle: MssqlHandle): Promise<void> {
    if (handle._type === 'tx') await handle.tx.commit();
    (handle as any)._type = 'pool';
    (handle as any).tx = undefined;
  }

  async rollbackTransaction(handle: MssqlHandle): Promise<void> {
    if (handle._type === 'tx') {
      try { await handle.tx.rollback(); } catch { /* ignore if already finalized */ }
    }
    (handle as any)._type = 'pool';
    (handle as any).tx = undefined;
  }

  async setCurrentSchema(_handle: MssqlHandle, _schema: string): Promise<void> {
    // Schemas are part of the object qualifier (schema.object), not a session variable.
    // Migration DDL is expected to be already schema-qualified.
  }

  async closeAll(): Promise<void> {
    await this.pools.clear();
  }
}

export const sqlServerAdapter = new MssqlAdapter('sqlserver', false);
