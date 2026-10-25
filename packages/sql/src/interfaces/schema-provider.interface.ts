import { type DbSchema, type TableSchema } from './schema.interface.js';

export type { TableSchema, DbObjectType, ColumnInfo, IndexInfo, ForeignKeyInfo, PrimaryKeyInfo, TriggerInfo, SequenceInfo, UserTypeInfo, TypeAttributeInfo } from './schema.interface.js';

export interface DriverInfo {
  provider: string;
  packageName: string;
  installed: boolean;
  version?: string;
  installCommand?: string;
  error?: string;
}

export interface ConnectionOptions {
  connectionString?: string;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  schemaRequired?: boolean;
  pool?: { min?: number; max?: number; idleTimeoutMs?: number; };
  ssl?: { enabled: boolean; rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string; };
  timeout?: { connectMs?: number; queryMs?: number; };
  /**
   * How Fox authenticates to this engine. `password` (default) is SQL/native.
   * `windows` is SQL Server/Azure NTLM. `ldap` is a Db2 directory user (still UID/PWD).
   */
  authMethod?: 'password' | 'windows' | 'ldap' | 'none';
  /** NTLM domain when authMethod is `windows`. Also accepted as `DOMAIN\\user` in username. */
  domain?: string;
  [key: string]: any; 
}

export interface SavedConnection {
  id: string;
  name: string;
  dialect: 'postgres' | 'mysql' | 'mariadb' | 'db2' | 'sqlserver' | 'oracle' | 'sqlite';
  option?: ConnectionOptions;
}

/**
 * Result of attempting to read roles. Roles are server/instance-global (not
 * schema-scoped), so reading them often needs elevated privileges. When the
 * connected user can't, the provider returns no roles plus a `warning` rather
 * than failing the whole comparison.
 */
export interface RoleLoadResult {
  roles: TableSchema[];
  warning?: string;
}

export interface SchemaProvider {
  readonly provider: string;
  testConnection(options: ConnectionOptions): Promise<boolean>;
  loadSchema(options: ConnectionOptions, schema: string): Promise<DbSchema>;
  getTables?(options: ConnectionOptions, schema: string): Promise<TableSchema[]>;
  /**
   * Reads roles/user-groups as comparable objects. Optional — providers that
   * can't surface roles simply omit it. Implementations must never throw on a
   * permission error; they degrade to `{ roles: [], warning }`.
   */
  getRoles?(options: ConnectionOptions, schema: string): Promise<RoleLoadResult>;
  /** Lists selectable namespaces in the connected database: schemas for DB2/Postgres, databases for MySQL. */
  listSchemas?(options: ConnectionOptions): Promise<string[]>;
  /**
   * Return the server version string (e.g. "19.3.0.0.0" for Oracle 19c,
   * "11.5.8.0" for DB2 11.5). Used by sql-generator to emit version-safe DDL.
   * Called once after a successful testConnection; never throws.
   */
  detectVersion?(options: ConnectionOptions): Promise<string>;
}

/**
 * Browser-safe, per-provider connection settings. Lives next to each
 * provider so a new dialect only adds files in its own folder — no DB
 * driver imports allowed here (the frontend bundles these).
 */
export interface ProviderConnectionSettings {
  dialect: string;
  label: string;
  defaultPort: number;
  defaultSchema?: string;
  schemaRequired: boolean;
  /**
   * `false` when the engine has no transaction to roll back: its adapter's
   * begin, commit and rollback do nothing. Absent means it has one. Read it
   * through `dialectHasTransactions`.
   */
  transactions?: boolean;
  buildConnectionString(option: ConnectionOptions): string;
}

/**
 * Backend-only driver adapter: owns everything native-driver-specific for a
 * dialect (pooling, query execution, transactions). Adding a database platform
 * means implementing this in the provider folder — core/modules stay generic.
 */
/** A result set with duplicate column names intact. */
export interface PositionalRows {
  /** Column names in result order — duplicates preserved, as the engine sent them. */
  columns: string[];
  /** One array per row, aligned to {@link columns} by index. */
  rows: unknown[][];
}

export interface DriverAdapter {
  readonly dialect: string;
  /** npm package that supplies this driver (for install/availability checks). */
  readonly packageName: string;

  /** Acquire a connection — pooled for reads, dedicated when pooled=false (transactions). */
  acquire(connectionString: string, options: ConnectionOptions, pooled: boolean): Promise<any>;
  /** Return a pooled connection to its pool, or close a dedicated one. */
  release(connection: any): Promise<void>;
  /** Run a statement and return rows. */
  query<T = Record<string, unknown>>(connection: any, sql: string, params: readonly unknown[]): Promise<T[]>;

  /**
   * Run a statement and return rows *positionally*, keeping every column.
   *
   * {@link query} returns rows as objects keyed by column name, which is what
   * every catalog query wants. It cannot represent a join whose tables share a
   * column name: `SELECT *` over four tables that each have `id` yields one
   * `id` key holding the last table's value, and the other three columns are
   * gone before any caller sees them. Nothing errors, and the row that reaches
   * the grid reads as one record while mixing values from different tables.
   *
   * Optional because not every driver can do it. A driver without it keeps the
   * name-keyed path, so this adds a capability rather than changing a contract.
   */
  queryPositional?(
    connection: any,
    sql: string,
    params: readonly unknown[]
  ): Promise<PositionalRows>;

  /** Transaction lifecycle (used by migrations). */
  beginTransaction(connection: any): Promise<void>;
  commitTransaction(connection: any): Promise<void>;
  rollbackTransaction(connection: any): Promise<void>;
  /** Pin the working schema so unqualified DDL lands in the right place. */
  setCurrentSchema(connection: any, schema: string): Promise<void>;

  /** Close every pooled resource (graceful shutdown). */
  closeAll(): Promise<void>;
}