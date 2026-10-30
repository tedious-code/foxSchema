/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { pageSubsetSelect } from '@foxschema/sql';
import { redisAdapter, redisRowMatchesPredicates } from './redis.adapter.js';
import { RedisClientDouble } from './redis.client-double.js';
import { MAX_SCAN } from './redis.keyspace.js';

describe('redisRowMatchesPredicates', () => {
  it('matches when every non-id predicate holds', () => {
    const row = { id: '1', name: 'alice', status: 'active' };
    expect(
      redisRowMatchesPredicates(
        row,
        [
          { column: 'name', value: { kind: 'param', index: 0 } },
          { column: 'status', value: { kind: 'literal', value: 'active' } },
        ],
        ['alice']
      )
    ).toBe(true);
  });

  it('fails closed when a predicate does not match', () => {
    const row = { id: '1', name: 'alice', status: 'inactive' };
    expect(
      redisRowMatchesPredicates(
        row,
        [{ column: 'status', value: { kind: 'literal', value: 'active' } }],
        []
      )
    ).toBe(false);
  });

  it('does not treat null as matching a missing field', () => {
    const row = { id: '1', name: 'alice' };
    expect(
      redisRowMatchesPredicates(
        row,
        [{ column: 'status', value: { kind: 'literal', value: null } }],
        []
      )
    ).toBe(false);
  });
});

