/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL pipes against a recording session: what reaches the database, in
 * which dialect's spelling, and inside which transaction.
 */
import { describe, expect, it } from 'vitest';
import type { CredentialStore } from '../../common/index.js';
import type { PipeContext, RecordBatch } from '../../registry/index.js';
import {
  AggregatePipe,
  DedupePipe,
  RedactPipe,
} from '../utility/transforms.js';
import {
  MappedDbSinkPipe,
  credentiallessPostgresOption,
  openRunMemoryDatabases,
  releaseRunMemoryDatabase,
  SqlSinkPipe,
  SqlSourcePipe,
  applyColumnMapping,
  ensureAutoTable,
  postgresCreateTableSql,
  resolveUpsertKeys,
  sqliteCreateTableSql,
  upsertSql,
  type SqlConnection,
  type SqlRunner,
  type SqlSession,
} from './sql.js';

class RecordingSession implements SqlSession {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  transactions = 0;
  inTransaction = false;
  closed = false;

  constructor(
    private readonly answer: (sql: string) => Record<string, unknown>[] = () => [],
    private readonly failOn?: RegExp,
  ) {}

  async query(sql: string, params: readonly unknown[]) {
    this.queries.push({ sql, params: [...params] });
    if (this.failOn?.test(sql)) throw new Error('statement failed');
    return this.answer(sql);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactions += 1;
    this.inTransaction = true;
    try {
      return await work();
    } finally {
      this.inTransaction = false;
    }
  }

  async close() {
    this.closed = true;
  }
}

function runner(session: RecordingSession) {
  const opened: Array<{ connection: SqlConnection; dedicated: boolean }> = [];
  const open: SqlRunner = async (connection, { dedicated }) => {
    opened.push({ connection, dedicated });
    return session;
  };
  return { open, opened };
}

function context(
  type: string,
  role: 'source' | 'sink',
  config: Record<string, unknown>,
  secret: Record<string, unknown> | undefined,
  extra: Partial<PipeContext> = {},
): PipeContext {
  const credentials = {
    revealSecret: async (id: string) => (id === 'db' ? secret : undefined),
  } as unknown as CredentialStore;
  return {
    workflowRunId: 'run',
    pipelineId: 'pipeline',
    pipe: { id: 'sql', type, role, config, concurrency: 1, credentialId: 'db' },
    credentials,
    ...extra,
  };
}

const saved = (dialect: string) => ({ dialect, schema: 'app', option: { host: 'db', password: 'pw' } });

async function collect(source: SqlSourcePipe, ctx: PipeContext): Promise<RecordBatch[]> {
  const batches: RecordBatch[] = [];
  for await (const batch of source.read(ctx)) batches.push(batch);
  return batches;
}

const batchOf = (records: Record<string, unknown>[]): RecordBatch => ({ id: 'b', partitionId: '0', records });

describe('source.db.sql', () => {
  it('binds template values as parameters in the dialect’s own style', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);
    const ctx = context(
      'source.db.sql',
      'source',
      { sql: 'SELECT * FROM orders WHERE region = {{vars.region}} AND id > {{trigger.after}}' },
      saved('sqlserver'),
      { variables: { region: "north'; DROP TABLE orders; --" }, invocation: { payload: { after: 7 } } as never },
    );

    await collect(new SqlSourcePipe(open), ctx);

    expect(session.queries).toEqual([
      {
        sql: 'SELECT * FROM orders WHERE region = @p0 AND id > @p1',
        params: ["north'; DROP TABLE orders; --", 7],
      },
    ]);
  });

  it('emits the last statement’s rows in batches of batchSize', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const session = new RecordingSession((sql) => (sql.startsWith('SELECT') ? rows : []));
    const { open } = runner(session);

    const batches = await collect(
      new SqlSourcePipe(open),
      context('source.db.sql', 'source', { sql: 'SELECT id FROM t', batchSize: 2 }, saved('postgres')),
    );

    expect(batches.map((batch) => batch.records)).toEqual([rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)]);
    expect(session.closed).toBe(true);
  });

  it('runs a script in order, inside one transaction on a dedicated connection when asked', async () => {
    const session = new RecordingSession();
    const { open, opened } = runner(session);

    await collect(
      new SqlSourcePipe(open),
      context(
        'source.db.sql',
        'source',
        { sql: 'DELETE FROM staging;\nINSERT INTO staging SELECT * FROM raw;', transaction: true },
        saved('postgres'),
      ),
    );

    expect(session.queries.map((q) => q.sql)).toEqual(['DELETE FROM staging', 'INSERT INTO staging SELECT * FROM raw']);
    expect(session.transactions).toBe(1);
    expect(opened[0]!.dedicated).toBe(true);
  });

  it('keeps the END; a PL/SQL block needs', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);

    await collect(
      new SqlSourcePipe(open),
      context('source.db.sql', 'source', { sql: 'BEGIN refresh_totals(); END;' }, saved('oracle')),
    );

    expect(session.queries[0]!.sql).toMatch(/END;$/);
  });

  it('reads a credential entered in the engine, with the dialect from config', async () => {
    const session = new RecordingSession();
    const { open, opened } = runner(session);

    await collect(
      new SqlSourcePipe(open),
      context('source.db.sql', 'source', { sql: 'SELECT 1', dialect: 'mysql' }, { host: 'db', password: 'pw' }),
    );

    expect(opened[0]!.connection).toEqual({
      dialect: 'mysql',
      option: { host: 'db', password: 'pw' },
      runId: 'run',
    });
  });

  it('refuses a credential that does not say which database it is for', async () => {
    const { open } = runner(new RecordingSession());
    await expect(
      collect(new SqlSourcePipe(open), context('source.db.sql', 'source', { sql: 'SELECT 1' }, { host: 'db' })),
    ).rejects.toThrow(/set dialect/);
  });
});

