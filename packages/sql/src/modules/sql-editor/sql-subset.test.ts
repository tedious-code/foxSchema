import { describe, expect, it } from 'vitest';
import { isSubsetDialect, pageSubsetSelect, parseSqlSubset, subsetValue, type SubsetIntent } from './sql-subset.js';

const ok = (sql: string): SubsetIntent => {
  const r = parseSqlSubset(sql);
  if (!r.ok) throw new Error(`expected parse, got: ${r.error}`);
  return r.intent;
};
const err = (sql: string): string => {
  const r = parseSqlSubset(sql);
  if (r.ok) throw new Error(`expected refusal, got ${JSON.stringify(r.intent)}`);
  return r.error;
};

describe('accepts exactly the shapes the app emits', () => {
  it('INSERT with each placeholder style', () => {
    for (const [sql, style] of [
      ['INSERT INTO "users" ("id", "name") VALUES ($1, $2)', 'dollar'],
      ['INSERT INTO `users` (`id`, `name`) VALUES (?, ?)', 'question'],
      ['INSERT INTO "users" ("id", "name") VALUES (:1, :2)', 'colon'],
    ] as const) {
      const intent = ok(sql);
      expect(intent.kind, style).toBe('insert');
      if (intent.kind === 'insert') {
        expect(intent.table, style).toBe('users');
        expect(intent.assignments.map((a) => a.column), style).toEqual(['id', 'name']);
        expect(intent.assignments.map((a) => subsetValue(a.value, ['A', 'B'])), style).toEqual([
          'A',
          'B',
        ]);
      }
    }
  });

  it('UPDATE with a composite key', () => {
    const intent = ok('UPDATE "t" SET "a" = ?, "b" = ? WHERE "k1" = ? AND "k2" = ?');
    expect(intent.kind).toBe('update');
    if (intent.kind === 'update') {
      expect(intent.set.map((s) => s.column)).toEqual(['a', 'b']);
      expect(intent.where.map((w) => w.column)).toEqual(['k1', 'k2']);
      // Params are positional across SET then WHERE — order must survive.
      expect(intent.set.map((s) => subsetValue(s.value, [1, 2, 3, 4]))).toEqual([1, 2]);
      expect(intent.where.map((w) => subsetValue(w.value, [1, 2, 3, 4]))).toEqual([3, 4]);
    }
  });

  it('DELETE with a composite key', () => {
    const intent = ok('DELETE FROM [dbo].[t] WHERE [k1] = ? AND [k2] = ?');
    expect(intent.kind).toBe('delete');
    if (intent.kind === 'delete') {
      expect(intent.table).toBe('t'); // schema dropped — one namespace
      expect(intent.where).toHaveLength(2);
    }
  });

  it('SELECT with and without predicates and limit', () => {
    expect(ok('SELECT * FROM users')).toMatchObject({ kind: 'select', columns: '*', where: [] });
    expect(ok('SELECT "a", "b" FROM t LIMIT 10')).toMatchObject({
      columns: ['a', 'b'],
      limit: 10,
    });
    expect(ok('SELECT * FROM t WHERE "k" = ? LIMIT 5')).toMatchObject({
      limit: 5,
      where: [{ column: 'k' }],
    });
  });

  it('reads literals as well as placeholders', () => {
    const intent = ok("SELECT * FROM t WHERE a = 1 AND b = 'x' AND d = TRUE");
    if (intent.kind !== 'select') throw new Error('shape');
    expect(intent.where.map((w) => subsetValue(w.value, []))).toEqual([1, 'x', true]);
  });

  it('allows NULL as an INSERT / SET value', () => {
    expect(ok("INSERT INTO t (a, b) VALUES (1, NULL)").kind).toBe('insert');
    const intent = ok("UPDATE t SET a = NULL WHERE k = 1");
    expect(intent.kind).toBe('update');
  });

  it("unescapes '' inside a literal", () => {
    const intent = ok("DELETE FROM t WHERE name = 'O''Brien'");
    if (intent.kind !== 'delete') throw new Error('shape');
    expect(subsetValue(intent.where[0]!.value, [])).toBe("O'Brien");
  });
});

