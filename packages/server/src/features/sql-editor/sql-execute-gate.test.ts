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
