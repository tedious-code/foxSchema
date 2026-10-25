/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mongoDbAdapter } from './mongodb.adapter.js';

describe('mongodb adapter handle isolation', () => {
  afterEach(async () => {
    await mongoDbAdapter.closeAll();
    vi.restoreAllMocks();
  });

  it('setCurrentSchema does not poison the next acquire for the same credential', async () => {
    const connect = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const MongoClient = vi.fn(function (this: any) {
      this.connect = connect;
      this.close = close;
      this.db = vi.fn();
    });
    // Force the lazy loader to use our stub instead of the real driver.
    (mongoDbAdapter as any).mod = { MongoClient };

    const first = await mongoDbAdapter.acquire(
      'mongodb://localhost:27017',
      { database: 'prod' } as any,
      true
    );
    expect(first.database).toBe('prod');
    await mongoDbAdapter.setCurrentSchema(first, 'staging');
    expect(first.database).toBe('staging');

    const second = await mongoDbAdapter.acquire(
      'mongodb://localhost:27017',
      { database: 'prod' } as any,
      true
    );
    // Same pooled client, but the cached database name must still be prod.
    expect(second.database).toBe('prod');
    expect(second.client).toBe(first.client);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('mongodb adapter · paging', () => {
  /** A collection whose cursor records skip/limit, over `docs`. */
  function fakeConnection(docs: Record<string, unknown>[]) {
    const calls: string[] = [];
    const find = vi.fn(() => {
      let skip = 0;
      let limit = 0;
      const cursor = {
        skip: (n: number) => (calls.push(`skip ${n}`), (skip = n), cursor),
        limit: (n: number) => (calls.push(`limit ${n}`), (limit = n), cursor),
        toArray: async () => docs.slice(skip, limit === 0 ? undefined : skip + limit),
      };
      return cursor;
    });
    const connection = { database: 'app', client: { db: () => ({ collection: () => ({ find }) }) } };
    return { connection, calls, find };
  }

  const docs = Array.from({ length: 5 }, (_, i) => ({ n: i }));

  it('skips by OFFSET, as the editor pages it', async () => {
    const { connection, calls } = fakeConnection(docs);
    const rows = await mongoDbAdapter.query(connection, 'SELECT * FROM items LIMIT 2 OFFSET 3', []);
    expect(rows).toEqual([{ n: 3 }, { n: 4 }]);
    expect(calls).toEqual(['skip 3', 'limit 2']);
  });

  it('reads nothing for an empty page — limit(0) would read the whole collection', async () => {
    const { connection, find } = fakeConnection(docs);
    expect(await mongoDbAdapter.query(connection, 'SELECT * FROM items LIMIT 0 OFFSET 200', [])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