describe('refuses everything it cannot represent exactly', () => {
  // This is the whole safety argument: a translator that accepts these and
  // drops what it does not understand deletes or overwrites the wrong rows.
  const mustRefuse: Array<[string, string]> = [
    ['range predicate', 'DELETE FROM t WHERE age > 65'],
    ['range predicate >=', 'DELETE FROM t WHERE age >= 65'],
    ['not equal', 'DELETE FROM t WHERE age != 65'],
    ['not equal <>', 'DELETE FROM t WHERE age <> 65'],
    ['OR', 'DELETE FROM t WHERE a = 1 OR b = 2'],
    ['IN list', 'DELETE FROM t WHERE id IN (1, 2)'],
    ['LIKE', "SELECT * FROM t WHERE name LIKE 'a%'"],
    ['IS NULL', 'DELETE FROM t WHERE a IS NULL'],
    // `= NULL` is not SQL equality, and MongoDB `{a: null}` matches missing fields.
    ['equality to NULL', 'DELETE FROM t WHERE a = NULL'],
    ['equality to NULL in SELECT', 'SELECT * FROM t WHERE a = NULL'],
    ['equality to NULL in UPDATE WHERE', 'UPDATE t SET b = 1 WHERE a = NULL'],
    ['BETWEEN', 'DELETE FROM t WHERE a BETWEEN 1 AND 5'],
    ['function call', 'SELECT * FROM t WHERE lower(a) = ?'],
    ['expression value', 'UPDATE t SET a = a + 1 WHERE k = ?'],
    ['subquery', 'DELETE FROM t WHERE id = (SELECT id FROM u)'],
    ['join', 'SELECT * FROM a JOIN b ON a.id = b.id'],
    ['UPDATE without WHERE', 'UPDATE t SET a = 1'],
    ['DELETE without WHERE', 'DELETE FROM t'],
    ['TRUNCATE', 'TRUNCATE TABLE t'],
    ['DDL', 'DROP TABLE t'],
    ['batch', 'DELETE FROM t WHERE k = 1; DELETE FROM u WHERE k = 2'],
    ['order by', 'SELECT * FROM t ORDER BY a'],
    ['group by', 'SELECT count(*) FROM t GROUP BY a'],
  ];

  for (const [label, sql] of mustRefuse) {
    it(`refuses ${label}`, () => {
      const message = err(sql);
      expect(message.length).toBeGreaterThan(10); // must explain, not just fail
    });
  }

  it('refuses an unbalanced statement rather than guessing', () => {
    expect(err("SELECT * FROM t WHERE a = 'unterminated")).toBeTruthy();
    expect(err('SELECT * FROM t WHERE (a = 1')).toBeTruthy();
  });

  it('does not mistake >= for = by reading only the last character', () => {
    // The subtle one: splitting on '=' finds the '=' inside '>=', so the guard
    // has to look at what precedes it.
    const r = parseSqlSubset('DELETE FROM t WHERE a >= 5');
    expect(r.ok).toBe(false);
  });
});

describe('parameter indexing', () => {
  it('numbers ? placeholders left to right across SET then WHERE', () => {
    const intent = ok('UPDATE t SET a = ?, b = ? WHERE k = ?');
    if (intent.kind !== 'update') throw new Error('shape');
    const params = ['sa', 'sb', 'wk'];
    expect(intent.set.map((s) => subsetValue(s.value, params))).toEqual(['sa', 'sb']);
    expect(intent.where.map((w) => subsetValue(w.value, params))).toEqual(['wk']);
  });

  it('honours explicit $n ordering rather than position', () => {
    const intent = ok('UPDATE t SET a = $2 WHERE k = $1');
    if (intent.kind !== 'update') throw new Error('shape');
    expect(subsetValue(intent.set[0]!.value, ['first', 'second'])).toBe('second');
    expect(subsetValue(intent.where[0]!.value, ['first', 'second'])).toBe('first');
  });

  it('yields null for a parameter that was not supplied', () => {
    const intent = ok('DELETE FROM t WHERE k = ?');
    if (intent.kind !== 'delete') throw new Error('shape');
    expect(subsetValue(intent.where[0]!.value, [])).toBeNull();
  });
});

