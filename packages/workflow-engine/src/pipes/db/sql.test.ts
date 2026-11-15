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
  credentiallessPostgresOption,
  SqlSinkPipe,
  SqlSourcePipe,
  ensureAutoTable,
  postgresCreateTableSql,
  postgresUpsertSql,
  sqliteCreateTableSql,
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

    expect(opened[0]!.connection).toEqual({ dialect: 'mysql', option: { host: 'db', password: 'pw' } });
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

  it('adds idempotent ON CONFLICT upsert clause for PostgreSQL inserts carrying id', () => {
    expect(
      postgresUpsertSql(
        'INSERT INTO "workflow_orders" ("id", "customer", "amount") VALUES ($1, $2, $3)',
        ['id', 'customer', 'amount'],
      ),
    ).toBe(
      'INSERT INTO "workflow_orders" ("id", "customer", "amount") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "customer" = EXCLUDED."customer", "amount" = EXCLUDED."amount"',
    );
    expect(
      postgresUpsertSql('INSERT INTO "ids" ("id") VALUES ($1)', ['id']),
    ).toBe('INSERT INTO "ids" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING');
    expect(
      postgresUpsertSql(
        'INSERT INTO "events" ("name") VALUES ($1)',
        ['name'],
      ),
    ).toBe('INSERT INTO "events" ("name") VALUES ($1)');
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