describe('sink.db.sql', () => {
  it('inserts with quoted names and bound values, all-or-nothing by default', async () => {
    const session = new RecordingSession();
    const { open, opened } = runner(session);

    await new SqlSinkPipe(open).write(
      batchOf([{ id: 1, name: "O'Brien" }, { id: 2, name: null }]),
      context('sink.db.sql', 'sink', { table: 'app.customers' }, saved('postgres')),
    );

    expect(session.queries).toEqual([
      {
        sql: 'INSERT INTO "app"."customers" ("id", "name") VALUES ($1, $2), ($3, $4)',
        params: [1, "O'Brien", 2, null],
      },
    ]);
    expect(session.transactions).toBe(1);
    expect(opened[0]!.dedicated).toBe(true);
  });

  it('keeps a SQL Server statement under its 1,000-row VALUES limit', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);
    const records = Array.from({ length: 2_500 }, (_, i) => ({ id: i }));

    await new SqlSinkPipe(open).write(
      batchOf(records),
      context('sink.db.sql', 'sink', { table: 'events' }, saved('sqlserver')),
    );

    expect(session.queries.map((q) => q.params.length)).toEqual([1_000, 1_000, 500]);
    expect(session.queries[0]!.sql).toMatch(/^INSERT INTO \[events\] \(\[id\]\) VALUES \(@p0\), \(@p1\)/);
    expect(session.transactions).toBe(1);
  });

  it('writes Oracle one row per statement, which has no multi-row VALUES', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);

    await new SqlSinkPipe(open).write(
      batchOf([{ id: 1 }, { id: 2 }]),
      context('sink.db.sql', 'sink', { table: 'events' }, saved('oracle')),
    );

    expect(session.queries).toEqual([
      { sql: 'INSERT INTO "events" ("id") VALUES (:1)', params: [1] },
      { sql: 'INSERT INTO "events" ("id") VALUES (:1)', params: [2] },
    ]);
  });

  it('runs a statement per record with the record’s fields bound', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);

    await new SqlSinkPipe(open).write(
      batchOf([{ id: 1, total: 9.5 }]),
      context(
        'sink.db.sql',
        'sink',
        { mode: 'statement', sql: 'UPDATE orders SET total = {{record.total}} WHERE id = {{record.id}}' },
        saved('mysql'),
      ),
    );

    expect(session.queries).toEqual([{ sql: 'UPDATE orders SET total = ? WHERE id = ?', params: [9.5, 1] }]);
  });

  it('closes the session when a write fails, and reports the statement’s error', async () => {
    const session = new RecordingSession(() => [], /INSERT/);
    const { open } = runner(session);

    await expect(
      new SqlSinkPipe(open).write(
        batchOf([{ id: 1 }]),
        context('sink.db.sql', 'sink', { table: 'events' }, saved('postgres')),
      ),
    ).rejects.toThrow('statement failed');
    expect(session.closed).toBe(true);
  });

  it('uses the pool and no transaction when transaction is off', async () => {
    const session = new RecordingSession();
    const { open, opened } = runner(session);

    await new SqlSinkPipe(open).write(
      batchOf([{ id: 1 }]),
      context('sink.db.sql', 'sink', { table: 'events', transaction: false }, saved('postgres')),
    );

    expect(session.transactions).toBe(0);
    expect(opened[0]!.dedicated).toBe(false);
  });

  it('rejects an insert with no table, and a statement with no sql', () => {
    const sink = new SqlSinkPipe();
    expect(() => sink.validateConfig({ mode: 'insert' })).toThrow(/table/);
    expect(() => sink.validateConfig({ mode: 'statement' })).toThrow(/sql/);
  });

  it('infers auto-increment id and real types safely for auto-created tables', () => {
    const sqliteDdl = sqliteCreateTableSql(
      [{ city: 'Tokyo', temp_c: 11, population: 9733276 }],
      'wf_enriched_cities',
      [],
    );
    expect(sqliteDdl.create).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sqliteDdl.create).toContain('"temp_c" INTEGER');

    const sqliteWithIdDdl = sqliteCreateTableSql(
      [{ id: 101, customer: 'Alice', amount: 49.5 }],
      'workflow_orders',
      [],
    );
    expect(sqliteWithIdDdl.create).not.toContain('AUTOINCREMENT');
    expect(sqliteWithIdDdl.create).toContain('"id" INTEGER PRIMARY KEY');
    expect(sqliteWithIdDdl.create).toContain('"amount" REAL');

    // Postgres uses NUMERIC for non-id numeric measurements so an integer first
    // batch (temp_c: 11) never causes decimal batches (11.7) to fail.
    const pgDdl = postgresCreateTableSql(
      [{ city: 'Tokyo', population: 9733276, temp_c: 11, wind_kmh: 3 }],
      'wf_enriched_cities',
      [],
    );
    expect(pgDdl.create).toContain('"id" SERIAL PRIMARY KEY');
    expect(pgDdl.create).toContain('"temp_c" NUMERIC');
    expect(pgDdl.create).toContain('"wind_kmh" NUMERIC');
    expect(pgDdl.create).toContain('"population" NUMERIC');

    const pgWithIdDdl = postgresCreateTableSql(
      [{ id: 101, amount: 49 }],
      'workflow_orders',
      [],
    );
    expect(pgWithIdDdl.create).toContain('"id" BIGINT PRIMARY KEY');
    expect(pgWithIdDdl.create).toContain('"amount" NUMERIC');
  });

  it('turns an insert into an upsert on the key it is given', () => {
    expect(
      upsertSql(
        'INSERT INTO "workflow_orders" ("id", "customer", "amount") VALUES ($1, $2, $3)',
        ['id', 'customer', 'amount'],
        'id',
        'postgres',
      ),
    ).toBe(
      'INSERT INTO "workflow_orders" AS target ("id", "customer", "amount") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "customer" = excluded."customer", "amount" = excluded."amount"',
    );
    expect(upsertSql('INSERT INTO "ids" ("id") VALUES (?)', ['id'], 'id', 'sqlite')).toBe(
      'INSERT INTO "ids" AS target ("id") VALUES (?) ON CONFLICT ("id") DO NOTHING',
    );
    expect(() => upsertSql('INSERT INTO t (a) VALUES (?)', ['a'], 'id', 'sqlite')).toThrow(/not one of the columns/);
    expect(() => upsertSql('INSERT INTO t (id) VALUES (?)', ['id'], 'id', 'mysql')).toThrow(/PostgreSQL and SQLite/);
  });

  it('serializes concurrent Postgres auto-table DDL and uses an advisory transaction lock', async () => {
    let activeSessions = 0;
    let maxConcurrentSessions = 0;
    const queries: Array<{ sql: string; params: unknown[] }> = [];

    const open: SqlRunner = async (_connection, options) => {
      expect(options.dedicated).toBe(true);
      return {
        async query(sql, params) {
          queries.push({ sql, params: [...params] });
          await Promise.resolve();
          return [];
        },
        async transaction(work) {
          activeSessions += 1;
          maxConcurrentSessions = Math.max(maxConcurrentSessions, activeSessions);
          try {
            return await work();
          } finally {
            activeSessions -= 1;
          }
        },
        async close() {},
      };
    };

    const connection: SqlConnection = {
      dialect: 'postgres',
      option: { host: '127.0.0.1', port: 5432, database: 'foxdb' },
    };

    await Promise.all([
      ensureAutoTable(open, connection, 'wf_etl_reconciled_ledger', [{ account_id: 'ACC-1' }], []),
      ensureAutoTable(open, connection, 'wf_etl_reconciled_ledger', [{ account_id: 'ACC-2' }], []),
    ]);

    expect(maxConcurrentSessions).toBe(1);
    expect(queries.filter((q) => q.sql.includes('pg_advisory_xact_lock'))).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['public.wf_etl_reconciled_ledger'] },
      { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['public.wf_etl_reconciled_ledger'] },
    ]);
  });
});