describe('table names and paging', () => {
  it('keeps a quoted dotted name whole — a Redis key is often dotted', () => {
    expect(ok('SELECT * FROM "cache.v1:users"')).toMatchObject({ table: 'cache.v1:users' });
    expect(ok('SELECT * FROM `cache.v1`')).toMatchObject({ table: 'cache.v1' });
    expect(ok('SELECT * FROM [cache.v1]')).toMatchObject({ table: 'cache.v1' });
    // Unquoted, a dot still separates schema from table.
    expect(ok('SELECT * FROM app.users')).toMatchObject({ table: 'users' });
    expect(ok('SELECT * FROM "0"."queue:jobs"')).toMatchObject({ table: 'queue:jobs' });
  });

  it('reads LIMIT with an OFFSET on a SELECT', () => {
    expect(ok('SELECT * FROM t LIMIT 10 OFFSET 30')).toMatchObject({ limit: 10, offset: 30 });
    expect(ok("SELECT * FROM t WHERE a = 'x' LIMIT 5 OFFSET 0")).toMatchObject({ limit: 5, offset: 0 });
    expect(ok('SELECT * FROM t LIMIT 5')).not.toHaveProperty('offset');
  });

  it('pages a SELECT by writing LIMIT and OFFSET onto it, not by nesting it', () => {
    expect(pageSubsetSelect('SELECT * FROM t;', 0, 201)).toBe('SELECT * FROM t LIMIT 201 OFFSET 0');
    expect(pageSubsetSelect("SELECT a FROM t WHERE a = 'x'", 400, 201)).toBe(
      "SELECT a FROM t WHERE a = 'x' LIMIT 201 OFFSET 400"
    );
    // The page it writes is one this parser reads back.
    expect(ok(pageSubsetSelect('SELECT * FROM "queue:jobs"', 200, 201))).toMatchObject({
      table: 'queue:jobs',
      limit: 201,
      offset: 200,
    });
  });

  it('keeps the reader’s own LIMIT and OFFSET as the bound', () => {
    expect(pageSubsetSelect('SELECT * FROM t LIMIT 5', 0, 201)).toBe('SELECT * FROM t LIMIT 5 OFFSET 0');
    expect(pageSubsetSelect('SELECT * FROM t LIMIT 5', 200, 201)).toBe('SELECT * FROM t LIMIT 0 OFFSET 200');
    expect(pageSubsetSelect('SELECT * FROM t LIMIT 300 OFFSET 10', 200, 201)).toBe(
      'SELECT * FROM t LIMIT 100 OFFSET 210'
    );
  });

  it('knows which stores read through it', () => {
    expect(isSubsetDialect('redis')).toBe(true);
    expect(isSubsetDialect('MongoDB')).toBe(true);
    expect(isSubsetDialect('postgres')).toBe(false);
    expect(isSubsetDialect('')).toBe(false);
  });
});

describe('values and columns it must not misread', () => {
  it('refuses an OR hidden behind a string that starts and ends with a quote', () => {
    // `'1' OR id = '2'` used to read as one string, so the query matched nothing.
    for (const sql of [
      "SELECT * FROM t WHERE id = '1' OR id = '2'",
      "DELETE FROM t WHERE id = '1' OR id = '2'",
      "UPDATE t SET a = 'x' WHERE id = '1' OR '1' = '1'",
    ]) {
      expect(err(sql), sql).toMatch(/column = value/);
    }
  });

  it('still reads doubled quotes inside one string', () => {
    expect(ok("SELECT * FROM t WHERE name = 'it''s'")).toMatchObject({
      where: [{ column: 'name', value: { kind: 'literal', value: "it's" } }],
    });
    expect(ok("SELECT * FROM t WHERE name = ''''")).toMatchObject({
      where: [{ column: 'name', value: { kind: 'literal', value: "'" } }],
    });
  });

  it('refuses an expression in the column list instead of returning NULLs', () => {
    for (const sql of ['SELECT COUNT(*) FROM t', 'SELECT id, a + 1 FROM t', 'SELECT t.* FROM t']) {
      expect(err(sql), sql).toMatch(/plain column names/);
    }
  });

  it('takes a quoted column as written — a Redis field can be first-name', () => {
    expect(ok('SELECT "first-name", id FROM t')).toMatchObject({ columns: ['first-name', 'id'] });
  });
});


describe('predicate groups', () => {
  const lit = (value: unknown) => ({ kind: 'literal', value });

  it('reads a parenthesised WHERE — Data peek wraps every filter in one', () => {
    expect(ok("SELECT * FROM users WHERE (plan = 'pro')")).toMatchObject({
      where: [{ column: 'plan', value: lit('pro') }],
    });
    // A drill's own key, then the reader's filter: `… WHERE id = ? AND (…)`.
    expect(ok("SELECT * FROM users WHERE id = ? AND (plan = 'pro' AND name = 'Bo')")).toMatchObject({
      where: [
        { column: 'id', value: { kind: 'param', index: 0 } },
        { column: 'plan', value: lit('pro') },
        { column: 'name', value: lit('Bo') },
      ],
    });
    expect(ok("DELETE FROM t WHERE ((a = 1)) AND (b = ')(')")).toMatchObject({
      where: [
        { column: 'a', value: lit(1) },
        { column: 'b', value: lit(')(') },
      ],
    });
  });

  it('still refuses OR, an empty group, or a group that is not the whole term', () => {
    for (const sql of [
      "SELECT * FROM t WHERE (a = 1 OR b = 2)",
      'SELECT * FROM t WHERE (a = 1) OR (b = 2)',
      'SELECT * FROM t WHERE ()',
      'SELECT * FROM t WHERE (a = 1) b = 2',
      'DELETE FROM t WHERE (a > 1)',
    ]) {
      expect(err(sql), sql).toMatch(/joined by AND/);
    }
  });

  it('does not unwrap a SET list — a group there is not SQL', () => {
    expect(err('UPDATE t SET (a = 1) WHERE id = 2')).toMatch(/assignments/);
  });
});
