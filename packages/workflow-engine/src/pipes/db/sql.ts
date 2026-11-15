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

const foxSchemaDrivers: SqlRunner = async ({ dialect, schema, option }, { dedicated }) => {
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
    const host = process.env.POSTGRES_HOST ?? '127.0.0.1';
    const port = Number(process.env.POSTGRES_PORT ?? 5432);
    const username = process.env.POSTGRES_USER ?? 'foxuser';
    const password = process.env.POSTGRES_PASSWORD ?? 'foxpass';
    const database = process.env.POSTGRES_DB ?? 'foxdb';
    return {
      dialect: 'postgres',
      ...(config.schema ? { schema: config.schema } : {}),
      option: {
        host,
        port,
        username,
        user: username,
        password,
        database,
        connectionString: `postgresql://${username}:${password}@${host}:${port}/${database}`,
      },
    };
  }
  const secret = await requirePipeSecret(context, 'a database credential');

  // A saved FoxSchema connection resolves to { dialect, schema, option }; a
  // credential entered in the engine is the option bag itself.
  const { dialect: secretDialect, schema: secretSchema, option, ...rest } = secret;
  const dialect = typeof secretDialect === 'string' && secretDialect ? secretDialect : config.dialect;
  if (!dialect) {
    throw new Error(
      `credential ${context.pipe.credentialId} does not say which database it is for; set dialect`,
    );
  }
  const schema = config.schema ?? (typeof secretSchema === 'string' ? secretSchema : undefined);
  return {
    dialect,
    ...(schema ? { schema } : {}),
    option: option && typeof option === 'object' ? (option as Record<string, unknown>) : rest,
  };
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
): Promise<T> {
  const session = await open(connection, { dedicated: transactional });
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
  });

export function postgresUpsertSql(sqlText: string, columns: string[]): string {
  if (!columns.includes('id') || !sqlText.startsWith('INSERT INTO ')) return sqlText;
  const nonIdCols = columns.filter((col) => col !== 'id');
  if (nonIdCols.length === 0) {
    return `${sqlText} ON CONFLICT ("id") DO NOTHING`;
  }
  const updates = nonIdCols
    .map((col) => {
      const quoted = quoteQualifiedName(col, 'postgres');
      return `${quoted} = EXCLUDED.${quoted}`;
    })
    .join(', ');
  return `${sqlText} ON CONFLICT ("id") DO UPDATE SET ${updates}`;
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
    const statements =
      config.mode === 'insert'
        ? insertStatements(batch.records, config.table!, config.columns, connection.dialect)
        : recordStatements(batch.records, config.sql!, scope, connection.dialect);

    if (
      this.open === foxSchemaDrivers &&
      config.mode === 'insert' &&
      config.table &&
      (connection.dialect === 'sqlite' || connection.dialect === 'postgres')
    ) {
      await ensureAutoTable(this.open, connection, config.table, batch.records, config.columns);
    }

    const returnedRows = await withSession(this.open, connection, config.transaction, async (session) => {
      const insertColumns =
        config.mode === 'insert'
          ? config.columns.length > 0
            ? config.columns
            : Object.keys(batch.records[0]!)
          : [];
      const rows: Record<string, unknown>[] = [];
      for (const statement of statements) {
        let sqlText = statement.text;
        if (this.open === foxSchemaDrivers && config.mode === 'insert' && sqlText.startsWith('INSERT INTO ')) {
          if (connection.dialect === 'sqlite') {
            sqlText = sqlText.replace(/^INSERT INTO /, 'INSERT OR REPLACE INTO ');
          } else if (connection.dialect === 'postgres') {
            sqlText = postgresUpsertSql(sqlText, insertColumns);
          }
        }
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
