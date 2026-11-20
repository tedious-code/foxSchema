/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL against any database FoxSchema can connect to.
 *
 * `source.db.sql` runs a query, or a whole script as a SQL job, and emits the
 * rows the last statement returns. `sink.db.sql` writes the records it
 * receives: as inserts into a table, or by running a statement per record.
 *
 * Both go through `@foxschema/db` — the drivers, dialects and connection
 * options the rest of FoxSchema uses — which is imported the first time a SQL
 * pipe runs, so an engine that never runs SQL never loads a driver.
 *
 * Values never become SQL text. A `{{path}}` token is bound as a parameter in
 * the dialect's own placeholder style, and table and column names are quoted
 * for the dialect.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import * as z from 'zod';
import {
  assertSafeSqliteSql,
  makeSqlQuery,
  maxInsertRows,
  quoteQualifiedName,
  renderSqlQuery,
  splitSqlStatements,
  sqlTag,
  type RenderedSql,
} from '@foxschema/sql';
import { getPath } from '../../common/index.js';
import type { PipeContext, RecordBatch, SinkPipe, SourcePipe } from '../../registry/index.js';
import {
  batchSizeField,
  definePipeMetadata,
  runSandboxedWithLogs,
  splitTemplate,
  type PipeMetadata,
} from '../../sdk/index.js';
import { requirePipeSecret, templateScope } from '../pipe-context.js';

/** A connection as a database credential resolves to it. */
export interface SqlConnection {
  dialect: string;
  schema?: string;
  option: Record<string, unknown>;
}

