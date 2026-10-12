/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /data-migrate/execute classifies each op as the target's database
 * reads it, so a row op cannot carry a second statement that only the
 * database sees.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeReply, routeHandler } from '../../platform/http/route-doubles';
import { createDataMigrateRoutes } from './data-migrate.routes';
import { executeDataMigrateOps } from './data-migrate-execute';

vi.mock('./data-migrate-execute', () => ({ executeDataMigrateOps: vi.fn(async () => ({ results: [] })) }));

describe('POST /data-migrate/execute', () => {
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
});
