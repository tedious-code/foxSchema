/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /data-migrate/execute classifies each op as the target's database
 * reads it, so a row op cannot carry a second statement that only the
 * database sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { createDataMigrateRoutes } from './data-migrate.routes';
import { executeDataMigrateOps } from './data-migrate-execute';

vi.mock('./data-migrate-execute', () => ({ executeDataMigrateOps: vi.fn(async () => ({ results: [] })) }));

describe('POST /data-migrate/execute', () => {
  beforeEach(() => vi.mocked(executeDataMigrateOps).mockClear());

  it('refuses an op that its database splits into two statements', async () => {
    const handler = routeHandler(
      createDataMigrateRoutes({
        resolveRef: vi.fn().mockResolvedValue({ dialect: 'postgres', option: {}, schema: 'public' }),
        dataMigrateHistory: {} as never,
      }),
      'POST',
      '/data-migrate/execute'
    );
    const { reply, sent } = fakeReply();
    // A backslash is a plain character in a PostgreSQL string: the quote
    // closes after it and the DELETE runs as a statement of its own.
    const op = { op: 'insert', key: 'k1', sql: "INSERT INTO t VALUES ('a\\'); DELETE FROM users; --')" };
    await handler({ body: { connectionId: 'c1', ops: [op] }, userId: 'u1', appRole: 'admin' } as never, reply as never);

    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/single statement/);
    expect(executeDataMigrateOps).not.toHaveBeenCalled();
  });

  it('counts the statements inside a code fence', async () => {
    const handler = routeHandler(
      createDataMigrateRoutes({
        resolveRef: vi.fn().mockResolvedValue({ dialect: 'postgres', option: {}, schema: 'public' }),
        dataMigrateHistory: {} as never,
      }),
      'POST',
      '/data-migrate/execute'
    );
    const { reply, sent } = fakeReply();
    // The fence lines are comments to the database, which runs both writes.
    // Its verb reads as a delete, so only the count stands between the UPDATE
    // and an op priced as a delete.
    const op = { op: 'delete', key: 'k1', sql: '/* x */\n-- @node\nDELETE FROM a WHERE id = 1;\nUPDATE b SET x = 1;\n-- @end' };
    await handler({ body: { connectionId: 'c1', ops: [op] }, userId: 'u1', appRole: 'admin' } as never, reply as never);

    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/single statement/);
    expect(executeDataMigrateOps).not.toHaveBeenCalled();
  });

  describe('Transaction on an engine with none', () => {
    const run = async (dialect: string, useTransaction: boolean | undefined) => {
      const handler = routeHandler(
        createDataMigrateRoutes({
          resolveRef: vi.fn().mockResolvedValue({ dialect, option: {}, schema: undefined }),
          dataMigrateHistory: {} as never,
        }),
        'POST',
        '/data-migrate/execute'
      );
      const { reply, sent } = fakeReply();
      const op = { op: 'insert', key: 'k1', sql: "INSERT INTO t (id, name) VALUES (1, 'a')" };
      const body = { connectionId: 'c1', ops: [op], continueOnError: false, useTransaction };
      await handler({ body, userId: 'u1', appRole: 'admin' } as never, reply as never);
      return sent;
    };

    it('refuses to promise a rollback Redis cannot give', async () => {
      // Its adapter's begin and rollback do nothing, so a mid-batch failure
      // left the earlier rows written under a "rolled back" Transaction.
      const sent = await run('redis', true);

      expect(sent.status).toBe(400);
      expect(sent.body.error).toMatch(/Redis cannot undo a write/);
      expect(sent.body.error).toMatch(/Turn Transaction off/);
      expect(executeDataMigrateOps).not.toHaveBeenCalled();
    });

    it('runs without one when the client does not ask', async () => {
      // The flag defaulted to on when omitted; on Redis that default is the
      // same false promise, so it follows the engine instead.
      const sent = await run('redis', undefined);

      expect(sent.status).not.toBe(400);
      expect(vi.mocked(executeDataMigrateOps).mock.calls[0]?.[4]).toMatchObject({ useTransaction: false });
    });

    it('still wraps the batch where the engine can roll it back', async () => {
      await run('postgres', true);
      expect(vi.mocked(executeDataMigrateOps).mock.calls[0]?.[4]).toMatchObject({ useTransaction: true });
    });
  });
});