describe('a Postgres step without a credential', () => {
  it('uses the development database when nothing is set', () => {
    expect(credentiallessPostgresOption({})).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      user: 'foxuser',
      database: 'foxdb',
    });
  });

  it('refuses the development defaults in production', () => {
    expect(() => credentiallessPostgresOption({ NODE_ENV: 'production' })).toThrow(
      /no database credential.*POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD/,
    );
    expect(() =>
      credentiallessPostgresOption({ NODE_ENV: 'production', POSTGRES_HOST: 'db', POSTGRES_USER: 'app' }),
    ).toThrow(/set POSTGRES_PASSWORD on the server/);
  });

  it('connects in production when the operator names the database', () => {
    const option = credentiallessPostgresOption({
      NODE_ENV: 'production',
      POSTGRES_HOST: 'db.internal',
      POSTGRES_USER: 'app',
      POSTGRES_PASSWORD: 'p@ss:word/1',
      POSTGRES_DB: 'flows',
    });
    expect(option).toMatchObject({ host: 'db.internal', user: 'app', database: 'flows' });
    // A password with URL characters must not break the connection string.
    expect(option.connectionString).toBe('postgresql://app:p%40ss%3Aword%2F1@db.internal:5432/flows');
  });
});

describe('upsertKey on an insert step', () => {
  it('leaves a plain insert alone when the step names no key', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);
    await new SqlSinkPipe(open).write(
      batchOf([{ id: 1, name: 'a' }]),
      context('sink.db.sql', 'sink', { table: 'customers' }, saved('postgres')),
    );
    expect(session.queries.map((q) => q.sql)).toEqual(['INSERT INTO "customers" ("id", "name") VALUES ($1, $2)']);
  });

  it('upserts on the named key, keeping the last record for a repeated key', async () => {
    const session = new RecordingSession();
    const { open } = runner(session);
    await new SqlSinkPipe(open).write(
      batchOf([
        { id: 1, name: 'first' },
        { id: 2, name: 'b' },
        { id: 1, name: 'last' },
      ]),
      context('sink.db.sql', 'sink', { table: 'customers', upsertKey: 'id' }, saved('postgres')),
    );
    expect(session.queries).toEqual([
      {
        sql: 'INSERT INTO "customers" AS target ("id", "name") VALUES ($1, $2), ($3, $4) ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name"',
        params: [1, 'last', 2, 'b'],
      },
    ]);
  });

  it('refuses a key on a statement step, or one that is not written', () => {
    const sink = new SqlSinkPipe();
    expect(() => sink.validateConfig({ mode: 'statement', sql: 'SELECT 1', upsertKey: 'id' })).toThrow(/insert and mapped modes only/);
    expect(() => sink.validateConfig({ table: 't', columns: ['name'], upsertKey: 'id' })).toThrow(/one of the columns/);
  });

  it('supports composite combination keys and excludes keys from update set', () => {
    const sql = 'INSERT INTO "tenant_users" ("tenant_id", "user_id", "name", "email") VALUES ($1, $2, $3, $4)';
    const result = upsertSql(sql, ['tenant_id', 'user_id', 'name', 'email'], ['tenant_id', 'user_id'], 'postgres');
    expect(result).toBe(
      'INSERT INTO "tenant_users" AS target ("tenant_id", "user_id", "name", "email") VALUES ($1, $2, $3, $4) ON CONFLICT ("tenant_id", "user_id") DO UPDATE SET "name" = excluded."name", "email" = excluded."email"',
    );
  });

  it('handles quoted table names with spaces correctly in upsertSql', () => {
    const sql = 'INSERT INTO "sales orders" ("order_id", "total") VALUES (?, ?)';
    const result = upsertSql(sql, ['order_id', 'total'], 'order_id', 'sqlite');
    expect(result).toBe(
      'INSERT INTO "sales orders" AS target ("order_id", "total") VALUES (?, ?) ON CONFLICT ("order_id") DO UPDATE SET "total" = excluded."total"',
    );
  });

  it('parses comma-separated string in resolveUpsertKeys', () => {
    expect(resolveUpsertKeys({ upsertKey: 'tenant_id, user_id' })).toEqual(['tenant_id', 'user_id']);
  });

  it('preserves native Date, Buffer, and BigInt for non-transformed columns while sandboxing transformed columns', async () => {
    const now = new Date('2026-11-20T00:00:00Z');
    const buf = Buffer.from('hello bytea');
    const big = BigInt(9007199254740993);

    const mapped = await applyColumnMapping(
      [
        {
          createdAt: now,
          binaryData: buf,
          bigNumber: big,
          rawCode: '  abc  ',
        },
      ],
      [
        { targetColumn: 'created_at', sourcePath: 'createdAt' },
        { targetColumn: 'binary_data', sourcePath: 'binaryData' },
        { targetColumn: 'big_number', sourcePath: 'bigNumber' },
        { targetColumn: 'code', sourcePath: 'rawCode', transform: 'value.trim().toUpperCase()' },
      ],
      { timeoutMs: 1000 },
    );

    expect(mapped[0]?.code).toBe('ABC');
    expect(mapped[0]?.created_at).toBe(now); // exact object identity preserved
    expect(mapped[0]?.binary_data).toBe(buf); // exact Buffer preserved
    expect(mapped[0]?.big_number).toBe(big); // BigInt preserved without throwing
  });

  it('rejects non-Postgres/non-SQLite connections when upsertKeys is configured', async () => {
    const open: SqlRunner = async () => ({
      query: async () => [],
      transaction: async (work) => work(),
      close: async () => undefined,
    });
    const sink = new SqlSinkPipe(open);
    await expect(
      sink.write(
        batchOf([{ id: 1, name: 'test' }]),
        context('sink.db.sql', 'sink', { table: 'users', upsertKey: 'id' }, saved('mysql')),
      ),
    ).rejects.toThrow(/upsertKey is supported on PostgreSQL and SQLite only, but connection uses mysql/);
  });

  it('appends upsertCondition to WHERE clause when updating', () => {
    const sql = 'INSERT INTO "tenant_users" ("tenant_id", "user_id", "name") VALUES ($1, $2, $3)';
    const result = upsertSql(
      sql,
      ['tenant_id', 'user_id', 'name'],
      ['tenant_id', 'user_id'],
      'postgres',
      'EXCLUDED.updated_at >= target.updated_at',
    );
    expect(result).toBe(
      'INSERT INTO "tenant_users" AS target ("tenant_id", "user_id", "name") VALUES ($1, $2, $3) ON CONFLICT ("tenant_id", "user_id") DO UPDATE SET "name" = excluded."name" WHERE EXCLUDED.updated_at >= target.updated_at',
    );
  });

  it('maps nested dot-paths and applies transform expressions and default fallbacks', async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const open: SqlRunner = async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return [];
      },
      transaction: async (work) => work(),
      close: async () => undefined,
    });

    const sink = new SqlSinkPipe(open);
    await sink.write(
      {
        id: 'b1',
        partitionId: '0',
        records: [
          {
            user: { tenant_code: 'T-100', user_id: 'U-1', full_name: ' Bob ' },
            billing: { balance_cents: 25000 },
          },
          {
            user: { tenant_code: 'T-100', user_id: 'U-2', full_name: 'Carol' },
            billing: {}, // balance_cents missing -> fallback used
          },
        ],
      },
      {
        workflowRunId: 'r',
        pipelineId: 'p',
        pipe: {
          id: 'map-sink',
          type: 'sink.db.sql',
          role: 'sink',
          config: {
            dialect: 'postgres',
            mode: 'mapped',
            table: 'tenant_users',
            upsertKeys: ['tenant_id', 'user_id'],
            columnMapping: [
              { targetColumn: 'tenant_id', sourcePath: 'user.tenant_code' },
              { targetColumn: 'user_id', sourcePath: 'user.user_id' },
              { targetColumn: 'name', sourcePath: 'user.full_name', expression: 'value.trim()' },
              { targetColumn: 'balance_usd', sourcePath: 'billing.balance_cents', expression: 'value / 100', defaultValue: 0 },
            ],
          },
          concurrency: 1,
        },
        credentials: { revealSecret: async () => undefined } as unknown as CredentialStore,
      },
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toBe(
      'INSERT INTO "tenant_users" AS target ("tenant_id", "user_id", "name", "balance_usd") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8) ON CONFLICT ("tenant_id", "user_id") DO UPDATE SET "name" = excluded."name", "balance_usd" = excluded."balance_usd"',
    );
    expect(queries[0]!.params).toEqual(['T-100', 'U-1', 'Bob', 250, 'T-100', 'U-2', 'Carol', 0]);
  });

  it('executes MappedDbSinkPipe with composite combination keys and condition on SQLite', async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const open: SqlRunner = async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return [];
      },
      transaction: async (work) => work(),
      close: async () => undefined,
    });

    const sink = new MappedDbSinkPipe(open);
    await sink.write(
      {
        id: 'b1',
        partitionId: '0',
        records: [
          {
            org: { tenant_code: 'T-100' },
            user: { sub: 'U-1', full_name: ' Alice Vance ', email: 'alice@alpha.example' },
            billing: { balance_cents: 12500 },
            metadata: { last_modified: 1730000000, status: 'active' },
          },
        ],
      },
      {
        workflowRunId: 'r',
        pipelineId: 'p',
        pipe: {
          id: 'mapped-sink',
          type: 'sink.db.mapped-insert',
          role: 'sink',
          config: {
            dialect: 'sqlite',
            mode: 'mapped',
            table: 'wf_tenant_users',
            upsertKeys: ['tenant_id', 'user_id'],
            upsertCondition: 'EXCLUDED.updated_at >= target.updated_at',
            columnMapping: [
              { targetColumn: 'tenant_id', sourcePath: 'org.tenant_code', isKey: true },
              { targetColumn: 'user_id', sourcePath: 'user.sub', isKey: true },
              { targetColumn: 'full_name', sourcePath: 'user.full_name', transform: 'value.trim()' },
              { targetColumn: 'email', sourcePath: 'user.email' },
              { targetColumn: 'balance_usd', sourcePath: 'billing.balance_cents', expression: 'value / 100', defaultValue: 0 },
              { targetColumn: 'status', sourcePath: 'metadata.status', defaultValue: 'pending' },
              { targetColumn: 'updated_at', sourcePath: 'metadata.last_modified' },
            ],
          },
          concurrency: 1,
        },
        credentials: { revealSecret: async () => undefined } as unknown as CredentialStore,
      },
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toBe(
      'INSERT INTO "wf_tenant_users" AS target ("tenant_id", "user_id", "full_name", "email", "balance_usd", "status", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT ("tenant_id", "user_id") DO UPDATE SET "full_name" = excluded."full_name", "email" = excluded."email", "balance_usd" = excluded."balance_usd", "status" = excluded."status", "updated_at" = excluded."updated_at" WHERE EXCLUDED.updated_at >= target.updated_at',
    );
    expect(queries[0]!.params).toEqual(['T-100', 'U-1', 'Alice Vance', 'alice@alpha.example', 125, 'active', 1730000000]);
  });

  it('fails with clear error when a transform expression cannot be evaluated', async () => {
    const sink = new MappedDbSinkPipe();
    await expect(
      sink.write(
        { id: 'b1', partitionId: '0', records: [{ amount: 'not_a_number' }] },
        {
          workflowRunId: 'r',
          pipelineId: 'p',
          pipe: {
            id: 'err-pipe',
            type: 'sink.db.mapped-insert',
            role: 'sink',
            config: {
              dialect: 'sqlite',
              table: 'users',
              columnMapping: [
                { targetColumn: 'total', sourcePath: 'amount', expression: 'value.invalidMethod()' },
              ],
            },
            concurrency: 1,
          },
          credentials: { revealSecret: async () => undefined } as unknown as CredentialStore,
        },
      ),
    ).rejects.toThrow(/Failed to evaluate transform expression/);
  });

  it('rejects unsupported dialects when upsertKey is set', () => {
    const sink = new SqlSinkPipe();
    expect(() =>
      sink.validateConfig({
        table: 'users',
        columns: ['id'],
        upsertKey: 'id',
        dialect: 'mysql',
      }),
    ).toThrow(/PostgreSQL and SQLite only/);
  });

  it('rejects mapped mode when columnMapping is empty or missing', () => {
    const sink = new MappedDbSinkPipe();
    expect(() =>
      sink.validateConfig({
        table: 'users',
        columnMapping: [],
      }),
    ).toThrow(/at least one columnMapping/);
  });
});

