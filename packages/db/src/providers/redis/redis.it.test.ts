import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisAdapter } from './redis.adapter.js';
import { sampleKeyspace } from './redis.keyspace.js';

/**
 * Runs against a real Redis. Skipped unless FOX_REDIS_URL is set, so the normal
 * suite stays hermetic:
 *
 *   redis-server --port 6390 --daemonize yes --save '' --appendonly no
 *   FOX_REDIS_URL=redis://127.0.0.1:6390 npx vitest run packages/db/src/providers/redis
 *
 * A mock would only prove the adapter calls the methods I expected it to. The
 * question worth answering is whether the translated commands do the right
 * thing to a real keyspace.
 */
const URL = process.env.FOX_REDIS_URL;
const maybe = URL ? describe : describe.skip;

maybe('redis adapter against a live server', () => {
  let conn: any;
  const table = `foxit${Date.now()}`;

  beforeAll(async () => {
    conn = await redisAdapter.acquire(URL!, { database: '0' } as any, false);
  });

  afterAll(async () => {
    // Leave the keyspace as we found it. node-redis yields a batch of keys per
    // step; `String(batch)` used to join them into one key that matched none.
    for await (const batch of conn.scanIterator({ MATCH: `${table}*`, COUNT: 100 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) await conn.del(String(key));
    }
    await redisAdapter.closeAll();
  });

  const q = (sql: string, params: unknown[] = []) => redisAdapter.query(conn, sql, params);

  it('INSERT writes a hash addressed by id', async () => {
    const res = await q(`INSERT INTO ${table} (id, name, email) VALUES (?, ?, ?)`, [
      '1',
      'alice',
      'a@example.com',
    ]);
    expect(res[0]).toMatchObject({ rowCount: 1 });
    expect(await conn.hGetAll(`${table}:1`)).toEqual({
      name: 'alice',
      email: 'a@example.com',
    });
  });

  it('SELECT by id reads the row back', async () => {
    const rows = await q(`SELECT * FROM ${table} WHERE id = ?`, ['1']);
    expect(rows).toEqual([{ id: '1', name: 'alice', email: 'a@example.com' }]);
  });

  it('UPDATE changes only the named fields', async () => {
    await q(`UPDATE ${table} SET name = ? WHERE id = ?`, ['alice2', '1']);
    const rows = await q(`SELECT * FROM ${table} WHERE id = ?`, ['1']);
    expect(rows[0]).toMatchObject({ name: 'alice2', email: 'a@example.com' });
  });

  it('UPDATE of a missing key reports zero rather than creating one', async () => {
    const res = await q(`UPDATE ${table} SET name = ? WHERE id = ?`, ['ghost', 'nope']);
    expect(res[0]).toMatchObject({ rowCount: 0 });
    expect(await conn.exists(`${table}:nope`)).toBe(0);
  });

  it('SELECT without id scans the prefix and honours LIMIT', async () => {
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['2', 'bob']);
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['3', 'carol']);
    const all = await q(`SELECT * FROM ${table}`);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const limited = await q(`SELECT * FROM ${table} LIMIT 2`);
    expect(limited).toHaveLength(2);
  });

  it('filters a non-id equality after the scan', async () => {
    const rows = await q(`SELECT * FROM ${table} WHERE name = ?`, ['bob']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '2', name: 'bob' });
  });

  it('DELETE removes exactly the addressed key', async () => {
    const res = await q(`DELETE FROM ${table} WHERE id = ?`, ['3']);
    expect(res[0]).toMatchObject({ rowCount: 1 });
    expect(await conn.exists(`${table}:3`)).toBe(0);
    expect(await conn.exists(`${table}:2`)).toBe(1);
  });

  it('honours non-id AND predicates on UPDATE and DELETE', async () => {
    // Regression: only `id` was used to address the key, so
    // `DELETE … WHERE id = 1 AND status = 'active'` removed inactive rows.
    await q(`INSERT INTO ${table} (id, name, status) VALUES (?, ?, ?)`, [
      'guard',
      'dana',
      'inactive',
    ]);
    const upd = await q(`UPDATE ${table} SET name = ? WHERE id = ? AND status = ?`, [
      'nope',
      'guard',
      'active',
    ]);
    expect(upd[0]).toMatchObject({ rowCount: 0 });
    expect(await conn.hGet(`${table}:guard`, 'name')).toBe('dana');

    const del = await q(`DELETE FROM ${table} WHERE id = ? AND status = ?`, ['guard', 'active']);
    expect(del[0]).toMatchObject({ rowCount: 0 });
    expect(await conn.exists(`${table}:guard`)).toBe(1);

    const delOk = await q(`DELETE FROM ${table} WHERE id = ? AND status = ?`, [
      'guard',
      'inactive',
    ]);
    expect(delOk[0]).toMatchObject({ rowCount: 1 });
    expect(await conn.exists(`${table}:guard`)).toBe(0);
  });

  it('applies non-id filters before LIMIT on a prefix scan', async () => {
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['lim-a', 'skip']);
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['lim-b', 'skip']);
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['lim-c', 'keep']);
    const rows = await q(`SELECT * FROM ${table} WHERE name = ? LIMIT 1`, ['keep']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'keep' });
  });

  it('refuses a DELETE with no WHERE instead of clearing the prefix', async () => {
    // The failure this whole design exists to prevent.
    await expect(q(`DELETE FROM ${table}`)).rejects.toThrow();
    expect(await conn.exists(`${table}:2`)).toBe(1);
  });

  it('refuses a range predicate rather than ignoring it', async () => {
    await expect(q(`DELETE FROM ${table} WHERE id > 0`)).rejects.toThrow();
    expect(await conn.exists(`${table}:2`)).toBe(1);
  });

  it('refuses a DELETE that does not address a key', async () => {
    await expect(q(`DELETE FROM ${table} WHERE name = ?`, ['bob'])).rejects.toThrow(/id/);
    expect(await conn.exists(`${table}:2`)).toBe(1);
  });

  it('reads a plain string key as a single value column', async () => {
    await conn.set(`${table}:plain`, 'hello');
    const rows = await q(`SELECT * FROM ${table} WHERE id = ?`, ['plain']);
    expect(rows[0]).toEqual({ id: 'plain', value: 'hello' });
  });

  it('round-trips a value containing quotes and semicolons', async () => {
    const nasty = "O'Brien; DROP TABLE users--";
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ['q', nasty]);
    const rows = await q(`SELECT * FROM ${table} WHERE id = ?`, ['q']);
    expect(rows[0]).toMatchObject({ name: nasty });
  });

  describe('every key type', () => {
    const list = `${table}-jobs`;
    const zset = `${table}-board`;
    const set = `${table}-tags`;
    const stream = `${table}-log`;

    beforeAll(async () => {
      await conn.set(`${table}:doc`, JSON.stringify({ title: 'Hello', meta: { v: 1 } }));
      await conn.rPush(list, [JSON.stringify({ job: 'send' }), JSON.stringify({ job: 'bill' }), 'plain']);
      await conn.zAdd(zset, [
        { score: 20, value: 'bo' },
        { score: 10, value: 'al' },
      ]);
      await conn.sAdd(set, ['x', 'y']);
      await conn.xAdd(stream, '*', { level: 'info', msg: 'up' });
    });

    it('reads a JSON document in a string as its fields', async () => {
      expect(await q(`SELECT * FROM ${table} WHERE id = 'doc'`)).toEqual([
        { id: 'doc', title: 'Hello', meta: '{"v":1}' },
      ]);
    });

    it('reads a list key as its elements, JSON fields expanded, paged', async () => {
      expect(await q(`SELECT * FROM "${list}"`)).toEqual([
        { index: 0, job: 'send' },
        { index: 1, job: 'bill' },
        { index: 2, value: 'plain' },
      ]);
      expect(await q(`SELECT * FROM "${list}" LIMIT 1 OFFSET 1`)).toEqual([{ index: 1, job: 'bill' }]);
    });

    it('reads a sorted set by score, a set’s members and a stream’s entries', async () => {
      expect(await q(`SELECT * FROM "${zset}"`)).toEqual([
        { member: 'al', score: 10 },
        { member: 'bo', score: 20 },
      ]);
      expect((await q(`SELECT member FROM "${set}"`)).map((r: any) => r.member).sort()).toEqual(['x', 'y']);
      expect(await q(`SELECT level, msg FROM "${stream}"`)).toEqual([{ level: 'info', msg: 'up' }]);
    });

    it('refuses writes to a collection key and leaves it unchanged', async () => {
      await expect(q(`INSERT INTO "${list}" (id, job) VALUES ('9', 'x')`)).rejects.toThrow(/read-only/);
      expect(await conn.lLen(list)).toBe(3);
    });

    it('lists each of them in the sampled keyspace with its store type', async () => {
      const { tables } = await sampleKeyspace(conn);
      const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
      expect(byName[list]).toMatchObject({ storeType: 'list', columns: ['index', 'value', 'job'] });
      expect(byName[zset]).toMatchObject({ storeType: 'zset' });
      expect(byName[set]).toMatchObject({ storeType: 'set' });
      expect(byName[stream]).toMatchObject({ storeType: 'stream', columns: ['entry_id', 'level', 'msg'] });
      expect(byName[table]?.columns).toEqual(expect.arrayContaining(['id', 'title', 'meta']));
    });
  });
});
