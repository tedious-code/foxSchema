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
import { basename, resolve } from 'node:path';
import * as z from 'zod';
import {
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

const BLOCKED_SQLITE_BASENAMES = new Set([
  'foxschema.db',
  'workflow-engine.sqlite',
]);

function sqliteTargetFromOption(option: Record<string, unknown>): string {
  const conn = option.connectionString;
  if (typeof conn === 'string' && conn.trim()) return conn.trim();
  const raw = option.database ?? option.filename ?? option.file;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ':memory:';
}

function assertSafeSqliteTarget(target: string): void {
  if (target === ':memory:' || target.startsWith('file::memory:')) return;
  let fsCandidate = target;
  if (fsCandidate.startsWith('file:')) {
    try {
      fsCandidate = new URL(fsCandidate).pathname;
    } catch {
      fsCandidate = fsCandidate.slice('file:'.length).split('?')[0] ?? fsCandidate;
    }
  }
  const normalizedTarget = resolve(fsCandidate);
  const blockedExact = [process.env.APP_DB_PATH, process.env.FOXFLOW_DB_PATH]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => resolve(value));
  const targetName = basename(normalizedTarget).toLowerCase();
  if (BLOCKED_SQLITE_BASENAMES.has(targetName) || blockedExact.includes(normalizedTarget)) {
    throw new Error('Refusing to open FoxSchema internal database from a workflow SQL pipe');
  }
}

async function openMemorySqliteSession(): Promise<SqlSession> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return {
    async query(sql, params) {
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
  if (dialect === 'sqlite') {
    const target = sqliteTargetFromOption(option);
    assertSafeSqliteTarget(target);
    if (target === ':memory:') {
      return openMemorySqliteSession();
    }
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

const sinkConfigSchema = z
  .object({
    /** `insert` writes records into `table`; `statement` runs `sql` once per record. */
    mode: z.enum(['insert', 'statement']).default('insert'),
    /** Target table, optionally schema-qualified. */
    table: z.string().min(1).optional(),
    /** Columns to write, in order. Empty takes every field of the batch's first record. */
    columns: z.array(z.string().min(1)).default([]),
    /**
     * Insert mode only: the column that identifies a row. With it, a record
     * whose key is already in the table updates that row instead of adding
     * one, so running the workflow again does not duplicate rows. The column
     * needs a unique or primary-key constraint (a table this step creates has
     * one on `id`). PostgreSQL and SQLite only. Without it, rows are inserted.
     */
    upsertKey: z.string().min(1).optional(),
    /** Statement per record; `{{record.field}}` binds a field. */
    sql: z.string().min(1).optional(),
    ...connectionFields,
    /** Write each batch all-or-nothing, where the database can roll back. */
    transaction: z.boolean().default(true),
  })
  .refine((config) => config.mode !== 'insert' || config.table, {
    message: 'insert mode needs a table',
    path: ['table'],
  })
  .refine((config) => config.mode !== 'statement' || config.sql, {
    message: 'statement mode needs sql',
    path: ['sql'],
  })
  .refine((config) => !config.upsertKey || config.mode === 'insert', {
    message: 'upsertKey applies to insert mode only',
    path: ['upsertKey'],
  })
  .refine((config) => !config.upsertKey || config.columns.length === 0 || config.columns.includes(config.upsertKey), {
    message: 'upsertKey must be one of the columns written',
    path: ['upsertKey'],
  });

/**
 * Turn an `INSERT` into an upsert on `key`: a row whose key already exists is
 * updated with the other written columns (or left alone when there are none).
 * Only when the step asks for it with `upsertKey`; a plain insert stays one.
 */
export function upsertSql(sqlText: string, columns: string[], key: string, dialect: string): string {
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    throw new Error(`upsertKey is supported on PostgreSQL and SQLite, not ${dialect}`);
  }
  if (!sqlText.startsWith('INSERT INTO ')) return sqlText;
  if (!columns.includes(key)) throw new Error(`upsertKey ${key} is not one of the columns written`);
  const quotedKey = quoteQualifiedName(key, dialect);
  const updates = columns
    .filter((column) => column !== key)
    .map((column) => {
      const quoted = quoteQualifiedName(column, dialect);
      return `${quoted} = excluded.${quoted}`;
    });
  return updates.length === 0
    ? `${sqlText} ON CONFLICT (${quotedKey}) DO NOTHING`
    : `${sqlText} ON CONFLICT (${quotedKey}) DO UPDATE SET ${updates.join(', ')}`;
}

/**
 * One record per key, the last one winning. A single upsert statement may not
 * touch the same row twice, so duplicate keys in one batch must collapse first.
 */
function lastPerKey(records: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const record of records) byKey.set(JSON.stringify(record[key] ?? null), record);
  return [...byKey.values()];
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
    });
  });
}

export class SqlSinkPipe implements SinkPipe {
  readonly type = 'sink.db.sql';
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
    const records = config.upsertKey ? lastPerKey(batch.records, config.upsertKey) : batch.records;
    const statements =
      config.mode === 'insert'
        ? insertStatements(records, config.table!, config.columns, connection.dialect)
        : recordStatements(batch.records, config.sql!, scope, connection.dialect);

    if (
      this.open === foxSchemaDrivers &&
      config.mode === 'insert' &&
      config.table &&
      (connection.dialect === 'sqlite' || connection.dialect === 'postgres')
    ) {
      await ensureAutoTable(this.open, connection, config.table, records, config.columns);
    }

    const returnedRows = await withSession(this.open, connection, config.transaction, async (session) => {
      const insertColumns =
        config.mode === 'insert'
          ? config.columns.length > 0
            ? config.columns
            : Object.keys(records[0]!)
          : [];
      const rows: Record<string, unknown>[] = [];
      for (const statement of statements) {
        const sqlText = config.upsertKey
          ? upsertSql(statement.text, insertColumns, config.upsertKey, connection.dialect)
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