describe('SQLite sandbox safety in SQL pipes', () => {
  it('runs :memory: queries using built-in node:sqlite without native addons', async () => {
    const batches = await collect(
      new SqlSourcePipe(),
      {
        workflowRunId: 'run-mem',
        pipelineId: 'p',
        pipe: {
          id: 'mem-sql',
          type: 'source.db.sql',
          role: 'source',
          config: { dialect: 'sqlite', sql: 'SELECT 42 AS answer' },
          concurrency: 1,
        },
        credentials: {
          revealSecret: async () => undefined,
        } as unknown as CredentialStore,
      },
    );
    expect(batches[0]?.records).toEqual([{ answer: 42 }]);
  });

  it('refuses opening FoxSchema or engine internal SQLite databases', async () => {
    for (const target of [
      '/data/foxschema.db',
      '/data/foxschema.db-wal',
      '/data/.app_encryption_key',
      'file:///data/foxschema.db?mode=ro',
      '/tmp/workflow-engine.sqlite',
    ]) {
      await expect(
        collect(
          new SqlSourcePipe(),
          context(
            'source.db.sql',
            'source',
            { dialect: 'sqlite', sql: 'SELECT 1' },
            { dialect: 'sqlite', option: { database: target } },
          ),
        ),
      ).rejects.toThrow(/Refusing to open FoxSchema internal database/);
    }
  });

  it('refuses ATTACH, VACUUM INTO, and load_extension on :memory: SQLite sessions', async () => {
    for (const sql of [
      "ATTACH DATABASE '/data/foxschema.db' AS meta",
      "VACUUM INTO '/tmp/escape.sqlite'",
      "SELECT load_extension('/tmp/evil.so')",
    ]) {
      await expect(
        collect(
          new SqlSourcePipe(),
          context(
            'source.db.sql',
            'source',
            { dialect: 'sqlite', sql },
            { dialect: 'sqlite', option: { database: ':memory:' } },
          ),
        ),
      ).rejects.toThrow(/disabled for security|not authorized/i);
    }
  });
});

