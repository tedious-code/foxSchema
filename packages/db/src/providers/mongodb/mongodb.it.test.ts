import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mongoDbAdapter } from './mongodb.adapter.js';

/**
 * Runs against a real mongod. Skipped unless FOX_MONGO_URL is set:
 *
 *   FOX_MONGO_URL=mongodb://127.0.0.1:27017 npx vitest run packages/db/src/providers/mongodb
 *
 * mongodb-memory-server downloads a genuine mongod binary, so this exercises
 * the real wire protocol rather than a stub. That matters: the failures worth
 * catching here are ones where the translated MQL is accepted by the server
 * and does the wrong thing.
 */
const URL = process.env.FOX_MONGO_URL;
const maybe = URL ? describe : describe.skip;

maybe('mongodb adapter against a live server', () => {
  let conn: any;
  const table = `foxit${Date.now()}`;

  beforeAll(async () => {
    conn = await mongoDbAdapter.acquire(URL!, { database: 'foxtest' } as any, false);
  });

  afterAll(async () => {
    try {
      await conn.client.db(conn.database).collection(table).drop();
    } catch {
      /* collection may not exist */
    }
    await mongoDbAdapter.closeAll();
  });

  const q = (sql: string, params: unknown[] = []) => mongoDbAdapter.query(conn, sql, params);
  const raw = () => conn.client.db(conn.database).collection(table);

  it('INSERT writes a document', async () => {
    const res = await q(`INSERT INTO ${table} (id, name, email) VALUES (?, ?, ?)`, [
      1,
      'alice',
      'a@example.com',
    ]);
    expect(res[0]).toMatchObject({ rowCount: 1 });
    expect(await raw().countDocuments({ id: 1 })).toBe(1);
  });

  it('SELECT by key reads it back, with _id as text', async () => {
    const rows = (await q(`SELECT * FROM ${table} WHERE id = ?`, [1])) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, name: 'alice', email: 'a@example.com' });
    // An ObjectId would render as [object Object] in the grid and break diffing.
    expect(typeof rows[0]._id).toBe('string');
  });

  it('SELECT projects a named column list', async () => {
    const rows = (await q(`SELECT "name" FROM ${table} WHERE id = ?`, [1])) as any[];
    expect(rows[0]).toHaveProperty('name', 'alice');
    expect(rows[0]).not.toHaveProperty('email');
    // Mongo adds _id unless told not to; the SELECT did not name it.
    expect(rows[0]).not.toHaveProperty('_id');
  });

  it('UPDATE and DELETE find a document by the _id a SELECT showed', async () => {
    await raw().insertOne({ id: 50, name: 'by-id' });
    const [row] = (await q(`SELECT _id FROM ${table} WHERE id = ?`, [50])) as any[];
    const update = await q(`UPDATE ${table} SET name = ? WHERE _id = ?`, ['renamed', row._id]);
    expect(update[0]).toMatchObject({ rowCount: 1 });
    expect(await raw().findOne({ id: 50 })).toMatchObject({ name: 'renamed' });
    const del = await q(`DELETE FROM ${table} WHERE _id = '${row._id}'`);
    expect(del[0]).toMatchObject({ rowCount: 1 });
    expect(await raw().countDocuments({ id: 50 })).toBe(0);
  });

  it('UPDATE sets only the named fields on the matched document', async () => {
    const res = await q(`UPDATE ${table} SET name = ? WHERE id = ?`, ['alice2', 1]);
    expect(res[0]).toMatchObject({ rowCount: 1 });
    const doc = await raw().findOne({ id: 1 });
    expect(doc).toMatchObject({ name: 'alice2', email: 'a@example.com' });
  });

  it('UPDATE that matches nothing reports zero', async () => {
    const res = await q(`UPDATE ${table} SET name = ? WHERE id = ?`, ['ghost', 9999]);
    expect(res[0]).toMatchObject({ rowCount: 0 });
  });

  it('composite key predicates AND together', async () => {
    await q(`INSERT INTO ${table} (id, tenant, name) VALUES (?, ?, ?)`, [2, 'acme', 'bob']);
    await q(`INSERT INTO ${table} (id, tenant, name) VALUES (?, ?, ?)`, [2, 'other', 'carol']);
    const rows = await q(`SELECT * FROM ${table} WHERE id = ? AND tenant = ?`, [2, 'acme']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'bob' });
  });

  it('LIMIT bounds the result', async () => {
    const rows = await q(`SELECT * FROM ${table} LIMIT 2`);
    expect(rows).toHaveLength(2);
  });

  it('DELETE removes only the matched document', async () => {
    const before = await raw().countDocuments({});
    const res = await q(`DELETE FROM ${table} WHERE id = ? AND tenant = ?`, [2, 'other']);
    expect(res[0]).toMatchObject({ rowCount: 1 });
    expect(await raw().countDocuments({})).toBe(before - 1);
  });

  it('refuses a DELETE with no WHERE instead of emptying the collection', async () => {
    const before = await raw().countDocuments({});
    expect(before).toBeGreaterThan(0);
    await expect(q(`DELETE FROM ${table}`)).rejects.toThrow();
    expect(await raw().countDocuments({})).toBe(before);
  });

  it('refuses a range predicate rather than dropping it', async () => {
    // Dropped, this would delete every document.
    const before = await raw().countDocuments({});
    await expect(q(`DELETE FROM ${table} WHERE id > 0`)).rejects.toThrow();
    expect(await raw().countDocuments({})).toBe(before);
  });

  it('refuses OR, IN and LIKE', async () => {
    await expect(q(`SELECT * FROM ${table} WHERE id = 1 OR id = 2`)).rejects.toThrow();
    await expect(q(`SELECT * FROM ${table} WHERE id IN (1, 2)`)).rejects.toThrow();
    await expect(q(`SELECT * FROM ${table} WHERE name LIKE 'a%'`)).rejects.toThrow();
  });

  it('binds a value containing quotes and a semicolon', async () => {
    const nasty = "O'Brien; DROP TABLE users--";
    await q(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [42, nasty]);
    const rows = await q(`SELECT * FROM ${table} WHERE id = ?`, [42]);
    expect(rows[0]).toMatchObject({ name: nasty });
  });

  it('addresses a nested field with dotted notation', async () => {
    await raw().insertOne({ id: 77, profile: { city: 'Oslo' } });
    const rows = await q(`SELECT * FROM ${table} WHERE profile.city = ?`, ['Oslo']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 77 });
  });
});