/** One open database session. */
export interface SqlSession {
  query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** Runs `work` in a transaction where the dialect can roll one back; otherwise just runs it. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Opens a session. `dedicated` asks for a connection of its own rather than
 * one from the pool: a transaction must not share its connection.
 */
export type SqlRunner = (
  connection: SqlConnection,
  options: { dedicated: boolean },
) => Promise<SqlSession>;

/**
 * Dialects whose drivers rely on native `.node` addons (`better-sqlite3`,
 * `@duckdb/node-api`, `ibm_db`) or host database files outside the sandbox's
 * `--permission` boundary. When a SQL runner delegate is installed (inside the
 * sandboxed workflow engine child), these dialects execute through the parent
 * FoxSchema process over private reverse IPC while keeping `--allow-addons` off.
 */
export const NATIVE_ADDON_SQL_DIALECTS: ReadonlySet<string> = new Set([
  'sqlite',
  'duckdb',
  'db2',
]);

let sqlRunnerDelegate: SqlRunner | undefined;

export function setSqlRunnerDelegate(delegate: SqlRunner | undefined): void {
  sqlRunnerDelegate = delegate;
}

const BLOCKED_SQLITE_BASENAMES = new Set([
  'foxschema.db',
  'workflow-engine.sqlite',
  '.app_encryption_key',
]);

function stripSqliteCompanionSuffix(filePath: string): string {
  return filePath.replace(/(?:-wal|-shm|-journal)$/i, '');
}

function sqliteTargetFromOption(option: Record<string, unknown>): string {
  const conn = option.connectionString;
  if (typeof conn === 'string' && conn.trim()) return conn.trim();
  const raw = option.database ?? option.filename ?? option.file;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ':memory:';
}

function assertSafeSqliteTarget(target: string): void {
  if (target.includes('\0')) {
    throw new Error('Refusing to open FoxSchema internal database from a workflow SQL pipe');
  }
  const lower = target.toLowerCase();
  if (
    lower === ':memory:' ||
    lower === 'file::memory:' ||
    lower.startsWith('file::memory:?') ||
    lower.startsWith('file::memory:#')
  ) {
    return;
  }
  let fsCandidate = target;
  if (/^file:/i.test(fsCandidate)) {
    try {
      fsCandidate = decodeURIComponent(new URL(fsCandidate).pathname);
    } catch {
      const stripped = fsCandidate.slice('file:'.length).split(/[?#]/)[0] ?? fsCandidate;
      try {
        fsCandidate = decodeURIComponent(stripped);
      } catch {
        fsCandidate = stripped;
      }
    }
  }
  const normalizedExact = resolve(fsCandidate);
  const normalizedTarget = resolve(stripSqliteCompanionSuffix(normalizedExact));

  const blockedExact: string[] = [];
  for (const raw of [process.env.APP_DB_PATH, process.env.FOXFLOW_DB_PATH]) {
    if (!raw || !raw.trim() || raw.trim() === ':memory:') continue;
    const base = resolve(stripSqliteCompanionSuffix(raw.trim()));
    blockedExact.push(base, join(dirname(base), '.app_encryption_key'));
  }

  for (const p of [normalizedExact, normalizedTarget]) {
    if (BLOCKED_SQLITE_BASENAMES.has(basename(p).toLowerCase()) || blockedExact.includes(p)) {
      throw new Error('Refusing to open FoxSchema internal database from a workflow SQL pipe');
    }
  }
}

const BLOCKED_AUTHORIZER_PRAGMAS = new Set([
  'writable_schema',
  'trusted_schema',
  'temp_store_directory',
  'data_store_directory',
]);

async function openMemorySqliteSession(): Promise<SqlSession> {
  const sqliteMod = await import('node:sqlite');
  const db = new sqliteMod.DatabaseSync(':memory:', { defensive: true });
  db.exec('PRAGMA trusted_schema = OFF');
  if (typeof db.setAuthorizer === 'function' && sqliteMod.constants) {
    const {
      SQLITE_ATTACH,
      SQLITE_DETACH,
      SQLITE_FUNCTION,
      SQLITE_PRAGMA,
      SQLITE_DENY,
      SQLITE_OK,
    } = sqliteMod.constants;
    db.setAuthorizer((actionCode, arg1, arg2) => {
      if (actionCode === SQLITE_ATTACH || actionCode === SQLITE_DETACH) {
        return SQLITE_DENY;
      }
      if (actionCode === SQLITE_FUNCTION && typeof arg2 === 'string' && arg2.toLowerCase() === 'load_extension') {
        return SQLITE_DENY;
      }
      if (actionCode === SQLITE_PRAGMA && typeof arg1 === 'string' && BLOCKED_AUTHORIZER_PRAGMAS.has(arg1.toLowerCase())) {
        return SQLITE_DENY;
      }
      return SQLITE_OK;
    });
  }
  return {
    async query(sql, params) {
      assertSafeSqliteSql(sql);
      const stmt = db.prepare(sql);
      const args = params as never[];
      if (stmt.columns().length > 0) {
        return stmt.all(...args) as Record<string, unknown>[];
      }
      stmt.run(...args);
      return [];
    },
    async transaction(work) {
      db.exec('BEGIN');
      try {
        const result = await work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}

const foxSchemaDrivers: SqlRunner = async ({ dialect, schema, option }, { dedicated }) => {
  const normalizedDialect = dialect.trim().toLowerCase();
  if (normalizedDialect === 'sqlite' || normalizedDialect === 'duckdb') {
    const target = sqliteTargetFromOption(option);
    assertSafeSqliteTarget(target);
    if (normalizedDialect === 'sqlite' && target === ':memory:') {
      return openMemorySqliteSession();
    }
  }
  if (sqlRunnerDelegate && NATIVE_ADDON_SQL_DIALECTS.has(normalizedDialect)) {
    return sqlRunnerDelegate({ dialect, ...(schema ? { schema } : {}), option }, { dedicated });
  }
  const db = await import('@foxschema/db');
  const adapter = db.getAdapter(dialect);
  const handle = await db.ConnectionFactory.create(dialect, option as never, { pooled: !dedicated });
  try {
    if (schema) await adapter.setCurrentSchema(handle, schema);
  } catch (error) {
    await db.ConnectionFactory.close(dialect, handle);
    throw error;
  }
  const canRollBack = db.dialectSupportsTransactionalRollback(dialect);
  return {
    query: (sql, params) => adapter.query<Record<string, unknown>>(handle, sql, params),
    async transaction(work) {
      if (!canRollBack) return work();
      await adapter.beginTransaction(handle);
      try {
        const result = await work();
        await adapter.commitTransaction(handle);
        return result;
      } catch (error) {
        // The statement's own error is the one worth reporting.
        await adapter.rollbackTransaction(handle).catch(() => undefined);
        throw error;
      }
    },
    close: () => db.ConnectionFactory.close(dialect, handle),
  };
};

const connectionFields = {
  /** Which database a credential entered in the engine is for. A saved FoxSchema connection already says. */
  dialect: z.string().min(1).optional(),
  /** Overrides the schema the credential names. */
  schema: z.string().min(1).optional(),
};

/** The local development database from `docker compose up` (docker-compose.yml). */
const DEV_POSTGRES = {
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'foxuser',
  POSTGRES_PASSWORD: 'foxpass',
  POSTGRES_DB: 'foxdb',
} as const;

/**
 * Where a Postgres step with no credential connects: the `POSTGRES_*`
 * variables, falling back to the development container's defaults.
 *
 * The defaults are development-only. In production a step without a
 * credential would otherwise try a database on this host with well-known
 * credentials, so there it connects only when the operator has named the
 * host, user and password; otherwise the step fails and says what to set.
 */
export function credentiallessPostgresOption(env: NodeJS.ProcessEnv): Record<string, unknown> {
  if (env.NODE_ENV === 'production') {
    const missing = (['POSTGRES_HOST', 'POSTGRES_USER', 'POSTGRES_PASSWORD'] as const).filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(
        `This SQL step has no database credential. Add one to the step, or set ${missing.join(', ')} on the server.`,
      );
    }
  }
  const host = env.POSTGRES_HOST || DEV_POSTGRES.POSTGRES_HOST;
  const port = Number(env.POSTGRES_PORT || DEV_POSTGRES.POSTGRES_PORT);
  const username = env.POSTGRES_USER || DEV_POSTGRES.POSTGRES_USER;
  const password = env.POSTGRES_PASSWORD || DEV_POSTGRES.POSTGRES_PASSWORD;
  const database = env.POSTGRES_DB || DEV_POSTGRES.POSTGRES_DB;
  return {
    host,
    port,
    username,
    user: username,
    password,
    database,
    connectionString: `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`,
  };
}

async function connectionFor(
  context: PipeContext,
  config: { dialect?: string; schema?: string },
): Promise<SqlConnection> {
  if (!context.pipe.credentialId && config.dialect === 'sqlite') {
    return {
      dialect: 'sqlite',
      ...(config.schema ? { schema: config.schema } : {}),
      option: { database: ':memory:' },
    };
  }
  if (!context.pipe.credentialId && config.dialect === 'postgres') {
    return {
      dialect: 'postgres',
      ...(config.schema ? { schema: config.schema } : {}),
      option: credentiallessPostgresOption(process.env),
    };
  }
  const secret = await requirePipeSecret(context, 'a database credential');
  return connectionFromSecret(secret, context.pipe.credentialId ?? '', config);
}

/**
 * The connection a revealed database credential describes. A saved FoxSchema
 * connection resolves to `{ dialect, schema, option }`; a credential entered
 * in the engine is the option bag itself, and `config.dialect` says what it is.
 */
export function connectionFromSecret(
  secret: Record<string, unknown>,
  credentialId: string,
  config: { dialect?: string; schema?: string },
): SqlConnection {
  const { dialect: secretDialect, schema: secretSchema, option, ...rest } = secret;
  const dialect = typeof secretDialect === 'string' && secretDialect ? secretDialect : config.dialect;
  if (!dialect) {
    throw new Error(
      `credential ${credentialId} does not say which database it is for; set dialect`,
    );
  }
  const schema = config.schema ?? (typeof secretSchema === 'string' ? secretSchema : undefined);
  return {
    dialect,
    ...(schema ? { schema } : {}),
    option: option && typeof option === 'object' ? (option as Record<string, unknown>) : rest,
  };
}

export interface RunSqlScriptOptions {
  transaction?: boolean;
  open?: SqlRunner;
  /**
   * Wraps opening the session (connecting, signing in, setting the schema),
   * for example to retry it. No statement has been sent at that point, so
   * repeating it is always safe; repeating the script is not.
   */
  connect?: <T>(open: () => Promise<T>) => Promise<T>;
  /**
   * Called with the last statement's rows once every statement has run, and
   * before a transaction commits: throwing from it rolls the script back where
   * the database can roll back.
   */
  beforeCommit?: (rows: Record<string, unknown>[]) => Promise<void>;
}

/**
 * Run a script's statements in order on one session and return the rows the
 * last one produced. What a SQL schedule does on each fire; `source.db.sql`
 * does the same with `{{path}}` binding on top.
 */
export async function runSqlScript(
  connection: SqlConnection,
  script: string,
  options: RunSqlScriptOptions = {},
): Promise<Record<string, unknown>[]> {
  const statements = statementsOf(script);
  if (statements.length === 0) throw new Error('sql holds no statements');
  return withSession(
    options.open ?? foxSchemaDrivers,
    connection,
    options.transaction ?? false,
    async (session) => {
      let last: Record<string, unknown>[] = [];
      for (const statement of statements) last = await session.query(statement, []);
      await options.beforeCommit?.(last);
      return last;
    },
    options.connect,
  );
}

/** A split template with every `{{path}}` bound as a parameter: split once, bound per use. */
function bindTemplate(
  { strings, paths }: ReturnType<typeof splitTemplate>,
  scope: Record<string, unknown>,
  dialect: string,
): RenderedSql {
  return renderSqlQuery(
    makeSqlQuery(strings, paths.map((path) => getPath(scope, path) ?? null)),
    dialect,
  );
}

/**
 * The statements of a script, without terminators. A PL/SQL block keeps its
 * `END;` — Oracle needs it — while a plain statement's `;` is dropped, since
 * several drivers refuse one.
 */
function statementsOf(script: string): string[] {
  return splitSqlStatements(script)
    .filter((statement) => statement.kind === 'sql')
    .map((statement) => statement.text.trim())
    .map((text) => (/\bEND\s*;$/i.test(text) ? text : text.replace(/;\s*$/, '')))
    .filter((text) => text.length > 0);
}

async function withSession<T>(
  open: SqlRunner,
  connection: SqlConnection,
  transactional: boolean,
  work: (session: SqlSession) => Promise<T>,
  connect: <S>(opening: () => Promise<S>) => Promise<S> = (opening) => opening(),
): Promise<T> {
  const session = await connect(() => open(connection, { dedicated: transactional }));
  try {
    return transactional ? await session.transaction(() => work(session)) : await work(session);
  } finally {
    await session.close();
  }
}

const sourceConfigSchema = z.object({
  /** One statement, or a script whose statements run in order. The last statement's rows are emitted. */
  sql: z.string().min(1),
  ...connectionFields,
  /** Run the script all-or-nothing, where the database can roll back. */
  transaction: z.boolean().default(false),
  ...batchSizeField({ max: 10_000 }),
});

export class SqlSourcePipe implements SourcePipe {
  readonly type = 'source.db.sql';
  readonly role = 'source';

  constructor(private readonly open: SqlRunner = foxSchemaDrivers) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'SQL query',
      category: 'Source/Database',
      family: 'database',
      tags: ['sql', 'query', 'job', 'script'],
      version: '0.1.0',
      role: 'source',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: sourceConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    sourceConfigSchema.parse(config);
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const config = sourceConfigSchema.parse(context.pipe.config);
    const statements = statementsOf(config.sql);
    if (statements.length === 0) throw new Error('sql holds no statements');
    const connection = await connectionFor(context, config);
    const scope = templateScope(context);

    const rows = await withSession(this.open, connection, config.transaction, async (session) => {
      let last: Record<string, unknown>[] = [];
      for (const statement of statements) {
        const { text, params } = bindTemplate(splitTemplate(statement), scope, connection.dialect);
        last = await session.query(text, params);
      }
      return last;
    });

    for (let offset = 0; offset < rows.length; offset += config.batchSize) {
      yield {
        id: `${context.pipe.id}:0:${offset}`,
        partitionId: '0',
        records: rows.slice(offset, offset + config.batchSize),
      };
    }
  }
}

function insertStatements(
  records: Record<string, unknown>[],
  table: string,
  configuredColumns: string[],
  dialect: string,
): RenderedSql[] {
  const columns = configuredColumns.length > 0 ? configuredColumns : Object.keys(records[0]!);
  if (columns.length === 0) throw new Error('the records have no fields to insert');
  const target = quoteQualifiedName(table, dialect);
  if (!target) throw new Error(`table is not a usable name: ${table}`);

  const perStatement = maxInsertRows(dialect, columns.length);
  const statements: RenderedSql[] = [];
  for (let start = 0; start < records.length; start += perStatement) {
    const rows = records.slice(start, start + perStatement);
    statements.push(
      renderSqlQuery(makeSqlQuery([`INSERT INTO ${target} `, ''], [sqlTag.values(rows, columns)]), dialect),
    );
  }
  return statements;
}

/** The statement once per record, its template split once for the whole batch. */
function recordStatements(
  records: Record<string, unknown>[],
  sql: string,
  scope: Record<string, unknown>,
  dialect: string,
): RenderedSql[] {
  const statements = statementsOf(sql);
  if (statements.length === 0) throw new Error('sql holds no statements');
  const templates = statements.map((statement) => splitTemplate(statement));
  return records.flatMap((record) =>
    templates.map((template) =>
      bindTemplate(template, { ...record, ...scope, record }, dialect),
    ),
  );
}

function inferColumnType(records: Record<string, unknown>[], col: string, dialect: 'sqlite' | 'postgres'): string {
  const values = records.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (dialect === 'sqlite') {
    if (nums.length > 0 && nums.length === values.length) {
      return nums.every((n) => Number.isInteger(n)) ? 'INTEGER' : 'REAL';
    }
    if (values.length > 0 && typeof values[0] === 'boolean') return 'INTEGER';
    return 'TEXT';
  }
  if (nums.length > 0 && nums.length === values.length) {
    // Only integer `id` narrows to BIGINT; data measurements stay NUMERIC so an
    // integer first batch does not reject decimal values in subsequent batches.
    if (col === 'id' && nums.every((n) => Number.isInteger(n))) return 'BIGINT';
    return 'NUMERIC';
  }
  if (values.length > 0 && typeof values[0] === 'boolean') return 'BOOLEAN';
  return 'TEXT';
}

export function sqliteCreateTableSql(
  records: Record<string, unknown>[],
  table: string,
  configuredColumns: string[],
): { create: string; alterColumns: string[] } {
  const columns = configuredColumns.length > 0 ? configuredColumns : Object.keys(records[0]!);
  const target = quoteQualifiedName(table, 'sqlite');
  const defs: string[] = [];
  if (!columns.includes('id')) {
    defs.push('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
  }
  for (const col of columns) {
    const quoted = quoteQualifiedName(col, 'sqlite');
    const sqlType = inferColumnType(records, col, 'sqlite');
    defs.push(col === 'id' ? `${quoted} ${sqlType} PRIMARY KEY` : `${quoted} ${sqlType}`);
  }
  const alterColumns = columns.map((col) => {
    const quoted = quoteQualifiedName(col, 'sqlite');
    const sqlType = inferColumnType(records, col, 'sqlite');
    return `ALTER TABLE ${target} ADD COLUMN ${quoted} ${sqlType}`;
  });
  return {
    create: `CREATE TABLE IF NOT EXISTS ${target} (${defs.join(', ')})`,
    alterColumns,
  };
}

export function postgresCreateTableSql(
  records: Record<string, unknown>[],
  table: string,
  configuredColumns: string[],
): { create: string; alterColumns: string[] } {
  const columns = configuredColumns.length > 0 ? configuredColumns : Object.keys(records[0]!);
  const target = quoteQualifiedName(table, 'postgres');
  const defs: string[] = [];
  if (!columns.includes('id')) {
    defs.push('"id" SERIAL PRIMARY KEY');
  }
  for (const col of columns) {
    const quoted = quoteQualifiedName(col, 'postgres');
    const sqlType = inferColumnType(records, col, 'postgres');
    if (col === 'id') {
      defs.push(`${quoted} ${sqlType === 'BIGINT' ? 'BIGINT' : sqlType} PRIMARY KEY`);
    } else {
      defs.push(`${quoted} ${sqlType}`);
    }
  }
  if (!columns.includes('created_at')) {
    defs.push('"created_at" TIMESTAMPTZ DEFAULT NOW()');
  }
  const alterColumns = columns.map((col) => {
    const quoted = quoteQualifiedName(col, 'postgres');
    const sqlType = inferColumnType(records, col, 'postgres');
    return `ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS ${quoted} ${sqlType}`;
  });
  if (!columns.includes('created_at')) {
    alterColumns.push(`ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT NOW()`);
  }
  return {
    create: `CREATE TABLE IF NOT EXISTS ${target} (${defs.join(', ')})`,
    alterColumns,
  };
}

export const columnMappingItemSchema = z.object({
  targetColumn: z.string().min(1),
  sourcePath: z.string().optional(),
  sourceProperty: z.string().optional(),
  expression: z.string().optional(),
  transform: z.string().optional(),
  defaultValue: z.unknown().optional(),
  isKey: z.boolean().optional(),
});
export type ColumnMappingItem = z.infer<typeof columnMappingItemSchema>;

export function resolveUpsertKeys(config: {
  upsertKey?: string | string[];
  upsertKeys?: string[];
}): string[] | undefined {
  if (Array.isArray(config.upsertKeys) && config.upsertKeys.length > 0) {
    const keys = config.upsertKeys.map((k) => k.trim()).filter(Boolean);
    return keys.length > 0 ? keys : undefined;
  }
  if (Array.isArray(config.upsertKey) && config.upsertKey.length > 0) {
    const keys = config.upsertKey.map((k) => k.trim()).filter(Boolean);
    return keys.length > 0 ? keys : undefined;
  }
  if (typeof config.upsertKey === 'string' && config.upsertKey.trim()) {
    if (config.upsertKey.includes(',')) {
      const keys = config.upsertKey.split(',').map((k) => k.trim()).filter(Boolean);
      return keys.length > 0 ? keys : undefined;
    }
    return [config.upsertKey.trim()];
  }
  return undefined;
}

const sinkConfigSchema = z
  .object({
    /** `insert` writes records into `table`; `statement` runs `sql` once per record; `mapped` uses explicit columnMapping. */
    mode: z.enum(['insert', 'statement', 'mapped']).default('insert'),
    /** Target table, optionally schema-qualified. */
    table: z.string().min(1).optional(),
    /** Columns to write, in order. Empty takes every field of the batch's first record. */
    columns: z.array(z.string().min(1)).default([]),
    /** Field-to-column mappings for side-by-side ETL mapping */
    columnMapping: z.array(columnMappingItemSchema).optional(),
    /**
     * Insert/mapped mode only: the column or columns that identify a row.
     * Supports a single key string (e.g. 'id') or combination keys string[]
     * (e.g. ['tenant_id', 'user_id']).
     */
    upsertKey: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    upsertKeys: z.array(z.string().min(1)).optional(),
    /** Optional SQL condition clause for the upsert update (e.g. 'EXCLUDED.updated_at >= target.updated_at'). */
    upsertCondition: z.string().optional(),
    /** Timeout for mapping transforms in milliseconds (1 - 60,000). Defaults to 5,000. */
    transformTimeoutMs: z.number().int().min(1).max(60_000).default(5_000).optional(),
    /** Heap cap for transform worker in MB (16 - 4,096). Defaults to 128. */
    transformMemoryMb: z.number().int().min(16).max(4_096).default(128).optional(),
    /** Statement per record; `{{record.field}}` binds a field. */
    sql: z.string().min(1).optional(),
    ...connectionFields,
    /** Write each batch all-or-nothing, where the database can roll back. */
    transaction: z.boolean().default(true),
  })
  .refine((config) => (config.mode !== 'insert' && config.mode !== 'mapped') || config.table, {
    message: 'insert and mapped modes need a table',
    path: ['table'],
  })
  .refine((config) => config.mode !== 'statement' || config.sql, {
    message: 'statement mode needs sql',
    path: ['sql'],
  })
  .refine(
    (config) => config.mode !== 'mapped' || (Array.isArray(config.columnMapping) && config.columnMapping.length > 0),
    {
      message: 'mapped mode requires at least one columnMapping',
      path: ['columnMapping'],
    },
  )
  .refine((config) => !resolveUpsertKeys(config) || config.mode === 'insert' || config.mode === 'mapped', {
    message: 'upsertKey applies to insert and mapped modes only',
    path: ['upsertKey'],
  })
  .refine(
    (config) => {
      const keys = resolveUpsertKeys(config);
      if (!keys || keys.length === 0) return true;
      if (config.dialect) {
        const d = config.dialect.toLowerCase();
        return d === 'sqlite' || d === 'postgres';
      }
      return true;
    },
    {
      message: 'upsertKey is supported on PostgreSQL and SQLite only',
      path: ['dialect'],
    },
  )
  .refine(
    (config) => {
      const keys = resolveUpsertKeys(config);
      if (!keys) return true;
      const effectiveColumns =
        config.columnMapping && config.columnMapping.length > 0
          ? config.columnMapping.map((m) => m.targetColumn)
          : config.columns;
      if (effectiveColumns.length === 0) return true;
      return keys.every((key) => effectiveColumns.includes(key));
    },
    {
      message: 'every upsertKey must be one of the columns written',
      path: ['upsertKey'],
    },
  );

/** Adds `AS target` alias to the target table of an INSERT INTO statement safely without regex back-tracking. */
function aliasInsertTarget(sqlText: string): string {
  if (/\bAS\s+target\b/i.test(sqlText)) return sqlText;
  const prefixMatch = /^INSERT INTO\s+/i.exec(sqlText);
  if (!prefixMatch) return sqlText;
  let i = prefixMatch[0].length;
  let inQuote = false;
  const start = i;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (ch === '"') {
      if (inQuote && sqlText[i + 1] === '"') {
        i += 2;
        continue;
      }
      inQuote = !inQuote;
    } else if (!inQuote) {
      if (ch === '(') break;
      if (/\s/.test(ch)) {
        const rest = sqlText.slice(i).trimStart();
        if (/^(VALUES|AS)\b/i.test(rest)) {
          break;
        }
      }
    }
    i++;
  }
  const target = sqlText.slice(start, i).trim();
  if (!target) return sqlText;
  return `${sqlText.slice(0, start)}${target} AS target ${sqlText.slice(i).trimStart()}`;
}

/**
 * Turn an `INSERT` into an upsert on `key` or composite combination keys: a row
 * whose key already exists is updated with the other written columns (or left
 * alone when there are none). Optional update `condition` appends a WHERE clause.
 */
export function upsertSql(
  sqlText: string,
  columns: string[],
  keyOrKeys: string | string[],
  dialect: string,
  condition?: string,
): string {
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    throw new Error(`upsertKey is supported on PostgreSQL and SQLite, not ${dialect}`);
  }
  if (!sqlText.startsWith('INSERT INTO ')) return sqlText;
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  for (const key of keys) {
    if (!columns.includes(key)) throw new Error(`upsertKey ${key} is not one of the columns written`);
  }

  // Alias target table as "target" so condition expressions like EXCLUDED.col >= target.col work
  const aliasedSql = aliasInsertTarget(sqlText);

  const quotedKeys = keys.map((key) => quoteQualifiedName(key, dialect)).join(', ');
  const keySet = new Set(keys);
  const updates = columns
    .filter((column) => !keySet.has(column))
    .map((column) => {
      const quoted = quoteQualifiedName(column, dialect);
      return `${quoted} = excluded.${quoted}`;
    });
  let clause =
    updates.length === 0
      ? `${aliasedSql} ON CONFLICT (${quotedKeys}) DO NOTHING`
      : `${aliasedSql} ON CONFLICT (${quotedKeys}) DO UPDATE SET ${updates.join(', ')}`;
  if (updates.length > 0 && condition && condition.trim()) {
    clause += ` WHERE ${condition.trim()}`;
  }
  return clause;
}

/**
 * One record per key (or composite combination keys), the last one winning.
 * A single upsert statement may not touch the same row twice, so duplicate
 * keys in one batch must collapse first.
 */
function lastPerKey(records: Record<string, unknown>[], keyOrKeys: string | string[]): Record<string, unknown>[] {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const compositeKey = JSON.stringify(keys.map((k) => record[k] ?? null));
    byKey.set(compositeKey, record);
  }
  return [...byKey.values()];
}

/**
 * Transforms incoming generic objects into database row objects by mapping
 * dot-paths, evaluating transform expressions in a sandbox worker, and inserting fallback defaults.
 */
export async function applyColumnMapping(
  records: Record<string, unknown>[],
  mappings: ColumnMappingItem[],
  options?: { timeoutMs?: number; memoryMb?: number },
): Promise<Record<string, unknown>[]> {
  if (records.length === 0 || mappings.length === 0) return records;

  // 1. Map all rows in-process first. Preserves native types (Date, Buffer, BigInt, etc.)
  const inProcessRows: Record<string, unknown>[] = records.map((record) => {
    const row: Record<string, unknown> = {};
    for (const m of mappings) {
      if (!m.targetColumn) continue;
      const prop = m.sourcePath || m.sourceProperty;
      let val = prop ? getPath(record, prop) : undefined;
      if (val === undefined || val === null) {
        val = m.defaultValue !== undefined ? m.defaultValue : val;
      }
      row[m.targetColumn] = val;
    }
    return row;
  });

  const transformedItems = mappings.filter((m) => {
    const expr = (m.transform || m.expression || '').trim();
    return expr && expr !== 'value';
  });

  if (transformedItems.length === 0) {
    return inProcessRows;
  }

  // 2. Security: Run only user transform expressions in worker sandbox with budget.
  // Send only the inputs for transformed columns to avoid converting non-transformed columns (Dates, Buffers, BigInts).
  const transformInputs = records.map((record) => {
    const inputs: Record<string, unknown> = {};
    for (const m of transformedItems) {
      const prop = m.sourcePath || m.sourceProperty;
      let val = prop ? getPath(record, prop) : undefined;
      if (val === undefined || val === null) {
        val = m.defaultValue !== undefined ? m.defaultValue : val;
      }
      inputs[m.targetColumn] = val;
    }
    return inputs;
  });

  const transformDefs = transformedItems.map((m) => ({
    targetColumn: m.targetColumn,
    expr: (m.transform || m.expression || '').trim(),
  }));

  const body = `
    const defs = ${JSON.stringify(transformDefs)};
    const compiled = defs.map((d) => {
      try {
        return new Function('value', 'return (' + d.expr + ');');
      } catch (err) {
        throw new Error('Failed to compile transform expression "' + d.expr + '" for column "' + d.targetColumn + '": ' + (err && err.message ? err.message : String(err)));
      }
    });

    return records.map((inputRow, rowIndex) => {
      const out = {};
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        let val = inputRow[d.targetColumn];
        if (val !== undefined && val !== null) {
          try {
            val = compiled[i](val);
          } catch (err) {
            throw new Error('Failed to evaluate transform expression "' + d.expr + '" for column "' + d.targetColumn + '" on row ' + (rowIndex + 1) + ': ' + (err && err.message ? err.message : String(err)));
          }
        }
        out[d.targetColumn] = val;
      }
      return out;
    });
  `;

  const timeoutMs = options?.timeoutMs ?? 5_000;
  const memoryMb = options?.memoryMb ?? 128;

  const { result } = await runSandboxedWithLogs(body, transformInputs, {
    timeoutMs,
    maxOldGenerationSizeMb: memoryMb,
  });

  const transformedOutputs = result as Record<string, unknown>[];
  for (let i = 0; i < inProcessRows.length; i++) {
    const transformedRow = transformedOutputs[i];
    if (transformedRow) {
      for (const d of transformDefs) {
        inProcessRows[i][d.targetColumn] = transformedRow[d.targetColumn];
      }
    }
  }

  return inProcessRows;
}

const ddlLocks = new Map<string, Promise<void>>();

async function withDdlLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = ddlLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  ddlLocks.set(key, next);
  await prev;
  try {
    return await work();
  } finally {
    release();
    if (ddlLocks.get(key) === next) {
      ddlLocks.delete(key);
    }
  }
}

function autoTableLockKey(connection: SqlConnection, table: string): string {
  return [
    connection.dialect,
    connection.schema ?? '',
    String(connection.option.host ?? ''),
    String(connection.option.port ?? ''),
    String(connection.option.database ?? ''),
    String(connection.option.connectionString ?? ''),
    table,
  ].join(':');
}

function computeIndexName(table: string, keys: string[]): string {
  const cleanTable = table.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
  const hash = createHash('sha256')
    .update(`${table}:${keys.join(',')}`)
    .digest('hex')
    .slice(0, 10);
  return `uq_${cleanTable}_${hash}`;
}

/**
 * Ensures the auto-created target table and columns exist before batch writes.
 * Serialized per target table and guarded in PostgreSQL by a transaction-scoped
 * advisory lock so concurrent pipeline batches never collide on `pg_type`.
 */
export async function ensureAutoTable(
  open: SqlRunner,
  connection: SqlConnection,
  table: string,
  records: Record<string, unknown>[],
  columns: string[],
  upsertKeys?: string[],
): Promise<void> {
  if (connection.dialect !== 'sqlite' && connection.dialect !== 'postgres') return;
  const key = autoTableLockKey(connection, table);
  await withDdlLock(key, async () => {
    if (connection.dialect === 'sqlite') {
      const ddl = sqliteCreateTableSql(records, table, columns);
      await withSession(open, connection, false, async (session) => {
        await session.query(ddl.create, []);
        for (const alterSql of ddl.alterColumns) {
          try {
            await session.query(alterSql, []);
          } catch {
            // SQLite has no ADD COLUMN IF NOT EXISTS; ignore duplicate-column errors.
          }
        }
        if (upsertKeys && upsertKeys.length > 0) {
          const idxName = computeIndexName(table, upsertKeys);
          const target = quoteQualifiedName(table, 'sqlite');
          const quotedKeys = upsertKeys.map((k) => quoteQualifiedName(k, 'sqlite')).join(', ');
          try {
            await session.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON ${target} (${quotedKeys})`, []);
          } catch (err) {
            throw new Error(`Could not ensure unique index for upsertKeys [${upsertKeys.join(', ')}] on table "${table}": ${(err as Error).message}`);
          }
        }
      });
      return;
    }

    const ddl = postgresCreateTableSql(records, table, columns);
    const advisoryKey = `${connection.schema ?? 'public'}.${table}`;
    await withSession(open, connection, true, async (session) => {
      await session.query('SELECT pg_advisory_xact_lock(hashtext($1))', [advisoryKey]);
      await session.query(ddl.create, []);
      for (const alterSql of ddl.alterColumns) {
        await session.query(alterSql, []);
      }
      if (upsertKeys && upsertKeys.length > 0) {
        const idxName = computeIndexName(table, upsertKeys);
        const target = quoteQualifiedName(table, 'postgres');
        const quotedKeys = upsertKeys.map((k) => quoteQualifiedName(k, 'postgres')).join(', ');
        try {
          await session.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON ${target} (${quotedKeys})`, []);
        } catch (err) {
          throw new Error(`Could not ensure unique index for upsertKeys [${upsertKeys.join(', ')}] on table "${table}": ${(err as Error).message}`);
        }
      }
    });
  });
}

export class SqlSinkPipe implements SinkPipe {
  readonly type: string = 'sink.db.sql';
  readonly role = 'sink';