describe('SQLite steps without a credential', () => {
  /** A step of `runId` on the in-memory database a credential-less SQLite step uses. */
  function memoryStep(
    type: 'source.db.sql' | 'sink.db.sql',
    config: Record<string, unknown>,
    runId: string,
    pipelineId = 'pipeline',
  ): PipeContext {
    return {
      workflowRunId: runId,
      pipelineId,
      pipe: {
        id: type === 'sink.db.sql' ? 'write' : 'read',
        type,
        role: type === 'sink.db.sql' ? 'sink' : 'source',
        config: { dialect: 'sqlite', ...config },
        concurrency: 1,
      },
    };
  }
  const read = (sql: string, runId: string, pipelineId?: string) =>
    collect(new SqlSourcePipe(), memoryStep('source.db.sql', { sql }, runId, pipelineId));
  const rowsOf = (batches: RecordBatch[]) => batches.flatMap((batch) => batch.records);

  it('share one database across the steps and pipelines of a run', async () => {
    const sink = new SqlSinkPipe();
    await sink.write(
      batchOf([{ id: 1, item: 'kayak' }, { id: 2, item: 'paddle' }]),
      memoryStep('sink.db.sql', { mode: 'insert', table: 'orders' }, 'run-shared', 'load'),
    );
    await read("UPDATE orders SET item = 'canoe' WHERE id = 1", 'run-shared', 'load');

    expect(rowsOf(await read('SELECT id, item FROM orders ORDER BY id', 'run-shared', 'report'))).toEqual([
      { id: 1, item: 'canoe' },
      { id: 2, item: 'paddle' },
    ]);
    await releaseRunMemoryDatabase('run-shared');
  });

  it('give each run its own database, closed when the run is over', async () => {
    const before = openRunMemoryDatabases();
    await read('CREATE TABLE notes (body TEXT)', 'run-a');
    await expect(read('SELECT body FROM notes', 'run-b')).rejects.toThrow(/no such table: notes/);
    expect(openRunMemoryDatabases()).toBe(before + 2);

    await new SqlSourcePipe().finishRun('run-a');
    await new SqlSinkPipe().finishRun('run-b');
    expect(openRunMemoryDatabases()).toBe(before);
    // A run id that comes back starts from nothing.
    await expect(read('SELECT body FROM notes', 'run-a')).rejects.toThrow(/no such table: notes/);
    await releaseRunMemoryDatabase('run-a');
  });

  it('keep concurrent transactions of one run out of each other', async () => {
    const sink = new SqlSinkPipe();
    const write = (id: number) =>
      sink.write(
        batchOf([{ id, item: `item-${id}` }]),
        memoryStep('sink.db.sql', { mode: 'insert', table: 'lines', transaction: true }, 'run-concurrent'),
      );
    await write(0);
    await Promise.all([1, 2, 3, 4].map(write));

    expect(rowsOf(await read('SELECT COUNT(*) AS n FROM lines', 'run-concurrent'))).toEqual([{ n: 5 }]);
    await releaseRunMemoryDatabase('run-concurrent');
  });

  it('keep the sandbox protections on the shared database', async () => {
    for (const sql of [
      "ATTACH DATABASE '/data/foxschema.db' AS meta",
      "VACUUM INTO '/tmp/escape.sqlite'",
      "SELECT load_extension('/tmp/evil.so')",
      'PRAGMA writable_schema = ON',
    ]) {
      await expect(read(sql, 'run-hardened')).rejects.toThrow(/disabled for security|not authorized/i);
    }
    await releaseRunMemoryDatabase('run-hardened');
  });
});

