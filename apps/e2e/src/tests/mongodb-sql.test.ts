/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL against MongoDB, through the endpoint the SQL editor runs every
 * statement with (`POST /api/sql/execute`).
 *
 * MongoDB speaks no SQL, so Fox translates a small subset (sql-subset.ts) and
 * refuses everything else. These tests check both halves against the real
 * server: what the subset does is what MongoDB then holds, read back with
 * mongosh rather than through the app; and what it refuses leaves the
 * collection exactly as it was.
 *
 * Requires the API and the dev MongoDB container (`foxschema-mongodb`, auth
 * on), plus the optional `mongodb` driver installed where the API runs.
 * redis-editor.test.ts covers the same ground for Redis, through the editor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCall } from '../helpers/accounts.js';
import { sessionCookie } from '../helpers/app-session.js';
import { MONGO_PASS, MONGO_USER, mongoDocs, mongoEval, mongoReachable } from '../helpers/mongo.js';

const DB = 'fox_e2e_sql';
const C = `people_${Date.now().toString(36)}`;

type Result = { ok: true; columns: string[]; rows: unknown[][]; rowCount: number } | { ok: false; error: string };

describe.skipIf(!mongoReachable())('SQL Editor · MongoDB', () => {
  let cookie = '';
  let connectionId = '';

  async function run(sql: string): Promise<Result> {
    const res = await apiCall('POST', '/sql/execute', { connectionId, statements: [sql] }, cookie);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.results[0] as Result;
  }

  /** A successful result's rows as objects. */
  function rowsOf(result: Result): Record<string, unknown>[] {
    if (!result.ok) throw new Error(result.error);
    return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
  }

  const people = () =>
    mongoDocs(DB, C)
      .map(({ name, plan, n }) => ({ name, plan, n }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  beforeAll(async () => {
    cookie = await sessionCookie();
    mongoEval(
      DB,
      `db.getCollection(${JSON.stringify(C)}).insertMany([
        { name: 'ana', plan: 'pro', n: 1 },
        { name: 'bo', plan: 'free', n: 2 },
        { name: 'cy', plan: 'pro', n: 3 },
      ])`
    );
    const saved = await apiCall(
      'POST',
      '/connections',
      {
        name: `E2E Mongo SQL ${C}`,
        dialect: 'mongodb',
        option: { host: '127.0.0.1', port: 27017, username: MONGO_USER, password: MONGO_PASS, database: DB },
        savePassword: true,
      },
      cookie
    );
    expect(saved.status, JSON.stringify(saved.json)).toBeLessThan(300);
    connectionId = saved.json.connection.id;
  }, 60_000);

  afterAll(async () => {
    if (connectionId) await apiCall('DELETE', `/connections/${connectionId}`, undefined, cookie);
    mongoEval(DB, `db.getCollection(${JSON.stringify(C)}).drop()`);
  });

  it('selects with WHERE on several fields, LIMIT and OFFSET', async () => {
    expect(rowsOf(await run(`SELECT name, plan FROM ${C} WHERE plan = 'pro' AND n = 3`))).toEqual([
      { name: 'cy', plan: 'pro' },
    ]);
    const names = rowsOf(await run(`SELECT name FROM ${C} WHERE plan = 'pro'`)).map((r) => r.name);
    expect(names.sort()).toEqual(['ana', 'cy']);
    expect(rowsOf(await run(`SELECT name FROM ${C} LIMIT 1 OFFSET 1`))).toHaveLength(1);
    expect(rowsOf(await run(`SELECT name FROM ${C} LIMIT 0`))).toEqual([]);
  });

  it('inserts a document with the types written', async () => {
    expect((await run(`INSERT INTO ${C} (name, plan, n) VALUES ('dee', 'free', 4)`)).ok).toBe(true);
    expect(people()).toContainEqual({ name: 'dee', plan: 'free', n: 4 });
  });

  it('updates only when every WHERE predicate holds', async () => {
    await run(`UPDATE ${C} SET plan = 'gold' WHERE name = 'bo' AND plan = 'pro'`);
    expect(people().find((p) => p.name === 'bo')?.plan).toBe('free');
    await run(`UPDATE ${C} SET plan = 'gold' WHERE name = 'bo' AND plan = 'free'`);
    expect(people().find((p) => p.name === 'bo')?.plan).toBe('gold');
  });

  it('deletes only the matching document', async () => {
    await run(`DELETE FROM ${C} WHERE name = 'dee'`);
    expect(people().map((p) => p.name)).toEqual(['ana', 'bo', 'cy']);
  });

  it('addresses a document by the _id a SELECT showed', async () => {
    const [ana] = rowsOf(await run(`SELECT _id, name FROM ${C} WHERE name = 'ana'`));
    expect(typeof ana?._id).toBe('string');
    await run(`UPDATE ${C} SET plan = 'gold' WHERE _id = '${ana!._id}'`);
    expect(people().find((p) => p.name === 'ana')?.plan).toBe('gold');
  });

  it.each([
    ['a DELETE with no WHERE', `DELETE FROM ${C}`],
    ['an UPDATE with no WHERE', `UPDATE ${C} SET plan = 'x'`],
    ['a range', `DELETE FROM ${C} WHERE n > 1`],
    ['an OR', `DELETE FROM ${C} WHERE name = 'ana' OR name = 'bo'`],
    ['a join', `SELECT * FROM ${C} JOIN other ON ${C}.name = other.name`],
    ['a subquery', `DELETE FROM ${C} WHERE name = (SELECT name FROM other)`],
    ['a function', `UPDATE ${C} SET plan = UPPER(plan) WHERE name = 'ana'`],
  ])('refuses %s and leaves the collection alone', async (_label, sql) => {
    const before = mongoDocs(DB, C);
    const result = await run(sql);
    expect(result.ok, `ran: ${sql}`).toBe(false);
    expect(mongoDocs(DB, C)).toEqual(before);
  });
});
