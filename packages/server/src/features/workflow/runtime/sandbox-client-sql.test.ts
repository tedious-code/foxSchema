/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The parent's half of delegated SQL: the sandbox child opens SQLite sessions
 * here over reverse RPC, one call per open / statement / BEGIN / COMMIT.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkflowSandboxClient } from './sandbox-client.js';

type Reply = { ok: boolean; result?: unknown; error?: { message?: string } };

/** Calls the client's reverse-RPC handler the way a child message would. */
function harness() {
  const client = new WorkflowSandboxClient({
    encryptionKey: '00'.repeat(32),
    resolveFoxSchemaConnection: async () => undefined,
    loadRuntimeConfig: async () => ({}) as never,
  });
  const replies = new Map<string, Reply>();
  const internals = client as unknown as {
    sendToChild: (msg: { id: string } & Reply) => void;
    handleReverseRpc: (id: string, method: string, params: unknown) => Promise<void>;
  };
  internals.sendToChild = (msg) => void replies.set(msg.id, msg);
  let next = 0;
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const id = `rpc-${next++}`;
    await internals.handleReverseRpc(id, method, params);
    const reply = replies.get(id)!;
    if (!reply.ok) throw new Error(reply.error?.message ?? 'rpc failed');
    return reply.result as T;
  };
  return { call };
}

describe('delegated SQLite sessions on one file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-sandbox-sql-'));
  const file = join(dir, 'target.db');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const Database = createRequire(import.meta.url)('better-sqlite3');
  const setup = new Database(file);
  setup.exec('CREATE TABLE staged (id INTEGER PRIMARY KEY, source TEXT)');
  setup.close();

  it('queues a second transaction until the first commits instead of nesting it', async () => {
    // What two batches reaching one SQLite write pipe at once send. The adapter
    // hands both "dedicated" sessions the same cached handle, so the second
    // BEGIN used to fail with "cannot start a transaction within a transaction".
    const { call } = harness();
    const open = { dialect: 'sqlite', option: { database: file }, dedicated: true };
    const a = (await call<{ sessionId: string }>('sqlOpen', open)).sessionId;
    const b = (await call<{ sessionId: string }>('sqlOpen', open)).sessionId;
    const insert = (sessionId: string, id: number, source: string) =>
      call('sqlQuery', { sessionId, sql: 'INSERT INTO staged (id, source) VALUES (?, ?)', params: [id, source] });

    await call('sqlTx', { sessionId: a, action: 'begin' });
    let bBegan = false;
    const bBegin = call('sqlTx', { sessionId: b, action: 'begin' }).then(() => {
      bBegan = true;
    });
    let bRead = false;
    const bQuery = call<Array<{ n: number }>>('sqlQuery', {
      sessionId: b,
      sql: 'SELECT count(*) AS n FROM staged',
      params: [],
    }).then((rows) => {
      bRead = true;
      return rows;
    });

    await insert(a, 1, 'a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(bBegan).toBe(false);
    expect(bRead).toBe(false);

    await call('sqlTx', { sessionId: a, action: 'rollback' });
    await bBegin;
    // B's statement waited out A's transaction, so it never saw A's rolled-back row.
    expect(await bQuery).toEqual([{ n: 0 }]);
    await insert(b, 2, 'b');
    await call('sqlTx', { sessionId: b, action: 'commit' });
    await call('sqlClose', { sessionId: a });
    await call('sqlClose', { sessionId: b });

    const check = new Database(file, { readonly: true });
    expect(check.prepare('SELECT id, source FROM staged').all()).toEqual([{ id: 2, source: 'b' }]);
    check.close();
  });

  it('rolls back and frees the handle when a session closes mid-transaction', async () => {
    const { call } = harness();
    const open = { dialect: 'sqlite', option: { database: file }, dedicated: true };
    const a = (await call<{ sessionId: string }>('sqlOpen', open)).sessionId;
    const b = (await call<{ sessionId: string }>('sqlOpen', open)).sessionId;

    await call('sqlTx', { sessionId: a, action: 'begin' });
    await call('sqlQuery', { sessionId: a, sql: 'INSERT INTO staged (id, source) VALUES (?, ?)', params: [9, 'lost'] });
    // The child crashed or went idle between BEGIN and COMMIT.
    await call('sqlClose', { sessionId: a });

    await call('sqlTx', { sessionId: b, action: 'begin' });
    const rows = await call('sqlQuery', { sessionId: b, sql: 'SELECT id FROM staged WHERE id = 9', params: [] });
    await call('sqlTx', { sessionId: b, action: 'commit' });
    await call('sqlClose', { sessionId: b });
    expect(rows).toEqual([]);
  });
});