describe('all-dialects SQL pipes and DBA transform pipeline', () => {
  const ALL_SQL_DIALECTS: ReadonlyArray<{
    dialect: string;
    expectedFirstParam: string;
    expectedQuotedTable: string;
  }> = [
    { dialect: 'postgres', expectedFirstParam: '$1', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'cockroachdb', expectedFirstParam: '$1', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'yugabytedb', expectedFirstParam: '$1', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'redshift', expectedFirstParam: '$1', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'mysql', expectedFirstParam: '?', expectedQuotedTable: '`app`.`audit_log`' },
    { dialect: 'mariadb', expectedFirstParam: '?', expectedQuotedTable: '`app`.`audit_log`' },
    { dialect: 'tidb', expectedFirstParam: '?', expectedQuotedTable: '`app`.`audit_log`' },
    { dialect: 'sqlite', expectedFirstParam: '?', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'duckdb', expectedFirstParam: '?', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'db2', expectedFirstParam: '?', expectedQuotedTable: '"app"."audit_log"' },
    { dialect: 'clickhouse', expectedFirstParam: '$1', expectedQuotedTable: '`app`.`audit_log`' },
    { dialect: 'sqlserver', expectedFirstParam: '@p0', expectedQuotedTable: '[app].[audit_log]' },
    { dialect: 'azuresql', expectedFirstParam: '@p0', expectedQuotedTable: '[app].[audit_log]' },
    { dialect: 'oracle', expectedFirstParam: ':1', expectedQuotedTable: '"app"."audit_log"' },
  ];

  it.each(ALL_SQL_DIALECTS)(
    'executes source.db.sql -> transform.dedupe -> transform.redact -> transform.aggregate -> sink.db.sql on $dialect',
    async ({ dialect, expectedFirstParam, expectedQuotedTable }) => {
      const rawRows = [
        { customer_id: 'C1', region: 'US', email: 'alice@acme.example', tax_id: 'SSN-999-1234', amount: 100 },
        { customer_id: 'C2', region: 'EU', email: 'bob@eu.example', tax_id: 'VAT-888-5678', amount: 50 },
        { customer_id: 'C1', region: 'US', email: 'alice@acme.example', tax_id: 'SSN-999-1234', amount: 140 },
        { customer_id: 'C3', region: 'US', email: 'carol@us.example', tax_id: 'SSN-777-4321', amount: 60 },
      ];
      const sourceSession = new RecordingSession(() => rawRows);
      const { open: openSource } = runner(sourceSession);

      // 1. Read from dialect with bound variable
      const sourceBatches = await collect(
        new SqlSourcePipe(openSource),
        context(
          'source.db.sql',
          'source',
          { sql: 'SELECT * FROM raw_events WHERE tenant = {{vars.tenant}}' },
          saved(dialect),
          { variables: { tenant: 'acme' } },
        ),
      );
      expect(sourceSession.queries[0]!.sql).toContain(`WHERE tenant = ${expectedFirstParam}`);
      expect(sourceSession.queries[0]!.params).toEqual(['acme']);
      expect(sourceBatches).toHaveLength(1);

      // 2. Deduplicate by customer_id (keep last)
      const dedupePipe = new DedupePipe();
      const dedupedPorts = await dedupePipe.transform(sourceBatches[0]!, {
        workflowRunId: 'run',
        pipelineId: 'main',
        pipe: {
          id: 'dedupe',
          type: 'transform.dedupe',
          role: 'transform',
          config: { keys: ['customer_id'], keep: 'last' },
          concurrency: 1,
        },
      });
      const uniqueBatch = dedupedPorts.get('out')!;
      const dupBatch = dedupedPorts.get('rejects')!;
      expect(uniqueBatch.records).toHaveLength(3);
      expect(dupBatch.records).toHaveLength(1);
      expect(dupBatch.records[0]!.amount).toBe(100);

      // 3. Redact PII (mask email & hash tax_id)
      const redactMask = new RedactPipe();
      const maskedBatch = await redactMask.transform(uniqueBatch, {
        workflowRunId: 'run',
        pipelineId: 'main',
        pipe: {
          id: 'redact_mask',
          type: 'transform.redact',
          role: 'transform',
          config: { fields: ['email'], strategy: 'mask' },
          concurrency: 1,
        },
      });
      expect(maskedBatch.records[0]!.email).toBe('b***@eu.example');

      const redactHash = new RedactPipe();
      const sanitizedBatch = await redactHash.transform(maskedBatch, {
        workflowRunId: 'run',
        pipelineId: 'main',
        pipe: {
          id: 'redact_hash',
          type: 'transform.redact',
          role: 'transform',
          config: { fields: ['tax_id'], strategy: 'hash' },
          concurrency: 1,
        },
      });
      expect(String(sanitizedBatch.records[0]!.tax_id)).toMatch(/^sha256:[0-9a-f]{16}$/);

      // 4. Aggregate by region
      const aggPipe = new AggregatePipe();
      const aggBatch = await aggPipe.transform(sanitizedBatch, {
        workflowRunId: 'run',
        pipelineId: 'main',
        pipe: {
          id: 'agg',
          type: 'transform.aggregate',
          role: 'transform',
          config: {
            groupBy: ['region'],
            metrics: [
              { fn: 'count', as: 'customers' },
              { fn: 'sum', field: 'amount', as: 'total_amount' },
              { fn: 'max', field: 'amount', as: 'max_amount' },
            ],
          },
          concurrency: 1,
        },
      });
      expect(aggBatch.records).toEqual([
        { region: 'EU', customers: 1, total_amount: 50, max_amount: 50 },
        { region: 'US', customers: 2, total_amount: 200, max_amount: 140 },
      ]);

      // 5. Write aggregated metrics into dialect sink
      const sinkSession = new RecordingSession();
      const { open: openSink } = runner(sinkSession);
      await new SqlSinkPipe(openSink).write(
        aggBatch,
        context(
          'sink.db.sql',
          'sink',
          { mode: 'insert', table: 'app.audit_log', columns: ['region', 'customers', 'total_amount'] },
          saved(dialect),
        ),
      );
      expect(sinkSession.queries[0]!.sql).toContain(`INSERT INTO ${expectedQuotedTable}`);
      expect(sinkSession.queries[0]!.sql).toContain(expectedFirstParam);
    },
  );
});
