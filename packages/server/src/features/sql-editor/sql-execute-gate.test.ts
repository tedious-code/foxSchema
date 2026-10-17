/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /sql/execute prices each statement as the connection's database reads
 * it. The same text can be a read on one engine and a write on another, so
 * the gate classifies only once the connection, and its dialect, is known.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '@foxschema/shared';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { createEditorRoutes } from './editor.routes';
import { runStatements } from './sql-execute.service';

vi.mock('./sql-execute.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sql-execute.service')>()),
  runStatements: vi.fn(async () => []),
}));

async function execute(dialect: string, permissions: Permission[], body: Record<string, unknown>) {
  vi.mocked(runStatements).mockClear();
  const handler = routeHandler(
    createEditorRoutes({
      resolveRef: vi.fn().mockResolvedValue({ dialect, option: {}, schema: undefined }),
      MAX_STATEMENTS: 10,
      MAX_STATEMENT_LENGTH: 10_000,
      isRunnableStatement: () => true,
    }),
    'POST',
    '/sql/execute'
  );
  const { reply, sent } = fakeReply();
  await handler(
    { body: { connectionId: 'c1', ...body }, userId: 'u1', appRole: 'member', permissions: new Set(permissions) } as never,
    reply as never
  );
  return { sent, ran: vi.mocked(runStatements).mock.calls.length > 0 };
}

describe('POST /sql/execute reads statements in the connection dialect', () => {
  it('prices the same text by the database that will run it', async () => {
    // `#` starts a comment in MySQL and is an operator in PostgreSQL, where
    // this is SELECT … INTO, which creates a table.
    const statements = ['SELECT 1 # 2 INTO t'];

    const mysql = await execute('mysql', ['editor.run'], { statements });
    expect(mysql.ran).toBe(true);

    const postgres = await execute('postgres', ['editor.run'], { statements });
    expect(postgres.sent.status).toBe(403);
    expect(postgres.sent.body.missing).toContain('editor.ddl');
    expect(postgres.ran).toBe(false);
  });

  it('refuses a grid write that its database splits into two statements', async () => {
    // A backslash is a plain character in a PostgreSQL string, so the quote
    // closes after it and the DELETE is a statement of its own.
    const { sent, ran } = await execute('postgres', ['editor.run', 'editor.dml', 'editor.datagrid.insert'], {
      datagridAction: 'insert',
      statements: ["INSERT INTO t VALUES ('a\\'); DELETE FROM users; --')"],
    });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/single statement/);
    expect(ran).toBe(false);
  });
});

describe('POST /sql/execute reads a code fence as the database does', () => {
  // The editor runs `-- @node` … `-- @end` cells itself and never posts one
  // here. To the database the fence lines are `--` comments, so whatever sits
  // between them runs as SQL.
  it('prices the SQL inside a closed fence', async () => {
    const { sent, ran } = await execute('postgres', ['editor.run'], {
      statements: ['-- @node\nDROP TABLE t\n-- @end'],
    });
    expect(sent.status).toBe(403);
    expect(sent.body.missing).toContain('editor.ddl');
    expect(ran).toBe(false);
  });

  it('keeps a fence line inside a string literal part of the string', async () => {
    // The database runs `SELECT '<…>'; DROP TABLE users;` and then a comment.
    const { sent, ran } = await execute('postgres', ['editor.run'], {
      statements: ["SELECT 'a\n-- @node\nSELECT '; DROP TABLE users; --'\n-- @end"],
    });
    expect(sent.status).toBe(403);
    expect(sent.body.missing).toContain('editor.ddl');
    expect(ran).toBe(false);
  });

  it('refuses a grid write that hides a second statement in a fence', async () => {
    // Reads as a DELETE by its verb; the UPDATE needs editor.datagrid.update.
    const { sent, ran } = await execute('postgres', ['editor.run', 'editor.dml', 'editor.datagrid.delete'], {
      datagridAction: 'delete',
      statements: ['/* x */\n-- @node\nDELETE FROM a WHERE id = 1;\nUPDATE b SET x = 1;\n-- @end'],
    });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/single statement/);
    expect(ran).toBe(false);
  });
});

describe('POST /sql/execute stopOnError and transaction', () => {
  // 0 dialect, 1 option, 2 statements, 3 maxRows, 4 schema, 5 offset,
  // 6 params, 7 seek, 8 stopOnError, 9 transaction.
  const flags = () => {
    const call = vi.mocked(runStatements).mock.calls[0]!;
    return { stopOnError: call[8], transaction: call[9] };
  };

  it('passes each flag only when it is boolean true', async () => {
    await execute('postgres', ['editor.run'], { statements: ['SELECT 1'], stopOnError: true, transaction: true });
    expect(flags()).toEqual({ stopOnError: true, transaction: true });
    await execute('postgres', ['editor.run'], { statements: ['SELECT 1'] });
    expect(flags()).toEqual({ stopOnError: false, transaction: false });
    await execute('postgres', ['editor.run'], { statements: ['SELECT 1'], stopOnError: 'yes', transaction: 'yes' });
    expect(flags()).toEqual({ stopOnError: false, transaction: false });
  });
});

describe('POST /sql/execute as one transaction', () => {
  // A COMMIT inside the batch made what came before it permanent; a later
  // failure then rolled back nothing, and the editor reported a rollback.
  it.each(['COMMIT', 'BEGIN', 'ROLLBACK;', 'START TRANSACTION', 'END'])(
    'refuses a batch that runs %s itself, before touching the database',
    async (control) => {
      const { sent, ran } = await execute('postgres', ['editor.run', 'editor.dml', 'editor.ddl'], {
        statements: ['INSERT INTO t VALUES (1)', control, 'INSERT INTO t VALUES (2)'],
        transaction: true,
      });
      expect(sent.status).toBe(400);
      expect(sent.body.error).toMatch(/One transaction/);
      expect(ran).toBe(false);
    },
  );

  it.each([
    ['clickhouse', 'ClickHouse'],
    ['redis', 'Redis'],
    ['mongodb', 'MongoDB'],
  ])('refuses one transaction on %s, which has nothing to roll back', async (dialect, label) => {
    // Its adapter opens no transaction: each statement commits as it runs,
    // so a failure leaves the earlier ones while the editor said rolled back.
    const { sent, ran } = await execute(dialect, ['editor.run', 'editor.dml', 'editor.ddl'], {
      statements: ['SELECT 1', 'SELECT 2'],
      transaction: true,
    });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toContain(`${label} has no transactions`);
    expect(ran).toBe(false);

    const plain = await execute(dialect, ['editor.run', 'editor.dml', 'editor.ddl'], {
      statements: ['SELECT 1', 'SELECT 2'],
    });
    expect(plain.ran).toBe(true);
  });

  it('runs the same batch statement by statement when not asked for one transaction', async () => {
    const { ran } = await execute('postgres', ['editor.run', 'editor.dml', 'editor.ddl'], {
      statements: ['INSERT INTO t VALUES (1)', 'COMMIT', 'INSERT INTO t VALUES (2)'],
    });
    expect(ran).toBe(true);
  });

  it('keeps savepoints, which stay inside the transaction', async () => {
    const { ran } = await execute('postgres', ['editor.run', 'editor.dml', 'editor.ddl'], {
      statements: ['SAVEPOINT s1', 'INSERT INTO t VALUES (1)', 'ROLLBACK TO SAVEPOINT s1'],
      transaction: true,
    });
    expect(ran).toBe(true);
  });
});