  constructor(private readonly open: SqlRunner = foxSchemaDrivers) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'SQL write',
      category: 'Output/Database',
      family: 'database',
      tags: ['sql', 'insert', 'write'],
      version: '0.1.0',
      role: 'sink',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: sinkConfigSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    sinkConfigSchema.parse(config);
  }

  async write(batch: RecordBatch, context: PipeContext): Promise<RecordBatch | void> {
    if (batch.records.length === 0) return;
    const config = sinkConfigSchema.parse(context.pipe.config);
    const connection = await connectionFor(context, config);
    const scope = templateScope(context);

    const isInsert = config.mode === 'insert' || config.mode === 'mapped';

    // Apply columnMapping if provided or in mapped mode
    const mappedRecords =
      config.columnMapping && config.columnMapping.length > 0
        ? await applyColumnMapping(batch.records, config.columnMapping, {
            timeoutMs: config.transformTimeoutMs,
            memoryMb: config.transformMemoryMb,
          })
        : batch.records;

    const upsertKeys = resolveUpsertKeys(config);
    if (upsertKeys && upsertKeys.length > 0) {
      if (connection.dialect !== 'postgres' && connection.dialect !== 'sqlite') {
        throw new Error(
          `upsertKey is supported on PostgreSQL and SQLite only, but connection uses ${connection.dialect}`,
        );
      }
    }
    const records = upsertKeys ? lastPerKey(mappedRecords, upsertKeys) : mappedRecords;

    const effectiveColumns =
      config.columnMapping && config.columnMapping.length > 0
        ? config.columnMapping.map((m) => m.targetColumn)
        : config.columns;

    const statements = isInsert
      ? insertStatements(records, config.table!, effectiveColumns, connection.dialect)
      : recordStatements(batch.records, config.sql!, scope, connection.dialect);

    if (
      this.open === foxSchemaDrivers &&
      isInsert &&
      config.table &&
      (connection.dialect === 'sqlite' || connection.dialect === 'postgres')
    ) {
      await ensureAutoTable(this.open, connection, config.table, records, effectiveColumns, upsertKeys);
    }

    const returnedRows = await withSession(this.open, connection, config.transaction, async (session) => {
      const insertColumns = isInsert
        ? effectiveColumns.length > 0
          ? effectiveColumns
          : Object.keys(records[0]!)
        : [];
      const rows: Record<string, unknown>[] = [];
      for (const statement of statements) {
        const sqlText = upsertKeys
          ? upsertSql(statement.text, insertColumns, upsertKeys, connection.dialect, config.upsertCondition)
          : statement.text;
        const result = await session.query(sqlText, statement.params);
        if (result.length > 0) rows.push(...result);
      }
      return rows;
    });
    if (returnedRows.length > 0) {
      return {
        id: batch.id,
        partitionId: batch.partitionId,
        records: returnedRows,
      };
    }
  }
}

export class MappedDbSinkPipe extends SqlSinkPipe {
  override readonly type = 'sink.db.mapped-insert';

  override validateConfig(config: Record<string, unknown>): void {
    super.validateConfig({ ...config, mode: 'mapped' });
  }

  override metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Mapped DB insert',
      category: 'Output/Database',
      family: 'database',
      tags: ['sql', 'insert', 'mapping', 'upsert', 'etl'],
      version: '0.1.0',
      role: 'sink',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: sinkConfigSchema,
    });
  }
}