describe('redis adapter · every key type through the SQL subset', () => {
  const setup = () => {
    const c = new RedisClientDouble()
      .set('users:1', { type: 'hash', value: { name: 'Ana', plan: 'free' } })
      .set('users:2', { type: 'hash', value: { name: 'Bo', plan: 'pro' } })
      .set('users:3', { type: 'hash', value: { name: 'Cy', plan: 'pro' } })
      .set('docs:a', { type: 'string', value: '{"title":"Hello"}' })
      .set('queue:jobs', { type: 'list', value: ['{"job":"send"}', '{"job":"bill"}', '{"job":"ping"}'] })
      .set('board', {
        type: 'zset',
        value: [
          { value: 'al', score: 10 },
          { value: 'bo', score: 20 },
        ],
      });
    const q = (sql: string, params: unknown[] = []) => redisAdapter.query(c as never, sql, params) as Promise<Record<string, unknown>[]>;
    return { c, q };
  };

  it('reads a list key as a table of its elements', async () => {
    const { q } = setup();
    expect(await q('SELECT * FROM "queue:jobs"')).toEqual([
      { index: 0, job: 'send' },
      { index: 1, job: 'bill' },
      { index: 2, job: 'ping' },
    ]);
  });

  it('pages and projects a collection table', async () => {
    const { q } = setup();
    expect(await q('SELECT member, score FROM board LIMIT 1 OFFSET 1')).toEqual([{ member: 'bo', score: 20 }]);
    expect(await q(`SELECT job FROM "queue:jobs" WHERE job = 'bill'`)).toEqual([{ job: 'bill' }]);
  });

  it('pages a prefix table with OFFSET and keeps only the selected columns', async () => {
    const { q } = setup();
    const names = (await q('SELECT id, name FROM users LIMIT 2 OFFSET 1')).map((r) => r.name);
    expect(names).toHaveLength(2);
    const all = (await q('SELECT id, name FROM users')).map((r) => r.name).sort();
    expect(all).toEqual(['Ana', 'Bo', 'Cy']);
    expect(Object.keys((await q('SELECT id, name FROM users LIMIT 1'))[0]!)).toEqual(['id', 'name']);
  });

  it('runs the page the editor now sends, instead of refusing it', async () => {
    const { q } = setup();
    // What the editor's page wrap used to send — a nested SELECT — is refused.
    await expect(q('SELECT * FROM (SELECT * FROM users) AS fox_page LIMIT 201 OFFSET 0')).rejects.toThrow(/Unsupported clause/);
    expect(await q(pageSubsetSelect('SELECT * FROM "queue:jobs"', 0, 201))).toHaveLength(3);
    expect(await q(pageSubsetSelect('SELECT * FROM "queue:jobs"', 2, 201))).toEqual([{ index: 2, job: 'ping' }]);
    // A reader's own LIMIT still bounds the pages.
    expect(await q(pageSubsetSelect('SELECT * FROM users LIMIT 2', 2, 201))).toEqual([]);
  });

  it('reads nothing, and asks the server nothing, for an empty page', async () => {
    const { c, q } = setup();
    expect(await q('SELECT * FROM users LIMIT 0')).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it('reads a JSON document as fields, and refuses to update it field by field', async () => {
    const { q } = setup();
    expect(await q(`SELECT * FROM docs WHERE id = 'a'`)).toEqual([{ id: 'a', title: 'Hello' }]);
    await expect(q(`UPDATE docs SET title = 'x' WHERE id = 'a'`)).rejects.toThrow(/only hash keys are updated/);
  });

  it('refuses writes to a collection table, and still writes hashes', async () => {
    const { q, c } = setup();
    for (const sql of [
      `INSERT INTO "queue:jobs" (id, job) VALUES ('9', 'x')`,
      `UPDATE "queue:jobs" SET job = 'x' WHERE id = '0'`,
      `DELETE FROM "queue:jobs" WHERE id = '0'`,
    ]) {
      await expect(q(sql), sql).rejects.toThrow(/is a list; its elements are read-only/);
    }
    expect(c.keys.get('queue:jobs')).toMatchObject({ type: 'list' });
    expect(await q(`UPDATE users SET plan = 'pro' WHERE id = '1'`)).toEqual([{ rowCount: 1, key: 'users:1' }]);
  });

  it('an UPDATE asks for the table’s type and the key’s once each', async () => {
    const { q, c } = setup();
    await q(`UPDATE users SET plan = 'pro' WHERE id = '2'`);
    expect(c.calls.filter((x) => x === 'TYPE').length).toBe(2);
  });

  it('refuses to delete every non-hash key exposed as a prefix-table row', async () => {
    const c = new RedisClientDouble({ json: true })
      .set('users:list', { type: 'list', value: ['send', 'bill'] })
      .set('users:set', { type: 'set', value: ['admin'] })
      .set('users:zset', { type: 'zset', value: [{ value: 'Ana', score: 1 }] })
      .set('users:stream', { type: 'stream', value: [{ id: '1-0', message: { event: 'joined' } }] })
      .set('users:string', { type: 'string', value: 'plain' })
      .set('users:json', { type: 'ReJSON-RL', value: '{"name":"Ana"}' });
    const q = (sql: string) =>
      redisAdapter.query(c as never, sql, []) as Promise<Record<string, unknown>[]>;

    const ids = (await q('SELECT id FROM users')).map((row) => row.id).sort();
    expect(ids).toEqual(['json', 'list', 'set', 'stream', 'string', 'zset']);
    for (const id of ids) {
      await expect(q(`DELETE FROM users WHERE id = '${id}'`), String(id)).rejects.toThrow(
        /only hash keys are deleted through prefix tables/
      );
      expect(c.keys.has(`users:${id}`), String(id)).toBe(true);
    }
    expect(c.calls).not.toContain('DEL');
  });

  it('fails closed when a filtered page reaches MAX_SCAN before finding enough rows', async () => {
    const probeLimit = 201;
    const c = new RedisClientDouble().set('big', {
      type: 'list',
      value: Array.from({ length: MAX_SCAN + 5_000 }, (_, index) => `value-${index}`),
    });
    const q = (sql: string) =>
      redisAdapter.query(c as never, sql, []) as Promise<Record<string, unknown>[]>;

    await expect(q(`SELECT * FROM big WHERE value = 'never-matches' LIMIT ${probeLimit}`)).rejects.toThrow(
      /scan reached the 50,000-row limit/
    );
    expect(c.calls.filter((call) => call === 'LRANGE')).toHaveLength(MAX_SCAN / 500 + 1);
  });

  it('pages a prefix scan with a filter, skipping matches for the offset', async () => {
    const { q } = setup();
    expect(await q(`SELECT id FROM users WHERE plan = 'pro' LIMIT 1 OFFSET 1`)).toEqual([{ id: '3' }]);
  });
});
